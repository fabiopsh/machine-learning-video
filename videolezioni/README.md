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

## Generazione audio una tantum

L'audio non viene mai generato all'apertura della pagina: si produce **una sola volta** con `generate_audio.py` e rimane in locale nella cartella della lezione.

### 1. Voce neurale senza chiave API (default, consigliata subito)
Usa `edge-tts` (`it-IT-GiuseppeMultilingualNeural`, oppure `it-IT-ElsaNeural` / `it-IT-DiegoNeural`): alta qualità, pronuncia bene anche termini inglesi ML e produce **timestamp esatti parola per parola** per sottotitoli e cues.

```powershell
python videolezioni/scripts/generate_audio.py 10-perceptron
```

### 2. Google TTS senza chiave API (`gTTS`)
Usa il servizio Google Translate TTS senza alcuna chiave API, salvando MP3 locali e calibrando i tempi sulla durata reale:

```powershell
python videolezioni/scripts/generate_audio.py 10-perceptron --provider gtts --force
```

### 3. Google Gemini API TTS (quando avrai una `GEMINI_API_KEY`)
Voce espressiva Google AI Studio (`gemini-2.5-flash-preview-tts`, voce `Kore` / `Orus`):

```powershell
pip install google-genai
$env:GEMINI_API_KEY="la-tua-chiave"
python videolezioni/scripts/generate_audio.py 10-perceptron --provider gemini --voice Kore --force
```

## Comandi da tastiera nel player

- `Spazio`: Riproduci / Pausa
- `←` / `→`: Scena precedente / successiva (`Shift` + freccia: ±5 secondi)
- `C`: Mostra / nascondi sottotitoli sincronizzati
- `S`: Mostra / nascondi indice delle scene
- `A`: Mostra tutta la slide (modalità studio statico)
- `Esc`: Esci dalla modalità pulita (predisposta per export video futuro)
