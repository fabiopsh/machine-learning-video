// Synchronized dynamic web lesson player
// Handles local MP3 playback, deterministic cue engine, KaTeX math highlights, and word-synced subtitles.

import { renderSlideMath } from "./math.js";

const params = new URLSearchParams(window.location.search);
const LESSON_ID = params.get("id") || "10-perceptron";
const LESSON_BASE = `lessons/${LESSON_ID}`;

const dom = {
  chapTag: document.getElementById("lesson-chap-tag"),
  titleBar: document.getElementById("lesson-title-bar"),
  sidebar: document.getElementById("scene-sidebar"),
  sceneList: document.getElementById("scene-list"),
  stage: document.getElementById("slide-frame"),
  subtitleDock: document.getElementById("subtitle-dock"),
  subtitleBox: document.getElementById("subtitle-box"),
  scrubberWrap: document.getElementById("scrubber-wrap"),
  scrubberTrack: document.getElementById("scrubber-track"),
  scrubberFill: document.getElementById("scrubber-fill"),
  scrubberThumb: document.getElementById("scrubber-thumb"),
  timeReadout: document.getElementById("time-readout"),
  sceneCounter: document.getElementById("scene-counter"),
  btnPlay: document.getElementById("btn-play"),
  btnPrev: document.getElementById("btn-prev"),
  btnNext: document.getElementById("btn-next"),
  btnReplay: document.getElementById("btn-replay"),
  speedSelect: document.getElementById("speed-select"),
  toggleSidebar: document.getElementById("toggle-sidebar"),
  toggleSubtitles: document.getElementById("toggle-subtitles"),
  toggleRevealAll: document.getElementById("toggle-reveal-all"),
  toggleAutoAdvance: document.getElementById("toggle-auto-advance"),
  toggleClean: document.getElementById("toggle-clean"),
  audioNotice: document.getElementById("audio-notice")
};

const audio = new Audio();
audio.preload = "auto";

const state = {
  lesson: null,
  sceneIndex: 0,
  isPlaying: false,
  usingVirtualClock: false,
  virtualTime: 0,
  virtualLastTs: 0,
  duration: 30,
  playbackRate: 1.0,
  revealAll: false,
  autoAdvance: true,
  subtitlesOn: true,
  subtitles: null,
  subtitleCache: new Map(),
  completedScenes: new Set(),
  rafId: null
};

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function estimateSceneDuration(scene) {
  if (typeof scene.duration_sec === "number" && scene.duration_sec > 0) {
    return scene.duration_sec;
  }
  const words = (scene.tts_text || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(12, Math.round((words / 2.45) * 10) / 10);
}

// Fallback proportional subtitle generator if subtitles JSON is unavailable
function buildFallbackSubtitles(ttsText, duration) {
  const clean = (ttsText || "").replace(/\[[^\]]+\]/g, "").trim();
  const sentences = clean.match(/[^.!?]+[.!?]*/g) || [clean];
  const totalChars = Math.max(1, clean.length);
  const segments = [];
  let cursor = 0;
  for (const raw of sentences) {
    const text = raw.trim();
    if (!text) continue;
    const segDur = (text.length / totalChars) * duration;
    const words = text.split(/\s+/).filter(Boolean);
    const wordLenSum = Math.max(1, words.reduce((a, w) => a + w.length, 0));
    const wordObjs = [];
    let wCursor = cursor;
    for (const w of words) {
      const wd = (w.length / wordLenSum) * segDur;
      wordObjs.push({ text: w, start: wCursor, end: wCursor + wd });
      wCursor += wd;
    }
    segments.push({ start: cursor, end: cursor + segDur, text, words: wordObjs });
    cursor += segDur;
  }
  return { duration, segments };
}

