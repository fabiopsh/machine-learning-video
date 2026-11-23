#!/usr/bin/env python3
"""
Forced Aligner locale a costo 0 € (torchaudio.pipelines.MMS_FA — Meta MMS).

Allinea il copione esatto (`tts_text`) sul file audio reale (`.wav` generato da
Kore o altro provider) ricavando inizio e fine al millisecondo di OGNI SINGOLA
PAROLA. Aggiorna automaticamente:
  1. `subtitles/scene-XX.json` (sottotitoli sincronizzati parola per parola)
  2. `cues[].at` dentro `lesson.json` (basandosi sul campo `anchor`)

Può essere rieseguito infinite volte a costo 0 € ogni volta che aggiungi,
sposti o rifinisci un highlight/cue sulla slide, senza rigenerare mai l'audio.

Esempi:
  python videolezioni/scripts/align_audio.py 10-perceptron
  python videolezioni/scripts/align_audio.py 10-perceptron --scene scene-03
"""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
import wave
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torchaudio

ROOT = Path(__file__).resolve().parent.parent
LESSONS_DIR = ROOT / "lessons"


def strip_tags(text: str) -> str:
    cleaned = re.sub(r"\[[^\]]+\]", " ", text)
    return re.sub(r"\s+", " ", cleaned).strip()


def normalize_for_mms(word: str, vocab: set[str]) -> str:
    """Converte una parola italiana/tecnica nel set di caratteri accettati da MMS_FA."""
    nfkd = unicodedata.normalize("NFKD", word.lower())
    ascii_str = "".join(ch for ch in nfkd if not unicodedata.combining(ch))
    # Conserva lettere base e apostrofo se presente nel vocabolario
    filtered = "".join(ch for ch in ascii_str if ch in vocab)
    return filtered


def normalize_match_token(tok: str) -> str:
    return re.sub(r"[^\wàèéìòùÀÈÉÌÒÙ]", "", tok.lower())


def load_wav_mono(path: Path, target_sr: int) -> tuple[torch.Tensor, float]:
    with wave.open(str(path), "rb") as wf:
        sr = wf.getframerate()
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        raw = wf.readframes(wf.getnframes())

    if sampwidth != 2:
        raise ValueError(f"WAV non 16-bit PCM: {path}")

    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if n_channels > 1:
        samples = samples.reshape(-1, n_channels).mean(axis=1)

    duration = len(samples) / float(sr)
    waveform = torch.from_numpy(samples).unsqueeze(0)
    if sr != target_sr:
        waveform = torchaudio.functional.resample(waveform, sr, target_sr)
    return waveform, duration


class LocalForcedAligner:
    def __init__(self) -> None:
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.bundle = torchaudio.pipelines.MMS_FA
        self.model = self.bundle.get_model(with_star=False).to(self.device)
        self.model.eval()
        self.tokenizer = self.bundle.get_tokenizer()
        self.aligner = self.bundle.get_aligner()
        self.labels = self.bundle.get_labels(star=None)
        self.vocab = {c for c in self.labels if len(c) == 1 and c.isalpha()}

    def align_wav(self, wav_path: Path, tts_text: str) -> tuple[float, list[dict[str, Any]]]:
        clean = strip_tags(tts_text)
        orig_words = clean.split()
        if not orig_words:
            return 0.0, []

        waveform, duration = load_wav_mono(wav_path, self.bundle.sample_rate)

        # Mappa parole originali -> parole normalizzate per MMS_FA
        norm_words: list[str] = []
        valid_indices: list[int] = []
        for idx, w in enumerate(orig_words):
            nw = normalize_for_mms(w, self.vocab)
            if nw:
                norm_words.append(nw)
                valid_indices.append(idx)

        with torch.inference_mode():
            emission, _ = self.model(waveform.to(self.device))
            emission = emission[0].cpu()

        tokens = self.tokenizer(norm_words)
        token_spans = self.aligner(emission, tokens)

        num_frames = emission.size(0)
        ratio = duration / float(max(1, num_frames))

        aligned_map: dict[int, tuple[float, float]] = {}
        for orig_idx, spans in zip(valid_indices, token_spans):
            if spans:
                s = round(spans[0].start * ratio, 3)
                e = round(spans[-1].end * ratio, 3)
                aligned_map[orig_idx] = (s, max(s + 0.04, e))

        # Ricostruisci lista completa preservando anche eventuali token solo simbolici
        words_out: list[dict[str, Any]] = []
        last_end = 0.0
        for idx, w in enumerate(orig_words):
            if idx in aligned_map:
                s, e = aligned_map[idx]
                last_end = e
            else:
                s, e = last_end, min(duration, last_end + 0.15)
                last_end = e
            words_out.append({"text": w, "start": s, "end": e})

        return duration, words_out


