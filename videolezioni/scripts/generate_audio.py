#!/usr/bin/env python3
"""
Generatore audio offline (una tantum) per le videolezioni dinamiche.

Funzionalità anti-spreco e anti-allucinazione per Gemini TTS (Pay-as-you-go / Free Tier):
  - Chunking automatico a confine di frase (~45-55 parole) per evitare allucinazioni.
  - Cap rigido `maxOutputTokens` calcolato per singolo chunk (25 token audio/sec).
  - Controllo durata reale post-generazione (max 1 retry se durata anomala).
  - Cache locale per chunk basata su hash SHA-1 del testo (`audio/.chunks/`):
    se modifichi una frase, rigeneri solo quel singolo chunk.
  - Registro spesa reale cumulativa (`videolezioni/.budget_usage.json`) con tetto
    globale rigido (`--global-cap-eur`, default 4.80 € sotto il limite di 5 €)
    e tetto per singola esecuzione (`--max-run-eur`, default 0.50 €).
  - Modalità `--dry-run` per stimare chunk, durata e costo a costo 0 prima di partire.
  - Sottotitoli e cues ancorati al blocco esatto (zero drift lungo la scena).

Esempi:
  # 1. Stima a costo zero prima di spendere
  python videolezioni/scripts/generate_audio.py 10-perceptron --provider gemini --voice Kore --dry-run

  # 2. Generazione reale con Kore e guardia budget
  python videolezioni/scripts/generate_audio.py 10-perceptron --provider gemini --voice Kore --max-run-eur 0.50

  # 3. Alternativa gratuita (Edge Neural Elsa)
  python videolezioni/scripts/generate_audio.py 10-perceptron --provider edge --voice it-IT-ElsaNeural --force
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import os
import re
import time
import wave
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
LESSONS_DIR = ROOT / "lessons"
BUDGET_FILE = ROOT / ".budget_usage.json"

# Tariffe Gemini 3.8 Flash TTS (introductory rate: $0.50/1M text in, $9.00/1M audio out; 25 audio tok/sec)
# Usiamo tasso conservativo 1 USD = 0.95 EUR per non sottostimare mai la spesa in euro.
USD_PER_1M_INPUT_TOKENS = 0.50
USD_PER_1M_AUDIO_TOKENS = 9.00
AUDIO_TOKENS_PER_SEC = 25.0
USD_TO_EUR_CONSERVATIVE = 0.95
SAMPLE_RATE = 24000


def load_dotenv_files() -> None:
    """Carica variabili da videolezioni/.env o .env nella root senza dipendenze esterne."""
    for env_path in (ROOT / ".env", ROOT.parent / ".env"):
        if not env_path.exists():
            continue
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val


def clean_tts_text(text: str) -> str:
    cleaned = re.sub(r"\[[^\]]+\]", "", text)
    return re.sub(r"\s+", " ", cleaned).strip()


def normalize_token(tok: str) -> str:
    return re.sub(r"[^\wàèéìòùÀÈÉÌÒÙ]", "", tok.lower())


def get_mp3_duration(path: Path) -> float:
    from mutagen.mp3 import MP3
    return float(MP3(str(path)).info.length)


def get_wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as wf:
        return wf.getnframes() / float(wf.getframerate())


PAUSE_RE = re.compile(r"\[\s*pause\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*\]", re.IGNORECASE)


def parse_script_chunks(text: str, max_words: int = 52, default_pause: float = 0.35) -> list[dict[str, Any]]:
    """
    Divide tts_text sui marcatori didattici [pause:X.X] e, per blocchi lunghi,
    a confine di frase (. ? !). Restituisce lista di {"text": ..., "pause_after": float}.
    Le pause vengono inserite in locale a costo 0 €.
    """
    parts = PAUSE_RE.split(text)
    # parts alterna: [testo0, pause0, testo1, pause1, testo2, ...]
    raw_blocks: list[tuple[str, float]] = []
    i = 0
    while i < len(parts):
        seg_text = clean_tts_text(parts[i])
        pause_val = float(parts[i + 1]) if (i + 1 < len(parts) and parts[i + 1]) else 0.0
        if seg_text:
            raw_blocks.append((seg_text, pause_val))
        elif raw_blocks and pause_val > 0:
            prev_t, prev_p = raw_blocks[-1]
            raw_blocks[-1] = (prev_t, max(prev_p, pause_val))
        i += 2

    result: list[dict[str, Any]] = []
    for b_idx, (block_text, explicit_pause) in enumerate(raw_blocks):
        sentences = [s.strip() for s in re.findall(r"[^.!?]+[.!?]*", block_text) if s.strip()]
        sub_chunks: list[str] = []
        buf: list[str] = []
        buf_words = 0
        for sent in sentences:
            sw = len(sent.split())
            if buf and buf_words + sw > max_words:
                sub_chunks.append(" ".join(buf))
                buf = [sent]
                buf_words = sw
            else:
                buf.append(sent)
                buf_words += sw
        if buf:
            sub_chunks.append(" ".join(buf))

        for s_idx, ch in enumerate(sub_chunks):
            is_last_in_block = s_idx == len(sub_chunks) - 1
            is_very_last = is_last_in_block and (b_idx == len(raw_blocks) - 1)
            if is_very_last:
                p_after = 0.0
            elif is_last_in_block:
                p_after = explicit_pause if explicit_pause > 0 else default_pause
            else:
                p_after = default_pause
            result.append({"text": ch, "pause_after": round(p_after, 2)})

    return result


def chunk_text_by_sentences(text: str, max_words: int = 52) -> list[str]:
    return [item["text"] for item in parse_script_chunks(text, max_words=max_words)]


def trim_pcm_edges(pcm: bytes, sr: int = SAMPLE_RATE, pad_sec: float = 0.08, threshold: int = 260) -> bytes:
    """Rimuove eventuale silenzio eccessivo in testa/coda di un chunk WAV 16-bit mono."""
    import numpy as np

    if not pcm:
        return pcm
    samples = np.frombuffer(pcm, dtype=np.int16)
    if samples.size == 0:
        return pcm
    active = np.flatnonzero(np.abs(samples) > threshold)
    if active.size == 0:
        return pcm
    pad = int(sr * pad_sec)
    start = max(0, int(active[0]) - pad)
    end = min(samples.size, int(active[-1]) + pad)
    return samples[start:end].tobytes()


def load_budget_state() -> dict[str, Any]:
    if BUDGET_FILE.exists():
        return json.loads(BUDGET_FILE.read_text(encoding="utf-8"))
    return {
        "total_input_tokens": 0,
        "total_audio_tokens": 0,
        "total_usd": 0.0,
        "total_eur": 0.0,
        "calls": 0,
    }


def save_budget_state(state: dict[str, Any]) -> None:
    BUDGET_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def compute_cost_eur(input_tokens: int, audio_tokens: int) -> tuple[float, float]:
    usd = (input_tokens / 1_000_000.0) * USD_PER_1M_INPUT_TOKENS + (audio_tokens / 1_000_000.0) * USD_PER_1M_AUDIO_TOKENS
    eur = usd * USD_TO_EUR_CONSERVATIVE
    return usd, eur


def estimate_chunk_cost_eur(text: str) -> tuple[float, float]:
    words = max(1, len(text.split()))
    est_sec = words / 2.25
    est_in_tok = int(words * 1.6)
    est_audio_tok = int(est_sec * AUDIO_TOKENS_PER_SEC)
    _, eur = compute_cost_eur(est_in_tok, est_audio_tok)
    return est_sec, eur


def build_segments_from_words(words: list[dict[str, Any]], full_text: str, duration: float) -> dict[str, Any]:
    if not words:
        return build_proportional_subtitles(full_text, duration)

    segments: list[dict[str, Any]] = []
    cur: list[dict[str, Any]] = []

    def flush():
        if not cur:
            return
        segments.append({
            "start": round(cur[0]["start"], 3),
            "end": round(cur[-1]["end"], 3),
            "text": " ".join(w["text"] for w in cur),
            "words": cur.copy(),
        })
        cur.clear()

    for w in words:
        cur.append(w)
        txt = w["text"].strip()
        if txt.endswith((".", "!", "?")) or (txt.endswith((",", ";", ":")) and len(cur) >= 9) or len(cur) >= 15:
            flush()
    flush()
    return {"duration": round(duration, 3), "segments": segments}


def build_proportional_subtitles(tts_text: str, duration: float, offset: float = 0.0) -> dict[str, Any]:
    clean = clean_tts_text(tts_text)
    raw_sentences = re.findall(r"[^.!?]+[.!?]*", clean) or [clean]
    chunks: list[str] = []
    for s in raw_sentences:
        s = s.strip()
        if not s:
            continue
        if len(s.split()) > 16:
            for p in re.split(r"(?<=[,;:])\s+", s):
                if p.strip():
                    chunks.append(p.strip())
        else:
            chunks.append(s)

    total_chars = max(1, sum(len(c) for c in chunks))
    segments = []
    cursor = offset
    for chunk in chunks:
        seg_dur = (len(chunk) / total_chars) * duration
        toks = chunk.split()
        t_chars = max(1, sum(len(t) for t in toks))
        w_objs = []
        w_cur = cursor
        for t in toks:
            wd = (len(t) / t_chars) * seg_dur
            w_objs.append({"text": t, "start": round(w_cur, 3), "end": round(w_cur + wd, 3)})
            w_cur += wd
        segments.append({
            "start": round(cursor, 3),
            "end": round(cursor + seg_dur, 3),
            "text": chunk,
            "words": w_objs,
        })
        cursor += seg_dur

    return {"duration": round(offset + duration, 3), "segments": segments}


def build_subtitles_from_chunks(chunk_spans: list[dict[str, Any]], total_duration: float) -> dict[str, Any]:
    """Costruisce sottotitoli ancorati alla durata reale di ciascun chunk (zero drift)."""
    all_segments: list[dict[str, Any]] = []
    for sp in chunk_spans:
        sub = build_proportional_subtitles(sp["text"], sp["end"] - sp["start"], offset=sp["start"])
        all_segments.extend(sub["segments"])
    return {"duration": round(total_duration, 3), "segments": all_segments}


def align_cues_with_words(cues: list[dict[str, Any]], words: list[dict[str, Any]], tts_text: str, duration: float) -> None:
    norm_words = [normalize_token(w["text"]) for w in words]
    clean_lower = clean_tts_text(tts_text).lower()

    for cue in cues:
        anchor = (cue.get("anchor") or "").strip()
        matched_time = None

        if anchor and words:
            a_toks = [normalize_token(t) for t in anchor.split() if normalize_token(t)]
            if a_toks:
                n = len(a_toks)
                for i in range(len(norm_words) - n + 1):
                    if norm_words[i : i + n] == a_toks:
                        matched_time = max(0.0, words[i]["start"] - 0.15)
                        break

        if matched_time is None and anchor:
            idx = clean_lower.find(anchor.lower())
            if idx >= 0 and len(clean_lower) > 0:
                matched_time = max(0.0, (idx / len(clean_lower)) * duration - 0.15)

        if matched_time is not None:
            cue["at"] = round(min(max(0.0, duration - 0.2), matched_time), 2)


async def generate_edge_scene(text: str, out_mp3: Path, voice: str, rate: str, retries: int = 4) -> tuple[float, list[dict[str, Any]]]:
    import edge_tts

    out_mp3.parent.mkdir(parents=True, exist_ok=True)
    tmp_mp3 = out_mp3.with_suffix(".tmp.mp3")
    last_err: Exception | None = None

    for attempt in range(1, retries + 1):
        try:
            communicate = edge_tts.Communicate(text, voice=voice, rate=rate, boundary="WordBoundary")
            words: list[dict[str, Any]] = []
            with tmp_mp3.open("wb") as f:
                async for chunk in communicate.stream():
                    ctype = chunk.get("type")
                    if ctype == "audio":
                        f.write(chunk["data"])
                    elif ctype == "WordBoundary":
                        start = chunk["offset"] / 10_000_000.0
                        dur = chunk["duration"] / 10_000_000.0
                        words.append({"text": chunk["text"], "start": round(start, 3), "end": round(start + dur, 3)})
            tmp_mp3.replace(out_mp3)
            return get_mp3_duration(out_mp3), words
        except Exception as err:
            last_err = err
            if tmp_mp3.exists():
                tmp_mp3.unlink()
            if attempt < retries:
                await asyncio.sleep(1.5 * attempt)

    raise RuntimeError(f"edge-tts fallito dopo {retries} tentativi: {last_err}") from last_err


def generate_gtts_scene(text: str, out_mp3: Path) -> tuple[float, list[dict[str, Any]]]:
    from gtts import gTTS

    out_mp3.parent.mkdir(parents=True, exist_ok=True)
    gTTS(text=text, lang="it", tld="it", slow=False).save(str(out_mp3))
    return get_mp3_duration(out_mp3), []


def call_gemini_chunk(
    text: str,
    model: str,
    voice: str,
    api_key: str,
    budget_state: dict[str, Any],
    run_spent_eur: list[float],
    max_run_eur: float,
    global_cap_eur: float,
) -> tuple[bytes, float]:
    """Chiama Gemini TTS su un singolo chunk breve con cap maxOutputTokens e guardia budget."""
    import requests

    words = max(1, len(text.split()))
    est_sec, est_eur = estimate_chunk_cost_eur(text)

    if budget_state["total_eur"] + est_eur > global_cap_eur:
        raise RuntimeError(
            f"STOP BUDGET GLOBALE: spesi {budget_state['total_eur']:.3f}€, "
            f"chunk stimato {est_eur:.3f}€ supererebbe il tetto di {global_cap_eur:.2f}€."
        )
    if run_spent_eur[0] + est_eur > max_run_eur:
        raise RuntimeError(
            f"STOP BUDGET RUN: spesi {run_spent_eur[0]:.3f}€ in questa esecuzione, "
            f"limite --max-run-eur={max_run_eur:.2f}€."
        )

    # Cap rigido token audio: impedisce allucinazioni lunghe che bruciano crediti
    max_output_tokens = int(max(6.0, words / 1.85) * AUDIO_TOKENS_PER_SEC * 1.55) + 120
    max_valid_dur = max(14.0, words / 1.15)
    min_valid_dur = max(1.2, words / 5.0)

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    payload = {
        "contents": [{"role": "user", "parts": [{"text": text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "maxOutputTokens": max_output_tokens,
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}},
        },
    }

    best_pcm: bytes | None = None
    best_dur: float = 0.0

    # Max 2 tentativi di qualità (per non bruciare mai budget in loop)
    for quality_try in range(1, 3):
        resp = None
        for net_try in range(1, 5):
            resp = requests.post(url, params={"key": api_key}, json=payload, timeout=90)
            if resp.status_code == 200:
                break
            if resp.status_code in (429, 500, 503) and net_try < 4:
                wait_s = 10 * net_try
                print(f"      HTTP {resp.status_code}, pausa {wait_s}s (retry {net_try}/4)...")
                time.sleep(wait_s)
                continue
            raise RuntimeError(f"Gemini TTS HTTP {resp.status_code}: {resp.text[:300]}")

        assert resp is not None
        data = resp.json()
        usage = data.get("usageMetadata", {})
        in_tok = int(usage.get("promptTokenCount", int(words * 1.6)))
        out_tok = int(usage.get("candidatesTokenCount", 0))

        b64 = data["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
        raw_pcm = base64.b64decode(b64)
        pcm = trim_pcm_edges(raw_pcm)
        dur = len(pcm) / float(SAMPLE_RATE * 2)

        if out_tok == 0:
            out_tok = int(dur * AUDIO_TOKENS_PER_SEC)

        usd, eur = compute_cost_eur(in_tok, out_tok)
        budget_state["total_input_tokens"] += in_tok
        budget_state["total_audio_tokens"] += out_tok
        budget_state["total_usd"] = round(budget_state["total_usd"] + usd, 5)
        budget_state["total_eur"] = round(budget_state["total_eur"] + eur, 5)
        budget_state["calls"] += 1
        run_spent_eur[0] += eur
        save_budget_state(budget_state)

        best_pcm, best_dur = pcm, dur
        if min_valid_dur <= dur <= max_valid_dur:
            return pcm, dur

        print(f"      [guardia durata] chunk {words}w durato {dur:.1f}s (atteso {min_valid_dur:.1f}-{max_valid_dur:.1f}s), retry {quality_try}/2...")
        time.sleep(1.0)

    assert best_pcm is not None
    return best_pcm, best_dur


def generate_gemini_scene_chunked(
    scene_id: str,
    text: str,
    out_wav: Path,
    chunks_dir: Path,
    model: str,
    voice: str,
    api_key: str,
    budget_state: dict[str, Any],
    run_spent_eur: list[float],
    max_run_eur: float,
    global_cap_eur: float,
    force_chunks: bool,
    max_chunk_words: int,
) -> tuple[float, list[dict[str, Any]]]:
    """Genera i chunk con cache SHA-1, li ricuce con pause didattiche [pause:X] a costo 0 e restituisce gli span esatti."""
    chunk_items = parse_script_chunks(text, max_words=max_chunk_words)
    chunks_dir.mkdir(parents=True, exist_ok=True)

    stitched = bytearray()
    chunk_spans: list[dict[str, Any]] = []
    cursor = 0.0

    for idx, item in enumerate(chunk_items, start=1):
        ch_text = item["text"]
        pause_after = item["pause_after"]
        h = hashlib.sha1(f"{model}|{voice}|{ch_text}".encode("utf-8")).hexdigest()[:10]
        cache_wav = chunks_dir / f"{scene_id}-c{idx:02d}-{h}.wav"

        if cache_wav.exists() and cache_wav.stat().st_size > 44 and not force_chunks:
            with wave.open(str(cache_wav), "rb") as wf:
                pcm = wf.readframes(wf.getnframes())
            dur = len(pcm) / float(SAMPLE_RATE * 2)
            print(f"      chunk {idx}/{len(chunk_items)} ({len(ch_text.split())}w): da cache ({dur:.1f}s)")
        else:
            pcm, dur = call_gemini_chunk(
                ch_text, model, voice, api_key, budget_state, run_spent_eur, max_run_eur, global_cap_eur
            )
            with wave.open(str(cache_wav), "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(SAMPLE_RATE)
                wf.writeframes(pcm)
            print(f"      chunk {idx}/{len(chunk_items)} ({len(ch_text.split())}w): generato ({dur:.1f}s) | spesi finora: {budget_state['total_eur']:.3f}€")
            time.sleep(0.8)

        chunk_spans.append({"start": round(cursor, 3), "end": round(cursor + dur, 3), "text": ch_text})
        stitched.extend(pcm)
        cursor += dur

        if pause_after > 0:
            stitched.extend(b"\x00\x00" * int(SAMPLE_RATE * pause_after))
            cursor += pause_after

    out_wav.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(out_wav), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(bytes(stitched))

    return cursor, chunk_spans


async def process_lesson(
    lesson_slug: str,
    provider: str,
    voice: str,
    rate: str,
    gemini_model: str,
    force: bool,
    dry_run: bool,
    max_run_eur: float,
    global_cap_eur: float,
    max_chunk_words: int,
    only_scene: str | None = None,
) -> None:
    lesson_dir = LESSONS_DIR / lesson_slug
    lesson_json_path = lesson_dir / "lesson.json"
    if not lesson_json_path.exists():
        raise SystemExit(f"File non trovato: {lesson_json_path}")

    lesson = json.loads(lesson_json_path.read_text(encoding="utf-8"))
    all_scenes = lesson["scenes"]
    scenes = [s for s in all_scenes if not only_scene or s["id"] == only_scene]
    if not scenes:
        raise SystemExit(f"Scena '{only_scene}' non trovata in {lesson_slug}")
    budget_state = load_budget_state()
    chunks_dir = lesson_dir / "audio" / ".chunks"

    # Modalità --dry-run (stima esatta a costo 0)
    if dry_run:
        total_words = 0
        total_chunks = 0
        cached_chunks = 0
        total_pause_sec = 0.0
        est_new_sec = 0.0
        est_new_eur = 0.0
        for sc in scenes:
            sid = sc["id"]
            items = parse_script_chunks(sc["tts_text"], max_words=max_chunk_words)
            total_words += len(clean_tts_text(sc["tts_text"]).split())
            total_chunks += len(items)
            for idx, item in enumerate(items, start=1):
                ch_text = item["text"]
                total_pause_sec += item["pause_after"]
                h = hashlib.sha1(f"{gemini_model}|{voice}|{ch_text}".encode("utf-8")).hexdigest()[:10]
                cache_wav = chunks_dir / f"{sid}-c{idx:02d}-{h}.wav"
                if cache_wav.exists() and cache_wav.stat().st_size > 44 and not force:
                    cached_chunks += 1
                else:
                    sec, eur = estimate_chunk_cost_eur(ch_text)
                    est_new_sec += sec
                    est_new_eur += eur

        print(f"=== DRY RUN: {lesson_slug} | provider={provider} | model={gemini_model} | voice={voice} ===")
        print(f"Scene: {len(scenes)} | Parole parlate: {total_words} | Pause didattiche (costo 0€): {total_pause_sec:.1f}s")
        print(f"Chunk (max {max_chunk_words}w): {total_chunks} totali ({cached_chunks} in cache, {total_chunks - cached_chunks} da generare)")
        print(f"Durata parlato da generare: {est_new_sec/60:.1f} min ({est_new_sec:.0f}s) + {total_pause_sec:.0f}s di pause locali")
        if provider == "gemini":
            print(f"Costo stimato questa run: ~{est_new_eur:.3f}€")
            print(f"Spesa globale registrata finora: {budget_state['total_eur']:.3f}€ / tetto {global_cap_eur:.2f}€")
            print(f"Margine residuo dopo questa run: ~{global_cap_eur - budget_state['total_eur'] - est_new_eur:.3f}€")
        else:
            print("Costo API stimato: 0.000€ (provider gratuito)")
        return

    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""
    if provider == "gemini" and not api_key:
        raise SystemExit("GEMINI_API_KEY non trovata. Inseriscila in videolezioni/.env.")

    run_spent_eur = [0.0]
    total_duration = 0.0
    print(f"Generazione audio per {lesson_slug} ({len(scenes)} scene) | provider={provider} | voice={voice}")

    for idx, scene in enumerate(scenes, start=1):
        sid = scene["id"]
        ext = "wav" if provider == "gemini" else "mp3"
        rel_audio = f"audio/{sid}.{ext}"
        rel_sub = f"subtitles/{sid}.json"
        scene["audio_file"] = rel_audio
        scene["subtitle_file"] = rel_sub

        audio_path = lesson_dir / rel_audio
        sub_path = lesson_dir / rel_sub
        text_clean = clean_tts_text(scene["tts_text"])

        if provider != "gemini" and audio_path.exists() and audio_path.stat().st_size > 0 and sub_path.exists() and not force:
            dur = get_mp3_duration(audio_path)
            sub_data = json.loads(sub_path.read_text(encoding="utf-8"))
            cached_words = [w for seg in sub_data.get("segments", []) for w in seg.get("words", [])]
            align_cues_with_words(scene.get("cues", []), cached_words, scene["tts_text"], dur)
            scene["duration_sec"] = round(dur, 2)
            total_duration += dur
            print(f"  [{idx:02d}/{len(scenes)}] {sid}: già presente ({dur:.1f}s) — cues riallineati")
            continue

        if provider == "edge":
            dur, words = await generate_edge_scene(text_clean, audio_path, voice=voice, rate=rate)
            sub_data = build_segments_from_words(words, text_clean, dur)
            align_cues_with_words(scene.get("cues", []), words, scene["tts_text"], dur)
            await asyncio.sleep(0.4)
        elif provider == "gtts":
            dur, words = generate_gtts_scene(text_clean, audio_path)
            sub_data = build_proportional_subtitles(text_clean, dur)
            align_cues_with_words(scene.get("cues", []), [], scene["tts_text"], dur)
        elif provider == "gemini":
            print(f"  [{idx:02d}/{len(scenes)}] {sid} ({len(text_clean.split())} parole)...")
            dur, spans = generate_gemini_scene_chunked(
                sid, scene["tts_text"], audio_path, chunks_dir, gemini_model, voice, api_key,
                budget_state, run_spent_eur, max_run_eur, global_cap_eur, force, max_chunk_words
            )
            sub_data = build_subtitles_from_chunks(spans, dur)
            chunk_words = [w for seg in sub_data["segments"] for w in seg["words"]]
            align_cues_with_words(scene.get("cues", []), chunk_words, scene["tts_text"], dur)
        else:
            raise SystemExit(f"Provider sconosciuto: {provider}")

        sub_path.parent.mkdir(parents=True, exist_ok=True)
        sub_path.write_text(json.dumps(sub_data, ensure_ascii=False, indent=2), encoding="utf-8")
        scene["duration_sec"] = round(dur, 2)
        total_duration += dur

        # Salvataggio incrementale di lesson.json dopo ogni scena (resistente a interruzioni)
        vc = lesson.setdefault("voice_config", {})
        vc["provider"] = provider
        vc["voice_name"] = voice
        vc["model"] = gemini_model if provider == "gemini" else ("google-gtts" if provider == "gtts" else "edge-neural-tts")
        lesson_json_path.write_text(json.dumps(lesson, ensure_ascii=False, indent=2), encoding="utf-8")

        print(f"  [{idx:02d}/{len(scenes)}] {sid}: pronto {rel_audio} ({dur:.1f}s, {len(sub_data['segments'])} righe sottotitoli)")

    manifest_path = LESSONS_DIR / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        full_dur = sum(float(s.get("duration_sec") or 0) for s in all_scenes)
        for entry in manifest.get("lessons", []):
            if entry["id"] == lesson_slug:
                entry["status"] = "ready"
                entry["scenes_count"] = len(all_scenes)
                entry["estimated_minutes"] = max(1, round(full_dur / 60.0))
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Completato! Durata totale: {total_duration/60:.1f} min ({total_duration:.1f}s).")
    if provider == "gemini":
        print(f"Spesa questa run: {run_spent_eur[0]:.3f}€ | Totale cumulativo: {budget_state['total_eur']:.3f}€ / {global_cap_eur:.2f}€")


def main() -> None:
    load_dotenv_files()
    parser = argparse.ArgumentParser(description="Genera audio locale e sottotitoli sincronizzati con guardia budget.")
    parser.add_argument("lesson", help="Slug della lezione (es. 10-perceptron)")
    parser.add_argument("--provider", choices=["edge", "gtts", "gemini"], default="gemini",
                        help="Servizio TTS (default: gemini)")
    parser.add_argument("--voice", default=None,
                        help="Nome voce (gemini: Kore/Orus/Charon/Aoede; edge: it-IT-ElsaNeural/it-IT-DiegoNeural)")
    parser.add_argument("--rate", default="+0%", help="Velocità parlato edge-tts")
    parser.add_argument("--gemini-model", default="gemini-3.8-flash-tts", help="Modello Gemini TTS")
    parser.add_argument("--max-chunk-words", type=int, default=52, help="Parole massime per chunk Gemini (anti-allucinazione)")
    parser.add_argument("--max-run-eur", type=float, default=0.50, help="Tetto massimo di spesa per singola run in EUR")
    parser.add_argument("--global-cap-eur", type=float, default=4.80, help="Tetto massimo cumulativo globale in EUR (sotto limite 5€)")
    parser.add_argument("--scene", default=None, help="Genera una sola scena specifica (es. scene-03)")
    parser.add_argument("--dry-run", action="store_true", help="Stima chunk e costo senza chiamare API")
    parser.add_argument("--force", action="store_true", help="Ignora cache chunk e rigenera tutto")
    args = parser.parse_args()

    voice = args.voice
    if not voice:
        if args.provider == "gemini":
            voice = "Kore"
        elif args.provider == "edge":
            voice = "it-IT-ElsaNeural"
        else:
            voice = "google-it"

    asyncio.run(
        process_lesson(
            args.lesson, args.provider, voice, args.rate, args.gemini_model,
            args.force, args.dry_run, args.max_run_eur, args.global_cap_eur, args.max_chunk_words,
            only_scene=args.scene,
        )
    )


if __name__ == "__main__":
    main()