async function loadSubtitlesForScene(scene, duration) {
  if (state.subtitleCache.has(scene.id)) {
    return state.subtitleCache.get(scene.id);
  }
  if (scene.subtitle_file) {
    try {
      const res = await fetch(`${LESSON_BASE}/${scene.subtitle_file}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.segments) && data.segments.length > 0) {
          state.subtitleCache.set(scene.id, data);
          return data;
        }
      }
    } catch {
      // fall through to proportional fallback
    }
  }
  const fallback = buildFallbackSubtitles(scene.tts_text, duration);
  return fallback;
}

function getCurrentTime() {
  return state.usingVirtualClock ? state.virtualTime : (audio.currentTime || 0);
}

function setCurrentTime(t) {
  const clamped = Math.max(0, Math.min(state.duration, t));
  if (state.usingVirtualClock) {
    state.virtualTime = clamped;
  } else if (Number.isFinite(audio.duration) && audio.duration > 0) {
    audio.currentTime = Math.min(audio.duration, clamped);
  }
  updateFrame(clamped);
}

function renderSidebar() {
  dom.sceneList.innerHTML = "";
  let lastSection = null;
  state.lesson.scenes.forEach((scene, idx) => {
    if (scene.section && scene.section !== lastSection) {
      const secEl = document.createElement("div");
      secEl.className = "scene-section-label";
      secEl.textContent = scene.section;
      dom.sceneList.appendChild(secEl);
      lastSection = scene.section;
    }
    const btn = document.createElement("button");
    btn.className = "scene-item";
    btn.dataset.index = String(idx);
    const dur = estimateSceneDuration(scene);
    btn.innerHTML = `
      <span class="scene-idx">${String(idx + 1).padStart(2, "0")}</span>
      <span class="scene-item-title">${scene.title}</span>
      <span class="scene-item-dur">${fmtTime(dur)}</span>
    `;
    btn.addEventListener("click", () => loadScene(idx, true));
    dom.sceneList.appendChild(btn);
  });
  updateSidebarActive();
}

function updateSidebarActive() {
  const items = dom.sceneList.querySelectorAll(".scene-item");
  items.forEach((el) => {
    const idx = Number(el.dataset.index);
    el.classList.toggle("active", idx === state.sceneIndex);
    el.classList.toggle("done", state.completedScenes.has(idx) && idx !== state.sceneIndex);
    if (idx === state.sceneIndex) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });
}

function renderCueMarkers(scene) {
  dom.scrubberTrack.querySelectorAll(".cue-marker").forEach((m) => m.remove());
  const dur = Math.max(1, state.duration);
  for (const cue of scene.cues || []) {
    const pct = Math.max(0, Math.min(100, (cue.at / dur) * 100));
    const marker = document.createElement("span");
    marker.className = `cue-marker ${cue.action === "highlight" ? "highlight" : ""}`;
    marker.style.left = `${pct}%`;
    marker.title = `${fmtTime(cue.at)} · ${cue.action} ${cue.target}`;
    dom.scrubberTrack.appendChild(marker);
  }
}

function applyCuesAt(t) {
  const scene = state.lesson.scenes[state.sceneIndex];
  const cues = scene.cues || [];

  // 1. Deterministic visibility for all show targets (supports comma-separated multi-targets)
  const showTargets = new Map();
  for (const cue of cues) {
    if (cue.action === "show") {
      const prev = showTargets.get(cue.target);
      if (prev === undefined || cue.at < prev) {
        showTargets.set(cue.target, cue.at);
      }
    }
  }

  for (const [selector, showAt] of showTargets.entries()) {
    const els = dom.stage.querySelectorAll(selector);
    const visible = state.revealAll || t >= showAt;
    els.forEach((el) => {
      el.classList.toggle("cue-visible", visible);
      el.classList.toggle("cue-hidden", !visible);
    });
  }

  // 2. Active highlights (supports multi-target selectors and optional per-cue duration)
  const hlCues = cues.filter((c) => c.action === "highlight").sort((a, b) => a.at - b.at);
  dom.stage.querySelectorAll(".cue-highlight").forEach((el) => el.classList.remove("cue-highlight"));

  if (!state.revealAll) {
    for (let i = 0; i < hlCues.length; i++) {
      const cue = hlCues[i];
      const next = hlCues[i + 1];
      let endAt;
      if (typeof cue.duration === "number" && cue.duration > 0) {
        endAt = cue.at + cue.duration;
      } else if (next) {
        const gap = next.at - cue.at;
        endAt = gap > 1.2 ? cue.at + Math.min(4.2, gap - 0.08) : cue.at + 2.4;
      } else {
        endAt = cue.at + 4.2;
      }
      if (t >= cue.at && t <= endAt) {
        dom.stage.querySelectorAll(cue.target).forEach((el) => el.classList.add("cue-highlight"));
      }
    }
  }
}

function renderSubtitleAt(t) {
  if (!state.subtitlesOn || !state.subtitles) return;
  const segs = state.subtitles.segments;
  if (!segs || segs.length === 0) {
    dom.subtitleBox.textContent = "";
    return;
  }

  let active = segs.find((s) => t >= s.start - 0.05 && t <= s.end + 0.15);
  if (!active) {
    if (t < segs[0].start) active = segs[0];
    else {
      // pick latest segment whose start <= t
      for (let i = segs.length - 1; i >= 0; i--) {
        if (t >= segs[i].start) {
          active = segs[i];
          break;
        }
      }
    }
  }
  if (!active) return;

  if (Array.isArray(active.words) && active.words.length > 0) {
    const html = active.words
      .map((w) => {
        let cls = "upcoming";
        if (t >= w.end) cls = "past";
        else if (t >= w.start - 0.04) cls = "current";
        return `<span class="subtitle-word ${cls}">${escapeHtml(w.text)}</span>`;
      })
      .join(" ");
    dom.subtitleBox.innerHTML = `<span>${html}</span>`;
  } else {
    dom.subtitleBox.textContent = active.text;
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function updateFrame(t) {
  const dur = Math.max(0.1, state.duration);
  const pct = Math.max(0, Math.min(100, (t / dur) * 100));
  dom.scrubberFill.style.width = `${pct}%`;
  dom.scrubberThumb.style.left = `${pct}%`;
  dom.timeReadout.textContent = `${fmtTime(t)} / ${fmtTime(dur)}`;
  applyCuesAt(t);
  renderSubtitleAt(t);
}

function tick(now) {
  if (!state.isPlaying) return;
  if (state.usingVirtualClock) {
    const dt = ((now - state.virtualLastTs) / 1000) * state.playbackRate;
    state.virtualLastTs = now;
    state.virtualTime += Math.max(0, Math.min(0.25, dt));
    if (state.virtualTime >= state.duration) {
      state.virtualTime = state.duration;
      updateFrame(state.duration);
      onSceneEnded();
      return;
    }
    updateFrame(state.virtualTime);
  } else {
    updateFrame(audio.currentTime || 0);
  }
  state.rafId = requestAnimationFrame(tick);
}

function updatePlayButton() {
  dom.btnPlay.innerHTML = state.isPlaying ? "❚❚ Pausa" : "▶ Riproduci";
}

function play() {
  if (state.isPlaying) return;
  state.isPlaying = true;
  updatePlayButton();
  if (state.usingVirtualClock) {
    if (state.virtualTime >= state.duration - 0.05) state.virtualTime = 0;
    state.virtualLastTs = performance.now();
    state.rafId = requestAnimationFrame(tick);
  } else {
    audio.playbackRate = state.playbackRate;
    const p = audio.play();
    if (p && typeof p.catch === "function") {
      p.catch(() => {
        // Autoplay blocked by browser policy until user interaction
        state.isPlaying = false;
        updatePlayButton();
      });
    }
    state.rafId = requestAnimationFrame(tick);
  }
}

function pause() {
  state.isPlaying = false;
  updatePlayButton();
  if (state.rafId) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
  if (!state.usingVirtualClock) {
    audio.pause();
  }
}

function togglePlay() {
  if (state.isPlaying) pause();
  else play();
}

function onSceneEnded() {
  pause();
  state.completedScenes.add(state.sceneIndex);
  updateSidebarActive();
  if (state.autoAdvance && state.sceneIndex < state.lesson.scenes.length - 1) {
    setTimeout(() => {
      loadScene(state.sceneIndex + 1, true);
    }, 550);
  }
}

async function loadScene(index, autoplay = false) {
  pause();
  const total = state.lesson.scenes.length;
  state.sceneIndex = Math.max(0, Math.min(total - 1, index));
  const scene = state.lesson.scenes[state.sceneIndex];

  // Re-trigger subtle enter animation
  dom.stage.style.animation = "none";
  void dom.stage.offsetWidth;
  dom.stage.style.animation = "";

  dom.stage.innerHTML = scene.slide_html;
  renderSlideMath(dom.stage);

  state.duration = estimateSceneDuration(scene);
  state.virtualTime = 0;
  state.usingVirtualClock = false;
  dom.audioNotice.classList.remove("visible");

  dom.sceneCounter.textContent = `Scena ${state.sceneIndex + 1} / ${total}`;
  dom.btnPrev.disabled = state.sceneIndex === 0;
  dom.btnNext.disabled = state.sceneIndex === total - 1;
  updateSidebarActive();
  renderCueMarkers(scene);

  state.subtitles = await loadSubtitlesForScene(scene, state.duration);
  if (state.subtitles && state.subtitles.duration > 0) {
    state.duration = state.subtitles.duration;
    renderCueMarkers(scene);
  }

  updateFrame(0);

  // Load local pre-generated MP3
  const audioUrl = `${LESSON_BASE}/${scene.audio_file}`;
  audio.src = audioUrl;
  audio.playbackRate = state.playbackRate;
  audio.load();

  audio.onloadedmetadata = () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      state.duration = audio.duration;
      renderCueMarkers(scene);
      updateFrame(audio.currentTime || 0);
    }
  };

  audio.onerror = () => {
    state.usingVirtualClock = true;
    dom.audioNotice.textContent = "Audio MP3 non trovato · modalità timer stimato";
    dom.audioNotice.classList.add("visible");
    if (autoplay) play();
  };

  audio.onended = () => {
    onSceneEnded();
  };

  if (autoplay) {
    play();
  }
}

function setupScrubber() {
  let dragging = false;

  function seekFromEvent(e) {
    const rect = dom.scrubberTrack.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setCurrentTime(ratio * state.duration);
  }

  dom.scrubberWrap.addEventListener("pointerdown", (e) => {
    dragging = true;
    dom.scrubberWrap.setPointerCapture(e.pointerId);
    seekFromEvent(e);
  });

  dom.scrubberWrap.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    seekFromEvent(e);
  });

  dom.scrubberWrap.addEventListener("pointerup", () => {
    dragging = false;
  });
}

function setupControls() {
  dom.btnPlay.addEventListener("click", togglePlay);
  dom.btnPrev.addEventListener("click", () => loadScene(state.sceneIndex - 1, state.isPlaying));
  dom.btnNext.addEventListener("click", () => loadScene(state.sceneIndex + 1, state.isPlaying));
  dom.btnReplay.addEventListener("click", () => {
    setCurrentTime(0);
    play();
  });

  dom.speedSelect.addEventListener("change", () => {
    state.playbackRate = parseFloat(dom.speedSelect.value) || 1.0;
    audio.playbackRate = state.playbackRate;
  });

  dom.toggleSidebar.addEventListener("click", () => {
    const collapsed = dom.sidebar.classList.toggle("collapsed");
    dom.toggleSidebar.classList.toggle("active", !collapsed);
  });

  dom.toggleSubtitles.addEventListener("click", () => {
    state.subtitlesOn = !state.subtitlesOn;
    dom.subtitleDock.classList.toggle("hidden", !state.subtitlesOn);
    dom.toggleSubtitles.classList.toggle("active", state.subtitlesOn);
    if (state.subtitlesOn) renderSubtitleAt(getCurrentTime());
  });

  dom.toggleRevealAll.addEventListener("click", () => {
    state.revealAll = !state.revealAll;
    dom.toggleRevealAll.classList.toggle("active", state.revealAll);
    applyCuesAt(getCurrentTime());
  });

  dom.toggleAutoAdvance.addEventListener("click", () => {
    state.autoAdvance = !state.autoAdvance;
    dom.toggleAutoAdvance.classList.toggle("active", state.autoAdvance);
  });

  dom.toggleClean.addEventListener("click", () => {
    document.body.classList.toggle("clean-mode");
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
    if (e.code === "Space") {
      e.preventDefault();
      togglePlay();
    } else if (e.code === "ArrowRight") {
      e.preventDefault();
      if (e.shiftKey) setCurrentTime(getCurrentTime() + 5);
      else if (state.sceneIndex < state.lesson.scenes.length - 1) loadScene(state.sceneIndex + 1, state.isPlaying);
    } else if (e.code === "ArrowLeft") {
      e.preventDefault();
      if (e.shiftKey) setCurrentTime(getCurrentTime() - 5);
      else if (state.sceneIndex > 0) loadScene(state.sceneIndex - 1, state.isPlaying);
    } else if (e.key.toLowerCase() === "c") {
      dom.toggleSubtitles.click();
    } else if (e.key.toLowerCase() === "s") {
      dom.toggleSidebar.click();
    } else if (e.key.toLowerCase() === "a") {
      dom.toggleRevealAll.click();
    } else if (e.key === "Escape") {
      document.body.classList.remove("clean-mode");
    }
  });
}

async function initPlayer() {
  try {
    const res = await fetch(`${LESSON_BASE}/lesson.json`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.lesson = await res.json();
  } catch (err) {
    dom.stage.innerHTML = `<div class="box box-warn"><div class="box-label">Lezione non disponibile</div><p>Impossibile caricare <code>${LESSON_BASE}/lesson.json</code>. Torna al <a href="index.html" style="text-decoration:underline">catalogo</a> o avvia il server locale.</p></div>`;
    return;
  }

  document.title = `Cap. ${state.lesson.chapter} · ${state.lesson.title} — Machine Learning`;
  dom.chapTag.textContent = `Cap. ${String(state.lesson.chapter).padStart(2, "0")}`;
  dom.titleBar.textContent = state.lesson.title;

  renderSidebar();
  setupScrubber();
  setupControls();
  await loadScene(0, false);

  // Programmatic API for future automated video export (Playwright + ffmpeg)
  window.__LESSON_PLAYER__ = {
    goToScene: (idx) => loadScene(idx, false),
    seek: (sec) => setCurrentTime(sec),
    play,
    pause,
    setCleanMode: (on) => document.body.classList.toggle("clean-mode", Boolean(on)),
    getState: () => ({
      lessonId: state.lesson.lesson_id,
      sceneIndex: state.sceneIndex,
      scenesCount: state.lesson.scenes.length,
      currentTime: getCurrentTime(),
      duration: state.duration,
      isPlaying: state.isPlaying
    })
  };
}

initPlayer();