def group_words_to_subtitles(words: list[dict[str, Any]], duration: float) -> dict[str, Any]:
    segments: list[dict[str, Any]] = []
    cur: list[dict[str, Any]] = []

    def flush():
        if not cur:
            return
        segments.append({
            "start": cur[0]["start"],
            "end": cur[-1]["end"],
            "text": " ".join(w["text"] for w in cur),
            "words": cur.copy(),
        })
        cur.clear()

    for idx, w in enumerate(words):
        # Spezza anche su pause didattiche lunghe (> 0.55s tra due parole consecutive)
        if cur and (w["start"] - cur[-1]["end"]) >= 0.55 and len(cur) >= 4:
            flush()
        cur.append(w)
        txt = w["text"].strip()
        if txt.endswith((".", "!", "?")) or (txt.endswith((",", ";", ":")) and len(cur) >= 9) or len(cur) >= 15:
            flush()
    flush()

    return {"duration": round(duration, 3), "segments": segments}


def split_match_tokens(text: str) -> list[str]:
    """Spezza anche su apostrofi (es. l'ingresso -> ['l', 'ingresso']) per match 100% robusto."""
    return re.findall(r"[a-z0-9àèéìòù]+", text.lower())


def align_cues_exact(cues: list[dict[str, Any]], words: list[dict[str, Any]], duration: float) -> tuple[int, int]:
    """Aggancia ogni cue al millisecondo esatto della sua frase `anchor`."""
    flat_tokens: list[tuple[str, float]] = []
    for w in words:
        for tok in split_match_tokens(w["text"]):
            flat_tokens.append((tok, w["start"]))
    tok_strs = [t[0] for t in flat_tokens]

    matched = 0
    total_anchored = 0

    for cue in cues:
        anchor = (cue.get("anchor") or "").strip()
        if not anchor:
            continue
        total_anchored += 1
        a_toks = split_match_tokens(anchor)
        if not a_toks:
            continue

        n = len(a_toks)
        found_idx = -1
        for i in range(len(tok_strs) - n + 1):
            if tok_strs[i : i + n] == a_toks:
                found_idx = i
                break

        if found_idx >= 0:
            # Anticipo visivo di 120ms così l'occhio coglie il simbolo mentre la voce inizia
            lead = float(cue.get("lead_sec", 0.12))
            cue["at"] = round(min(max(0.0, duration - 0.15), max(0.0, flat_tokens[found_idx][1] - lead)), 2)
            matched += 1

    return matched, total_anchored


def align_lesson(lesson_slug: str, only_scene: str | None = None) -> None:
    lesson_dir = LESSONS_DIR / lesson_slug
    lesson_json_path = lesson_dir / "lesson.json"
    if not lesson_json_path.exists():
        raise SystemExit(f"File non trovato: {lesson_json_path}")

    lesson = json.loads(lesson_json_path.read_text(encoding="utf-8"))
    scenes = [s for s in lesson["scenes"] if not only_scene or s["id"] == only_scene]
    if not scenes:
        raise SystemExit(f"Scena '{only_scene}' non trovata.")

    print(f"Caricamento modello locale MMS_FA (costo 0 €)...")
    aligner = LocalForcedAligner()

    for idx, scene in enumerate(scenes, start=1):
        sid = scene["id"]
        audio_path = lesson_dir / scene["audio_file"]
        if not audio_path.exists() or audio_path.suffix.lower() != ".wav":
            print(f"  [{idx:02d}/{len(scenes)}] {sid}: saltato (richiede WAV locale, trovato: {scene['audio_file']})")
            continue

        duration, words = aligner.align_wav(audio_path, scene["tts_text"])
        sub_data = group_words_to_subtitles(words, duration)
        sub_path = lesson_dir / scene.get("subtitle_file", f"subtitles/{sid}.json")
        sub_path.parent.mkdir(parents=True, exist_ok=True)
        sub_path.write_text(json.dumps(sub_data, ensure_ascii=False, indent=2), encoding="utf-8")

        m, tot = align_cues_exact(scene.get("cues", []), words, duration)
        scene["duration_sec"] = round(duration, 2)
        print(f"  [{idx:02d}/{len(scenes)}] {sid}: allineato ({duration:.2f}s, {len(words)} parole, {m}/{tot} cues agganciati)")

    lesson_json_path.write_text(json.dumps(lesson, ensure_ascii=False, indent=2), encoding="utf-8")
    print("Allineamento locale completato (0,00 €).")


def main() -> None:
    parser = argparse.ArgumentParser(description="Allinea sottotitoli e cues parola-per-parola sui WAV locali con MMS_FA (0 €).")
    parser.add_argument("lesson", nargs="?", help="Slug della lezione (es. 10-perceptron)")
    parser.add_argument("--scene", default=None, help="Allinea una sola scena (es. scene-03)")
    parser.add_argument("--test-wav", default=None, help="Percorso WAV per self-test rapido")
    parser.add_argument("--test-text", default=None, help="Testo per self-test rapido")
    args = parser.parse_args()

    if args.test_wav and args.test_text:
        aligner = LocalForcedAligner()
        dur, words = aligner.align_wav(Path(args.test_wav), args.test_text)
        print(f"SELF-TEST OK ({dur:.2f}s, {len(words)} parole):")
        for w in words[:12]:
            print(f"  {w['start']:5.2f}s - {w['end']:5.2f}s : {w['text']}")
        return

    if not args.lesson:
        raise SystemExit("Specifica lo slug della lezione (es. 10-perceptron).")
    align_lesson(args.lesson, only_scene=args.scene)


if __name__ == "__main__":
    main()
