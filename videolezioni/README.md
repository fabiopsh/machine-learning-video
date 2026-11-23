# Machine Learning (654AA) — Videolezioni Web Dinamiche

Piattaforma web statica e modulare per videolezioni sincronizzate con audio locale pre-generato, formule matematiche KaTeX con evidenziazione dei passaggi, grafici SVG e sottotitoli sincronizzati parola per parola.

## Avvio rapido

```powershell
python videolezioni/scripts/serve.py
```

Apri nel browser: `http://127.0.0.1:8080/`

## Struttura

```text
videolezioni/
├── index.html                    # Catalogo dei 20 capitoli divisi per Parti
├── lesson.html                   # Player sincronizzato (?id=10-perceptron)
├── css/styles.css                # Design system accademico (coerente con preambolo.tex)
├── js/
│   ├── catalog.js                # Caricamento catalogo da lessons/manifest.json
│   ├── player.js                 # Motore audio + cues + sottotitoli + API export
│   └── math.js                   # KaTeX con macro del corso (\x, \w, \net, \sign, ...)
├── scripts/
│   ├── generate_audio.py         # Genera MP3 e sottotitoli una sola volta in locale
│   └── serve.py                  # Server HTTP locale
└── lessons/
    ├── manifest.json             # Indice di tutti i 20 capitoli (00-guida ... 19-grafi)
    ├── 10-perceptron/
    │   ├── lesson.json           # Copione, slide HTML/SVG/KaTeX e cues sincronizzati
    │   ├── audio/scene-XX.mp3    # Audio MP3 locale pre-generato
    │   └── subtitles/scene-XX.json # Timestamp esatti parola per parola
    └── <altri-capitoli>/         # Cartelle predisposte con audio/ e subtitles/
```

## Generazione audio una tantum (Batch-and-Splice + `MMS_FA`)

L'audio non viene mai generato all'apertura della pagina: si produce **una sola volta** in locale.

### Workflow consigliato — `Kore` (`gemini-3.8-flash-tts`, ~8-9 RPD per capitolo)
Unisce 2–3 scene per chiamata API, estrae il PCM puro, separa le scene e inserisce le pause `[pause:X]` in locale con `MMS_FA` (0,00 €), tracciando il budget in `videolezioni/.budget_usage.json` (tetto globale `4.80 €`):

```powershell
# 1. Stima RPD e costo a 0 €
python videolezioni/scripts/generate_batch.py 10-perceptron --all-missing --dry-run

# 2. Genera tutte le scene mancanti in batch + taglio e allineamento word-level
python videolezioni/scripts/generate_batch.py 10-perceptron --all-missing --max-run-eur 0.45

# 3. Se modifichi solo slide/cues/highlight dopo la generazione (0 €, 0 RPD):
python videolezioni/scripts/align_audio.py 10-perceptron
```

### Alternative gratuite senza API key
- **Edge Neural (`Elsa`)**: `python videolezioni/scripts/generate_audio.py 10-perceptron --provider edge --voice it-IT-ElsaNeural --force`
- **Google `gTTS`**: `python videolezioni/scripts/generate_audio.py 10-perceptron --provider gtts --force`

## Comandi da tastiera nel player

- `Spazio`: Riproduci / Pausa
- `←` / `→`: Scena precedente / successiva (`Shift` + freccia: ±5 secondi)
- `C`: Mostra / nascondi sottotitoli sincronizzati
- `S`: Mostra / nascondi indice delle scene
- `A`: Mostra tutta la slide (modalità studio statico)
- `Esc`: Esci dalla modalità pulita (predisposta per export video futuro)
