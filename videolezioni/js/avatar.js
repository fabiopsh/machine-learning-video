// Pixel-Art Tutor Avatar ("Lia") — Deterministic Phonetic Lip-Sync & Expressions
// Drives a 6-frame horizontal spritesheet (idle, blink, speak_mid, speak_open, speak_round, happy)
// directly from word_timings (zero Web Audio API / iOS Safari compatibility risk).

const AVATAR_KEY = "ml_videolezioni_avatar_v1";

const FRAME_IDLE = 0;
const FRAME_BLINK = 1;
const FRAME_MID = 2;
const FRAME_OPEN = 3;
const FRAME_ROUND = 4;
const FRAME_HAPPY = 5;

const HAPPY_WORDS = new Set([
  "benvenuti", "benvenuto", "esatto", "perfetto", "chiaro", "chiara",
  "intuitivo", "intuitiva", "semplice", "vediamo", "ecco", "chiave",
  "funziona", "esempio", "ricorda", "ricordiamo", "ottimo", "concludiamo",
  "pronti", "pronto", "facile", "bellissimo", "elegante", "sorprendente"
]);

export function isAvatarAvailable() {
  try {
    const p = new URLSearchParams(window.location.search);
    if (p.get("avatar") === "0") return false;
  } catch {}
  return true;
}

export function getSavedAvatarOn() {
  try {
    const v = localStorage.getItem(AVATAR_KEY);
    if (v === "0") return false;
    if (v === "1") return true;
  } catch {}
  return true;
}

export function saveAvatarOn(on) {
  try {
    localStorage.setItem(AVATAR_KEY, on ? "1" : "0");
  } catch {}
}

function normalizeWord(w) {
  return (w || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

// Build syllable-paced mouth viseme sequence from an Italian word
function wordToVisemes(rawWord) {
  const clean = normalizeWord(rawWord);
  if (!clean) return [FRAME_MID];

  const seq = [];
  let i = 0;
  while (i < clean.length) {
    const ch = clean[i];
    if (ch === "a" || ch === "e") {
      seq.push(FRAME_OPEN);
      while (i + 1 < clean.length && (clean[i + 1] === "a" || clean[i + 1] === "e")) i++;
    } else if (ch === "o" || ch === "u") {
      seq.push(FRAME_ROUND);
      while (i + 1 < clean.length && (clean[i + 1] === "o" || clean[i + 1] === "u")) i++;
    } else if (ch === "i" || ch === "y") {
      seq.push(FRAME_MID);
      while (i + 1 < clean.length && (clean[i + 1] === "i" || clean[i + 1] === "y")) i++;
    } else {
      // Consonant cluster between vowels: brief mid-lip articulation
      if (seq.length > 0 && seq[seq.length - 1] !== FRAME_MID) {
        seq.push(FRAME_MID);
      }
      while (i + 1 < clean.length && !"aeiouy".includes(clean[i + 1])) i++;
    }
    i++;
  }
  return seq.length ? seq : [FRAME_MID];
}

function findActiveWord(subtitles, t) {
  if (!subtitles || !Array.isArray(subtitles.segments)) return null;
  const segs = subtitles.segments;
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s];
    if (t < seg.start - 0.05 || t > seg.end + 0.08) continue;
    const words = seg.words || [];
    for (let j = 0; j < words.length; j++) {
      const w = words[j];
      if (t >= w.start - 0.015 && t <= w.end + 0.025) {
        return w;
      }
    }
  }
  return null;
}

export class TutorAvatar {
  constructor(cardEl, spriteEl, assetRoot) {
    this.cardEl = cardEl;
    this.spriteEl = spriteEl;
    this.enabled = false;
    this.available = false;
    this.currentFrame = FRAME_IDLE;
    this.lastFrameSwitchTs = 0;
    this.isPlaying = false;

    // Natural blink timer
    this.nextBlinkTs = performance.now() + 2600 + Math.random() * 2200;
    this.blinkEndTs = 0;

    // Warm smile / emphasis window
    this.happyUntilTs = 0;
    this.lastHappyWordKey = "";
    this.lastHappyTriggerTs = 0;

    // Cache viseme arrays per word string
    this.visemeCache = new Map();
    this.idleTimerId = null;

    if (this.spriteEl) {
      this.spriteEl.style.backgroundImage = `url("${assetRoot}/assets/lia-spritesheet.png")`;
    }
  }

  init(available, initiallyOn) {
    this.available = Boolean(available);
    this.enabled = this.available && Boolean(initiallyOn);
    this._syncVisibility();
    if (this.enabled) this._startIdleLoop();
  }

  setEnabled(on) {
    if (!this.available) return;
    this.enabled = Boolean(on);
    saveAvatarOn(this.enabled);
    this._syncVisibility();
    if (this.enabled) {
      this.triggerHappy(420);
      this._startIdleLoop();
    }
  }

  setFloatingMode(floating) {
    if (!this.cardEl) return;
    this.cardEl.classList.toggle("avatar-floating", Boolean(floating));
  }

  triggerHappy(durationMs = 600) {
    const now = performance.now();
    this.happyUntilTs = Math.max(this.happyUntilTs, now + durationMs);
  }

