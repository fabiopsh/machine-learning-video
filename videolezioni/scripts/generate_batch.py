#!/usr/bin/env python3
"""
Generatore Batch-and-Splice con MMS_FA (ottimizzato per RPD e budget).

Invece di 1 chiamata per ogni micro-pausa (10+ RPD per scena), unisce 2-3 scene
(~300-420 parole) in UNA SOLA richiesta API a Gemini TTS, poi in locale a 0,00 €:
  1. Estrae il PCM puro (senza header RIFF né metadati C2PA/IPTC).
  2. Allinea parola per parola tutto il batch con `MMS_FA`.
  3. Trova i punti di minima energia (silenzio naturale) per:
     - separare ciascuna scena nel proprio `audio/scene-XX.wav` (tagliando via
       eventuali code extra dopo l'ultima parola);
     - iniettare la differenza esatta di silenzio sui marcatori `[pause:X]`
       con micro-fade da 12ms (zero click, respiro naturale preservato).
  4. Genera `subtitles/scene-XX.json` parola per parola e aggancia `cues[].at`.

Esempi:
  # Dry-run per vedere esattamente quanti RPD e quanti EUR servono
  python videolezioni/scripts/generate_batch.py 10-perceptron --dry-run

  # Pilota su 2 scene in 1 sola chiamata API (1 RPD)
  python videolezioni/scripts/generate_batch.py 10-perceptron --scenes scene-01,scene-02

  # Completa tutte le scene mancanti della lezione in batch da ~380 parole
  python videolezioni/scripts/generate_batch.py 10-perceptron --all-missing
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sys
import time
import wave
from pathlib import Path
from typing import Any

import numpy as np
import requests

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from generate_audio import (
    AUDIO_TOKENS_PER_SEC,
    LESSONS_DIR,
    PAUSE_RE,
    SAMPLE_RATE,
    clean_tts_text,
    compute_cost_eur,
    extract_pcm_from_api_bytes,
    load_budget_state,
    load_dotenv_files,
    save_budget_state,
)
from align_audio import (
    LocalForcedAligner,
    align_cues_exact,
    group_words_to_subtitles,
)


def parse_words_and_pauses(tts_text: str) -> tuple[list[str], dict[int, float]]:
    """
    Restituisce:
      - words: lista ordinata delle parole parlate (senza tag [pause:X])
      - pauses: mappa {indice_parola_precedente: durata_pausa_richiesta_sec}
    """
    parts = PAUSE_RE.split(tts_text)
    words: list[str] = []
    pauses: dict[int, float] = {}

    i = 0
    while i < len(parts):
        seg = clean_tts_text(parts[i])
        p_val = float(parts[i + 1]) if (i + 1 < len(parts) and parts[i + 1]) else 0.0
        if seg:
            seg_words = seg.split()
            words.extend(seg_words)
        if p_val > 0 and words:
            last_idx = len(words) - 1
            pauses[last_idx] = max(pauses.get(last_idx, 0.0), p_val)
        i += 2

    return words, pauses


def apply_fade(samples: np.ndarray, sr: int, fade_in_ms: float = 12.0, fade_out_ms: float = 12.0) -> np.ndarray:
    out = samples.astype(np.float32, copy=True)
    n_in = min(int(sr * fade_in_ms / 1000.0), out.size // 3)
    n_out = min(int(sr * fade_out_ms / 1000.0), out.size // 3)
    if n_in > 1:
        out[:n_in] *= np.linspace(0.0, 1.0, n_in, dtype=np.float32)
    if n_out > 1:
        out[-n_out:] *= np.linspace(1.0, 0.0, n_out, dtype=np.float32)
    return np.clip(out, -32768, 32767).astype(np.int16)


def find_quietest_sample(samples: np.ndarray, sr: int, t_start: float, t_end: float, win_ms: float = 18.0) -> int:
    """Trova il punto centrale della finestra con RMS minimo tra t_start e t_end (zero taglio su consonanti)."""
    i0 = max(0, int(round(t_start * sr)))
    i1 = min(samples.size, int(round(t_end * sr)))
    if i1 <= i0:
        return min(samples.size, max(0, (i0 + i1) // 2))

    win = max(16, int(sr * win_ms / 1000.0))
    if i1 - i0 <= win:
        return (i0 + i1) // 2

    seg = samples[i0:i1].astype(np.float32)
    # Somma cumulativa dei quadrati per calcolo O(N) dell'RMS mobile
    csum = np.concatenate(([0.0], np.cumsum(seg * seg)))
    energies = csum[win:] - csum[:-win]
    best_rel = int(np.argmin(energies)) + win // 2
    return i0 + best_rel


def call_gemini_batch_wav(
    batch_text: str,
    batch_cache_wav: Path,
    model: str,
    voice: str,
    api_key: str,
    budget_state: dict[str, Any],
    run_spent_eur: list[float],
    max_run_eur: float,
    global_cap_eur: float,
    force: bool,
) -> tuple[Path, int]:
    """Chiama Gemini TTS una sola volta per l'intero batch di scene (con cache SHA-1 e budget guard)."""
    if batch_cache_wav.exists() and batch_cache_wav.stat().st_size > 44 and not force:
        with wave.open(str(batch_cache_wav), "rb") as wf:
            sr = wf.getframerate()
            dur = wf.getnframes() / float(sr)
        print(f"    [cache batch] {batch_cache_wav.name} ({dur:.1f}s) — 0 RPD, 0.000€")
        return batch_cache_wav, sr

    words = max(1, len(batch_text.split()))
    est_sec = words / 2.25
    _, est_eur = compute_cost_eur(int(words * 1.6), int(est_sec * AUDIO_TOKENS_PER_SEC))

    if budget_state["total_eur"] + est_eur > global_cap_eur:
        raise RuntimeError(
            f"STOP BUDGET GLOBALE: spesi {budget_state['total_eur']:.3f}€, "
            f"batch stimato {est_eur:.3f}€ supera {global_cap_eur:.2f}€."
        )
    if run_spent_eur[0] + est_eur > max_run_eur:
        raise RuntimeError(
            f"STOP BUDGET RUN: spesi {run_spent_eur[0]:.3f}€, limite --max-run-eur={max_run_eur:.2f}€."
        )

    # Cap stretto ma sicuro: ~2.1 parole/sec * 1.32 margine + 150 tok (evita runaway lunghi)
    max_output_tokens = int((words / 2.05) * AUDIO_TOKENS_PER_SEC * 1.32) + 180
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    payload = {
        "contents": [{"role": "user", "parts": [{"text": batch_text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "maxOutputTokens": max_output_tokens,
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}},
        },
    }

    resp = None
    for net_try in range(1, 5):
        resp = requests.post(url, params={"key": api_key}, json=payload, timeout=180)
        if resp.status_code == 200:
            break
        if resp.status_code in (429, 500, 503) and net_try < 4:
            wait_s = 12 * net_try
            print(f"    HTTP {resp.status_code}, pausa {wait_s}s (retry {net_try}/4)...")
            time.sleep(wait_s)
            continue
        raise RuntimeError(f"Gemini TTS HTTP {resp.status_code}: {resp.text[:350]}")

    assert resp is not None
    data = resp.json()
    usage = data.get("usageMetadata", {})
    in_tok = int(usage.get("promptTokenCount", int(words * 1.6)))
    out_tok = int(usage.get("candidatesTokenCount", 0))

    b64 = data["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
    api_bytes = base64.b64decode(b64)
    pure_pcm, sr_actual = extract_pcm_from_api_bytes(api_bytes)
    dur = len(pure_pcm) / float(sr_actual * 2)

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

    batch_cache_wav.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(batch_cache_wav), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr_actual)
        wf.writeframes(pure_pcm)

    print(
        f"    [API 1 RPD] generato {batch_cache_wav.name} ({words}w -> {dur:.1f}s) | "
        f"costo={eur:.3f}€ | totale={budget_state['total_eur']:.3f}€/{global_cap_eur:.2f}€"
    )
    return batch_cache_wav, sr_actual


def splice_scene_with_pauses(
    batch_samples: np.ndarray,
    sr: int,
    scene_words: list[dict[str, Any]],
    pauses: dict[int, float],
    scene_start_sample: int,
    scene_end_sample: int,
) -> tuple[np.ndarray, list[dict[str, Any]]]:
    """
    Estrae la porzione della scena dal batch e inserisce solo la differenza di
    silenzio necessaria nei punti `[pause:X]`, scegliendo il punto di minima
    energia tra le due frasi e applicando micro-fade da 12ms (zero click).
    """
    # Calcola i punti di taglio interni per le pause esplicite
    cuts: list[tuple[int, float, int]] = []  # (sample_cut, extra_silence_sec, after_word_idx)
    for w_idx in sorted(pauses.keys()):
        if w_idx >= len(scene_words) - 1:
            continue
        target_pause = pauses[w_idx]
        w_prev = scene_words[w_idx]
        w_next = scene_words[w_idx + 1]
        natural_gap = max(0.0, w_next["start"] - w_prev["end"])
        extra_sil = max(0.0, target_pause - natural_gap)
        if extra_sil < 0.08:
            continue

        # Cerca il punto di minima energia tra la fine di w_prev e l'inizio di w_next
        t0 = w_prev["end"] + min(0.04, natural_gap * 0.25)
        t1 = w_next["start"] - min(0.03, natural_gap * 0.25)
        if t1 <= t0:
            t0, t1 = w_prev["end"], w_next["start"]
        cut_sample = find_quietest_sample(batch_samples, sr, t0, t1)
        cut_sample = max(scene_start_sample + 1, min(scene_end_sample - 1, cut_sample))
        cuts.append((cut_sample, extra_sil, w_idx))

    # Costruisci i segmenti audio con micro-fade e silenzio inserito
    pieces: list[np.ndarray] = []
    cur_sample = scene_start_sample
    word_shifts = [0.0] * len(scene_words)
    cumulative_extra = 0.0

    for cut_sample, extra_sil, w_idx in cuts:
        if cut_sample <= cur_sample:
            continue
        seg = batch_samples[cur_sample:cut_sample]
        pieces.append(apply_fade(seg, sr, fade_in_ms=10.0, fade_out_ms=10.0))
        sil_n = int(round(extra_sil * sr))
        pieces.append(np.zeros(sil_n, dtype=np.int16))
        actual_extra = sil_n / float(sr)
        cumulative_extra += actual_extra
        for j in range(w_idx + 1, len(scene_words)):
            word_shifts[j] += actual_extra
        cur_sample = cut_sample

    tail_seg = batch_samples[cur_sample:scene_end_sample]
    pieces.append(apply_fade(tail_seg, sr, fade_in_ms=10.0, fade_out_ms=16.0))

    # Assicura un fade-in pulito all'inizio assoluto della scena
    if pieces:
        pieces[0] = apply_fade(pieces[0], sr, fade_in_ms=14.0, fade_out_ms=10.0)

    final_samples = np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.int16)
    base_sec = scene_start_sample / float(sr)
    final_dur = final_samples.size / float(sr)

    adjusted_words: list[dict[str, Any]] = []
    for idx, w in enumerate(scene_words):
        s = max(0.0, round(w["start"] - base_sec + word_shifts[idx], 3))
        e = min(final_dur, max(s + 0.04, round(w["end"] - base_sec + word_shifts[idx], 3)))
        adjusted_words.append({"text": w["text"], "start": s, "end": e})

    return final_samples, adjusted_words