  onPlayStart(t) {
    this.isPlaying = true;
    if (t < 0.8) {
      this.triggerHappy(520);
    }
  }

  onPause() {
    this.isPlaying = false;
    if (this.cardEl) {
      this.cardEl.classList.remove("is-speaking", "is-happy");
    }
    this._setFrame(FRAME_IDLE, true);
  }

  onSceneEnded() {
    this.isPlaying = false;
    if (this.cardEl) {
      this.cardEl.classList.remove("is-speaking");
    }
    this.triggerHappy(950);
    this._setFrame(FRAME_HAPPY, true);
  }

  update(t, subtitles, isPlaying) {
    this.isPlaying = Boolean(isPlaying);
    if (!this.enabled || !this.cardEl || !this.spriteEl) return;

    const now = performance.now();
    const activeWord = isPlaying ? findActiveWord(subtitles, t) : null;
    const speaking = Boolean(activeWord);

    this.cardEl.classList.toggle("is-speaking", speaking);

    // Check encouraging/insight word for natural warm smile (throttled every >= 9s)
    const wordStr = activeWord ? (activeWord.text || activeWord.word || "") : "";
    if (activeWord && wordStr) {
      const norm = normalizeWord(wordStr);
      const wordKey = `${activeWord.start.toFixed(2)}:${norm}`;
      if (
        HAPPY_WORDS.has(norm) &&
        wordKey !== this.lastHappyWordKey &&
        now - this.lastHappyTriggerTs > 9000
      ) {
        this.lastHappyWordKey = wordKey;
        this.lastHappyTriggerTs = now;
        this.happyUntilTs = now + 540;
      }
    }

    // Handle natural blinking when not actively wide-open
    if (now >= this.nextBlinkTs && this.blinkEndTs === 0) {
      this.blinkEndTs = now + 135;
      this.nextBlinkTs = now + 3100 + Math.random() * 2500;
    }
    const blinking = now < this.blinkEndTs;
    if (!blinking && this.blinkEndTs > 0) {
      this.blinkEndTs = 0;
    }

    const happy = now < this.happyUntilTs;
    this.cardEl.classList.toggle("is-happy", happy);

    // Choose target frame with natural priority
    let target = FRAME_IDLE;
    if (speaking) {
      const raw = wordStr;
      let visemes = this.visemeCache.get(raw);
      if (!visemes) {
        visemes = wordToVisemes(raw);
        this.visemeCache.set(raw, visemes);
      }
      const dur = Math.max(0.06, activeWord.end - activeWord.start);
      const prog = Math.max(0, Math.min(0.999, (t - activeWord.start) / dur));
      const idx = Math.floor(prog * visemes.length);
      target = visemes[idx] ?? FRAME_MID;

      // On the tail end of a happy cue word, blend in warm happy smile
      if (happy && prog > 0.55) {
        target = FRAME_HAPPY;
      } else if (blinking && target === FRAME_MID) {
        target = FRAME_BLINK;
      }
    } else if (happy) {
      target = FRAME_HAPPY;
    } else if (blinking) {
      target = FRAME_BLINK;
    } else {
      target = FRAME_IDLE;
    }

    this._setFrame(target, false);
  }

  _setFrame(frameIdx, force) {
    if (!this.spriteEl) return;
    const now = performance.now();
    // Calm, articulate 16-bit cadence (~10 fps max) so mouth motion never feels frantic
    const minHold = (frameIdx === FRAME_BLINK || frameIdx === FRAME_IDLE) ? 55 : 95;
    if (!force && frameIdx !== this.currentFrame && now - this.lastFrameSwitchTs < minHold) {
      return;
    }
    if (frameIdx === this.currentFrame) return;
    this.currentFrame = frameIdx;
    this.lastFrameSwitchTs = now;
    // 6-frame horizontal spritesheet: background-size 600% 100%, step = 20% per frame (0%, 20%, 40%, 60%, 80%, 100%)
    this.spriteEl.style.backgroundPosition = `${frameIdx * 20}% 0%`;
  }

  _syncVisibility() {
    if (!this.cardEl) return;
    this.cardEl.classList.toggle("avatar-hidden", !this.enabled);
  }

  _startIdleLoop() {
    if (this.idleTimerId) return;
    const step = () => {
      if (!this.enabled) {
        this.idleTimerId = null;
        return;
      }
      if (!document.hidden && !this.isPlaying) {
        const now = performance.now();
        if (now >= this.nextBlinkTs && this.blinkEndTs === 0) {
          this.blinkEndTs = now + 135;
          this.nextBlinkTs = now + 3200 + Math.random() * 2600;
        }
        const blinking = now < this.blinkEndTs;
        if (!blinking && this.blinkEndTs > 0) this.blinkEndTs = 0;
        const happy = now < this.happyUntilTs;
        if (this.cardEl) this.cardEl.classList.toggle("is-happy", happy);
        this._setFrame(happy ? FRAME_HAPPY : (blinking ? FRAME_BLINK : FRAME_IDLE), true);
      }
      this.idleTimerId = setTimeout(step, document.hidden ? 600 : 90);
    };
    this.idleTimerId = setTimeout(step, 120);
  }
}