def build_batches(scenes: list[dict[str, Any]], max_batch_words: int) -> list[list[dict[str, Any]]]:
    batches: list[list[dict[str, Any]]] = []
    cur: list[dict[str, Any]] = []
    cur_w = 0
    for sc in scenes:
        sw = len(clean_tts_text(sc["tts_text"]).split())
        if cur and cur_w + sw > max_batch_words:
            batches.append(cur)
            cur = [sc]
            cur_w = sw
        else:
            cur.append(sc)
            cur_w += sw
    if cur:
        batches.append(cur)
    return batches


def run_batch_pipeline(
    lesson_slug: str,
    scene_filter: list[str] | None,
    all_missing: bool,
    max_batch_words: int,
    model: str,
    voice: str,
    dry_run: bool,
    force: bool,
    max_run_eur: float,
    global_cap_eur: float,
) -> None:
    lesson_dir = LESSONS_DIR / lesson_slug
    lesson_json_path = lesson_dir / "lesson.json"
    if not lesson_json_path.exists():
        raise SystemExit(f"File non trovato: {lesson_json_path}")

    lesson = json.loads(lesson_json_path.read_text(encoding="utf-8"))
    all_scenes = lesson["scenes"]

    if scene_filter:
        target_scenes = [s for s in all_scenes if s["id"] in scene_filter]
    elif all_missing:
        target_scenes = [
            s for s in all_scenes
            if not (lesson_dir / "audio" / f"{s['id']}.wav").exists() or force
        ]
    else:
        target_scenes = list(all_scenes)

    if not target_scenes:
        print("Nessuna scena da generare (tutte già presenti come WAV).")
        return

    batches = build_batches(target_scenes, max_batch_words=max_batch_words)
    budget_state = load_budget_state()
    batches_dir = lesson_dir / "audio" / ".batches"

    if dry_run:
        tot_w = 0
        tot_eur = 0.0
        api_calls = 0
        print(f"=== DRY RUN BATCH-AND-SPLICE: {lesson_slug} | model={model} | voice={voice} ===")
        for b_idx, b_scenes in enumerate(batches, start=1):
            ids = [s["id"] for s in b_scenes]
            b_text = "\n\n".join(clean_tts_text(s["tts_text"]) for s in b_scenes)
            w = len(b_text.split())
            tot_w += w
            h = hashlib.sha1(f"{model}|{voice}|{b_text}".encode("utf-8")).hexdigest()[:10]
            cache_wav = batches_dir / f"batch-{ids[0]}-{ids[-1]}-{h}.wav"
            cached = cache_wav.exists() and cache_wav.stat().st_size > 44 and not force
            est_sec = w / 2.25
            _, est_eur = compute_cost_eur(int(w * 1.6), int(est_sec * AUDIO_TOKENS_PER_SEC))
            if not cached:
                tot_eur += est_eur
                api_calls += 1
            tag = "CACHE (0 RPD)" if cached else f"1 RPD (~{est_eur:.3f}€)"
            print(f"  Batch {b_idx:02d}: {', '.join(ids)} ({w}w, ~{est_sec:.0f}s) -> {tag}")
        print(f"Totale: {len(target_scenes)} scene | {tot_w} parole | {api_calls} chiamate API (RPD)")
        print(f"Costo stimato: ~{tot_eur:.3f}€ | Spesi finora: {budget_state['total_eur']:.3f}€ / {global_cap_eur:.2f}€")
        return

    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""
    if not api_key:
        raise SystemExit("GEMINI_API_KEY non trovata in videolezioni/.env.")

    print("Caricamento MMS_FA locale (0,00 €) per taglio scene e inserimento pause...")
    aligner = LocalForcedAligner()
    run_spent_eur = [0.0]

    for b_idx, b_scenes in enumerate(batches, start=1):
        ids = [s["id"] for s in b_scenes]
        print(f"\n=== Batch {b_idx}/{len(batches)}: {', '.join(ids)} ===")

        scene_meta = []
        batch_word_list: list[str] = []
        for sc in b_scenes:
            w_list, p_map = parse_words_and_pauses(sc["tts_text"])
            start_i = len(batch_word_list)
            batch_word_list.extend(w_list)
            end_i = len(batch_word_list)
            scene_meta.append({"scene": sc, "start_w": start_i, "end_w": end_i, "pauses": p_map})

        batch_text = "\n\n".join(clean_tts_text(sc["tts_text"]) for sc in b_scenes)
        h = hashlib.sha1(f"{model}|{voice}|{batch_text}".encode("utf-8")).hexdigest()[:10]
        cache_wav = batches_dir / f"batch-{ids[0]}-{ids[-1]}-{h}.wav"

        wav_path, sr = call_gemini_batch_wav(
            batch_text, cache_wav, model, voice, api_key,
            budget_state, run_spent_eur, max_run_eur, global_cap_eur, force
        )

        # Allinea tutte le parole del batch in una passata sola
        batch_dur, aligned_words = aligner.align_wav(wav_path, " ".join(batch_word_list))
        if len(aligned_words) != len(batch_word_list):
            raise RuntimeError(f"Mismatch parole allineate: {len(aligned_words)} vs {len(batch_word_list)}")

        with wave.open(str(wav_path), "rb") as wf:
            batch_samples = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16)

        # Controlla eventuale coda extra dopo l'ultima parola (tagliata automaticamente)
        extra_tail = batch_dur - aligned_words[-1]["end"]
        if extra_tail > 2.5:
            print(f"    [anti-allucinazione] rilevati {extra_tail:.1f}s di coda extra dopo l'ultima parola -> tagliati automaticamente.")

        # Calcola i confini esatti tra le scene nel batch (sul punto di minima energia)
        boundaries: list[int] = []
        first_s = max(0, int(round(max(0.0, aligned_words[0]["start"] - 0.08) * sr)))
        boundaries.append(first_s)

        for k in range(len(scene_meta) - 1):
            w_end = aligned_words[scene_meta[k]["end_w"] - 1]["end"]
            w_next = aligned_words[scene_meta[k + 1]["start_w"]]["start"]
            gap = max(0.0, w_next - w_end)
            t0 = w_end + min(0.06, gap * 0.25)
            t1 = w_next - min(0.04, gap * 0.25)
            if t1 <= t0:
                t0, t1 = w_end, w_next
            split_sample = find_quietest_sample(batch_samples, sr, t0, t1, win_ms=25.0)
            boundaries.append(split_sample)

        last_e = min(batch_samples.size, int(round((aligned_words[-1]["end"] + 0.25) * sr)))
        boundaries.append(last_e)

        # Estrai ciascuna scena, inietta le pause [pause:X], salva WAV + sottotitoli + cues
        for k, meta in enumerate(scene_meta):
            sc = meta["scene"]
            sid = sc["id"]
            sc_words = aligned_words[meta["start_w"] : meta["end_w"]]
            s_samp, e_samp = boundaries[k], boundaries[k + 1]

            sc_samples, adj_words = splice_scene_with_pauses(
                batch_samples, sr, sc_words, meta["pauses"], s_samp, e_samp
            )
            sc_dur = sc_samples.size / float(sr)

            out_wav = lesson_dir / "audio" / f"{sid}.wav"
            out_wav.parent.mkdir(parents=True, exist_ok=True)
            with wave.open(str(out_wav), "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(sr)
                wf.writeframes(sc_samples.tobytes())

            sub_data = group_words_to_subtitles(adj_words, sc_dur)
            sub_path = lesson_dir / "subtitles" / f"{sid}.json"
            sub_path.parent.mkdir(parents=True, exist_ok=True)
            sub_path.write_text(json.dumps(sub_data, ensure_ascii=False, indent=2), encoding="utf-8")

            sc["audio_file"] = f"audio/{sid}.wav"
            sc["subtitle_file"] = f"subtitles/{sid}.json"
            sc["duration_sec"] = round(sc_dur, 2)
            matched, tot_c = align_cues_exact(sc.get("cues", []), adj_words, sc_dur)
            print(
                f"    -> {sid}: {sc_dur:.2f}s | {len(adj_words)} parole | "
                f"{matched}/{tot_c} cues agganciati | head={abs(int(sc_samples[0]))} tail={abs(int(sc_samples[-1]))}"
            )

        # Salvataggio incrementale di lesson.json dopo ogni batch
        vc = lesson.setdefault("voice_config", {})
        vc["provider"] = "gemini"
        vc["model"] = model
        vc["voice_name"] = voice
        lesson_json_path.write_text(json.dumps(lesson, ensure_ascii=False, indent=2), encoding="utf-8")

        if b_idx < len(batches):
            time.sleep(2.0)

    # Aggiorna manifest.json
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

    print(
        f"\nCompletato! Spesa questa run: {run_spent_eur[0]:.3f}€ | "
        f"Totale cumulativo: {budget_state['total_eur']:.3f}€ / {global_cap_eur:.2f}€"
    )


def main() -> None:
    load_dotenv_files()
    parser = argparse.ArgumentParser(description="Batch-and-Splice Gemini TTS + MMS_FA (risparmia 15x RPD).")
    parser.add_argument("lesson", help="Slug della lezione (es. 10-perceptron)")
    parser.add_argument("--scenes", default=None, help="Lista separata da virgola (es. scene-01,scene-02)")
    parser.add_argument("--all-missing", action="store_true", help="Genera tutte le scene senza file .wav")
    parser.add_argument("--max-batch-words", type=int, default=390, help="Parole massime per singola chiamata API (default 390 = ~2-3 scene)")
    parser.add_argument("--model", default="gemini-3.8-flash-tts")
    parser.add_argument("--voice", default="Kore")
    parser.add_argument("--max-run-eur", type=float, default=0.50)
    parser.add_argument("--global-cap-eur", type=float, default=4.80)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    s_filter = [s.strip() for s in args.scenes.split(",") if s.strip()] if args.scenes else None
    run_batch_pipeline(
        args.lesson, s_filter, args.all_missing, args.max_batch_words,
        args.model, args.voice, args.dry_run, args.force, args.max_run_eur, args.global_cap_eur
    )


if __name__ == "__main__":
    main()
