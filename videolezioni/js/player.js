// Synchronized dynamic web lesson player
// Handles local WAV/MP3 playback with Range seeking, deterministic cue engine,
// KaTeX formula-atom glow, word-synced teleprompter subtitles, Spotify controls, and auto-hide Clean mode.

import { renderSlideMath } from "./math.js";
import { mountThemeSwitcher, saveSceneProgress, loadProgress } from "./theme.js";
import { LiveSyncEngine } from "./live-sync.js";

const params = new URLSearchParams(window.location.search);
const LESSON_ID = params.get("id") || "10-perceptron";
const INITIAL_SCENE = Math.max(0, parseInt(params.get("scene") || "0", 10) || 0);
const LESSON_BASE = `lessons/${LESSON_ID}`;

const ICON_PLAY = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11.02-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4.2" height="14" rx="1.2"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2"/></svg>`;

const dom = {
  chapTag: document.getElementById("lesson-chap-tag"),
  titleBar: document.getElementById("lesson-title-bar"),
  sidebar: document.getElementById("scene-sidebar"),
  sceneList: document.getElementById("scene-list"),
  stage: document.getElementById("slide-frame"),
  subtitleDock: document.getElementById("subtitle-dock"),
  subtitleBox: document.getElementById("subtitle-box"),
  controlBar: document.getElementById("control-bar"),
  cleanExitBar: document.getElementById("clean-exit-bar"),
  btnExitClean: document.getElementById("btn-exit-clean"),
  sceneNowBadge: document.getElementById("scene-now-badge"),
  sceneNowTitle: document.getElementById("scene-now-title"),
  scrubberWrap: document.getElementById("scrubber-wrap"),
  scrubberTrack: document.getElementById("scrubber-track"),
  scrubberFill: document.getElementById("scrubber-fill"),
  scrubberThumb: document.getElementById("scrubber-thumb"),
  timeCurrent: document.getElementById("time-current"),
  timeTotal: document.getElementById("time-total"),
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
  toggleTheater: document.getElementById("toggle-theater"),
  themeSwitcher: document.getElementById("player-theme-switcher"),
  audioNotice: document.getElementById("audio-notice")
};

const audio = new Audio();
audio.preload = "auto";

const liveSync = new LiveSyncEngine(dom.stage, (sec) => {
  setCurrentTime(sec);
  if (!state.isPlaying) play();
});

const state = {
  lesson: null,
  sceneIndex: 0,
  isPlaying: false,
  usingVirtualClock: false,
  virtualTime: 0,
  virtualLastTs: 0,
  pendingSeek: null,
  duration: 30,
  playbackRate: 1.0,
  revealAll: false,
  autoAdvance: true,
  subtitlesOn: true,
  subtitles: null,
  subtitleCache: new Map(),
  completedScenes: new Set(),
  firstCueAt: 0,
  slideZoom: 1,
  sidebarOpenBeforeTheater: true,
  cleanHideTimer: null,
  cleanPointerHoveringUi: false,
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
      // fallback below
    }
  }
  return buildFallbackSubtitles(scene.tts_text, duration);
}

function getCurrentTime() {
  if (state.usingVirtualClock) return state.virtualTime;
  if (state.pendingSeek !== null) return state.pendingSeek;
  return audio.currentTime || 0;
}

function applyAudioSeek(target) {
  if (state.usingVirtualClock) {
    state.virtualTime = target;
    state.pendingSeek = null;
    return true;
  }
  if (audio.readyState >= 1 && Number.isFinite(audio.duration) && audio.duration > 0) {
    const safeTarget = Math.max(0, Math.min(audio.duration - 0.02, target));
    try {
      audio.currentTime = safeTarget;
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function setCurrentTime(t) {
  const clamped = Math.max(0, Math.min(state.duration, t));
  if (state.usingVirtualClock) {
    state.virtualTime = clamped;
    state.pendingSeek = null;
  } else {
    state.pendingSeek = clamped;
    applyAudioSeek(clamped);
  }
  updateFrame(clamped);
}

audio.addEventListener("seeked", () => {
  if (state.pendingSeek !== null && Math.abs(audio.currentTime - state.pendingSeek) < 0.6) {
    state.pendingSeek = null;
  }
});

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
    btn.addEventListener("click", () => {
      loadScene(idx, true);
      if (document.body.classList.contains("theater-mode")) {
        dom.sidebar.classList.add("collapsed");
        dom.toggleSidebar.classList.remove("active");
      }
    });
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

  const showRanges = new Map();
  for (const cue of cues) {
    if (cue.action === "show") {
      const start = cue.at;
      const end = typeof cue.until === "number" ? cue.until : Infinity;
      const list = showRanges.get(cue.target);
      if (!list) showRanges.set(cue.target, [{ start, end }]);
      else list.push({ start, end });
    }
  }

  for (const [selector, ranges] of showRanges.entries()) {
    const els = dom.stage.querySelectorAll(selector);
    const visible = state.revealAll || ranges.some((r) => t >= r.start && t < r.end);
    els.forEach((el) => {
      el.classList.toggle("cue-visible", visible);
      el.classList.toggle("cue-hidden", !visible);
    });
  }

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
    dom.subtitleBox.innerHTML = "";
    return;
  }

  let activeIdx = segs.findIndex((s) => t >= s.start - 0.05 && t <= s.end + 0.15);
  if (activeIdx === -1) {
    if (t < segs[0].start) activeIdx = 0;
    else {
      for (let i = segs.length - 1; i >= 0; i--) {
        if (t >= segs[i].start) {
          activeIdx = i;
          break;
        }
      }
    }
  }
  if (activeIdx < 0) return;

  const active = segs[activeIdx];
  const nextSeg = activeIdx + 1 < segs.length ? segs[activeIdx + 1] : null;

  let curHtml = "";
  if (Array.isArray(active.words) && active.words.length > 0) {
    curHtml = active.words
      .map((w) => {
        let cls = "upcoming";
        if (t >= w.end) cls = "past";
        else if (t >= w.start - 0.04) cls = "current";
        return `<span class="subtitle-word ${cls}">${escapeHtml(w.text)}</span>`;
      })
      .join(" ");
  } else {
    curHtml = escapeHtml(active.text);
  }

  const nextHtml = nextSeg
    ? `<div class="sub-line sub-next">${escapeHtml(nextSeg.text)}</div>`
    : `<div class="sub-line sub-next sub-empty"></div>`;

  dom.subtitleBox.innerHTML = `<div class="sub-line sub-current">${curHtml}</div>${nextHtml}`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fitSlideScale() {
  const card = dom.stage.querySelector(".slide-card");
  if (!card) return 1;

  const wasIntro = card.classList.contains("intro-stage");
  card.classList.remove("intro-stage");
  card.style.zoom = "1";

  const frameStyle = getComputedStyle(dom.stage);
  const padX = (parseFloat(frameStyle.paddingLeft) || 0) + (parseFloat(frameStyle.paddingRight) || 0);
  const padY = (parseFloat(frameStyle.paddingTop) || 0) + (parseFloat(frameStyle.paddingBottom) || 0);

  const vp = dom.stage.parentElement;
  const vpStyle = vp ? getComputedStyle(vp) : null;
  const vpPadY = vpStyle ? (parseFloat(vpStyle.paddingTop) || 0) + (parseFloat(vpStyle.paddingBottom) || 0) : 0;
  const availW = Math.max(300, dom.stage.clientWidth - padX);
  const availH = vp ? Math.max(340, vp.clientHeight - vpPadY - padY - 12) : Math.max(340, dom.stage.clientHeight - padY - 12);

  // Never narrow logical layout below 660px (keeps 2-col grids, tables & display equations comfortable)
  const maxByWidth = Math.max(1, availW / 660);
  const hiCap = Math.min(1.65, maxByWidth);
  const overflowWatchEls = Array.from(card.querySelectorAll(".katex-display, .acad-table, .box, .math-card"));

  const fitsAt = (z) => {
    card.style.zoom = String(z);
    const rect = card.getBoundingClientRect();
    if (rect.height > availH || rect.width > availW + 2) return false;
    if (card.scrollWidth > card.clientWidth + 2) return false;
    for (const el of overflowWatchEls) {
      if (el.scrollWidth > el.clientWidth + 3) return false;
    }
    return true;
  };

  let best = 1;
  if (hiCap > 1.03 && fitsAt(1.03)) {
    let lo = 1.0;
    let hi = hiCap;
    for (let i = 0; i < 7; i++) {
      const mid = (lo + hi) / 2;
      if (fitsAt(mid)) {
        best = mid;
        lo = mid;
      } else {
        hi = mid;
      }
    }
    // Keep a gentle 3% safety margin so nothing ever touches frame borders
    best = Math.max(1, Math.floor(best * 0.97 * 100) / 100);
  }

  card.style.zoom = best > 1.01 ? String(best) : "";
  state.slideZoom = best;

  // Measure centered intro title vertical offset accounting for active zoom
  const hdr = card.querySelector(".slide-header-group");
  if (hdr) {
    const frameRect = dom.stage.getBoundingClientRect();
    const hdrRect = hdr.getBoundingClientRect();
    const shiftY = Math.max(
      0,
      Math.round(((frameRect.height - hdrRect.height) / 2 - (hdrRect.top - frameRect.top)) / best)
    );
    card.style.setProperty("--intro-y", `${shiftY}px`);
  }

  if (wasIntro) card.classList.add("intro-stage");
  return best;
}

function updateIntroStage(t) {
  const card = dom.stage.querySelector(".slide-card");
  if (!card) return;
  const threshold = state.firstCueAt - 0.4;
  const inIntro = !state.revealAll && state.firstCueAt >= 1.8 && t < threshold;
  card.classList.toggle("intro-stage", inIntro);
  if (inIntro && threshold > 0.1) {
    const pct = Math.max(4, Math.min(100, (t / threshold) * 100));
    card.style.setProperty("--intro-pct", `${pct.toFixed(1)}%`);
  }
}

function updateFrame(t) {
  const dur = Math.max(0.1, state.duration);
  const pct = Math.max(0, Math.min(100, (t / dur) * 100));
  dom.scrubberFill.style.width = `${pct}%`;
  dom.scrubberThumb.style.left = `${pct}%`;
  if (dom.timeCurrent) dom.timeCurrent.textContent = fmtTime(t);
  if (dom.timeTotal) dom.timeTotal.textContent = fmtTime(dur);
  updateIntroStage(t);
  applyCuesAt(t);
  renderSubtitleAt(t);
  liveSync.update(t, state.revealAll);
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
    // While audio is seeking to pendingSeek, avoid flashing 00:00
    const t = state.pendingSeek !== null && audio.seeking ? state.pendingSeek : (audio.currentTime || 0);
    if (state.pendingSeek !== null && !audio.seeking && Math.abs(audio.currentTime - state.pendingSeek) < 0.6) {
      state.pendingSeek = null;
    }
    updateFrame(t);
  }
  state.rafId = requestAnimationFrame(tick);
}

function updatePlayButton() {
  dom.btnPlay.innerHTML = state.isPlaying ? ICON_PAUSE : ICON_PLAY;
  dom.btnPlay.setAttribute("aria-label", state.isPlaying ? "Pausa" : "Riproduci");
  dom.btnPlay.title = state.isPlaying ? "Pausa (Spazio)" : "Riproduci (Spazio)";
}

function scheduleCleanAutoHide() {
  if (state.cleanHideTimer) {
    clearTimeout(state.cleanHideTimer);
    state.cleanHideTimer = null;
  }
  if (!document.body.classList.contains("clean-mode")) return;
  // Keep controls visible while paused or while hovering the dock/exit pill
  if (!state.isPlaying || state.cleanPointerHoveringUi) {
    document.body.classList.add("clean-ui-visible");
    return;
  }
  state.cleanHideTimer = setTimeout(() => {
    if (document.body.classList.contains("clean-mode") && state.isPlaying && !state.cleanPointerHoveringUi) {
      document.body.classList.remove("clean-ui-visible");
    }
  }, 2200);
}

function revealCleanUiTemporarily() {
  if (!document.body.classList.contains("clean-mode")) return;
  document.body.classList.add("clean-ui-visible");
  scheduleCleanAutoHide();
}

function play() {
  if (state.isPlaying) return;
  state.isPlaying = true;
  updatePlayButton();
  scheduleCleanAutoHide();

  if (state.usingVirtualClock) {
    if (state.virtualTime >= state.duration - 0.05) state.virtualTime = 0;
    state.virtualLastTs = performance.now();
    state.rafId = requestAnimationFrame(tick);
    return;
  }

  audio.playbackRate = state.playbackRate;
  const targetSeek = state.pendingSeek;
  if (targetSeek !== null) {
    applyAudioSeek(targetSeek);
  }

  const p = audio.play();
  if (p && typeof p.then === "function") {
    p.then(() => {
      // Enforce pending seek if browser initialized audio at 0 on first play()
      if (state.pendingSeek !== null && Number.isFinite(audio.duration) && audio.duration > 0) {
        if (Math.abs(audio.currentTime - state.pendingSeek) > 0.35) {
          applyAudioSeek(state.pendingSeek);
        } else {
          state.pendingSeek = null;
        }
      }
    }).catch(() => {
      state.isPlaying = false;
      updatePlayButton();
      scheduleCleanAutoHide();
    });
  }
  state.rafId = requestAnimationFrame(tick);
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
  scheduleCleanAutoHide();
}

function togglePlay() {
  if (state.isPlaying) pause();
  else play();
}

function onSceneEnded() {
  pause();
  state.completedScenes.add(state.sceneIndex);
  saveSceneProgress(LESSON_ID, state.sceneIndex, true);
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

  dom.stage.style.animation = "none";
  void dom.stage.offsetWidth;
  dom.stage.style.animation = "";

  dom.stage.innerHTML = scene.slide_html;
  renderSlideMath(dom.stage);

  // Wrap kicker + slide title for centered intro stage
  const slideCard = dom.stage.querySelector(".slide-card");
  if (slideCard) {
    const kicker = slideCard.querySelector(":scope > .slide-kicker");
    const title = slideCard.querySelector(":scope > .slide-title");
    if (kicker && title) {
      const hdr = document.createElement("div");
      hdr.className = "slide-header-group";
      const line = document.createElement("div");
      line.className = "intro-accent-line";
      line.innerHTML = `<span class="intro-accent-fill"></span>`;
      slideCard.insertBefore(hdr, kicker);
      hdr.appendChild(kicker);
      hdr.appendChild(title);
      hdr.appendChild(line);
    }
  }

  fitSlideScale();

  const showTimes = (scene.cues || []).filter((c) => c.action === "show").map((c) => c.at);
  state.firstCueAt = showTimes.length > 0 ? Math.min(...showTimes) : 0;

  state.duration = estimateSceneDuration(scene);
  state.virtualTime = 0;
  state.pendingSeek = null;
  state.usingVirtualClock = false;
  dom.audioNotice.classList.remove("visible");

  const idxStr = String(state.sceneIndex + 1).padStart(2, "0");
  const totStr = String(total).padStart(2, "0");
  dom.sceneCounter.textContent = `Scena ${state.sceneIndex + 1} / ${total}`;
  if (dom.sceneNowBadge) dom.sceneNowBadge.textContent = `${idxStr} / ${totStr}`;
  if (dom.sceneNowTitle) dom.sceneNowTitle.textContent = scene.title;

  dom.btnPrev.disabled = state.sceneIndex === 0;
  dom.btnNext.disabled = state.sceneIndex === total - 1;
  updateSidebarActive();
  renderCueMarkers(scene);

  state.subtitles = await loadSubtitlesForScene(scene, state.duration);
  if (state.subtitles && state.subtitles.duration > 0) {
    state.duration = state.subtitles.duration;
    renderCueMarkers(scene);
  }

  liveSync.prepareScene(scene, state.subtitles);
  saveSceneProgress(LESSON_ID, state.sceneIndex, false);
  updateFrame(0);

  const audioUrl = `${LESSON_BASE}/${scene.audio_file}`;
  audio.src = audioUrl;
  audio.playbackRate = state.playbackRate;
  audio.load();

  audio.onloadedmetadata = () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      state.duration = audio.duration;
      renderCueMarkers(scene);
      if (state.pendingSeek !== null) {
        const target = state.pendingSeek;
        applyAudioSeek(target);
        updateFrame(target);
      } else {
        updateFrame(audio.currentTime || 0);
      }
    }
  };

  audio.onerror = () => {
    state.usingVirtualClock = true;
    dom.audioNotice.textContent = "Audio non trovato · timer stimato";
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
    dom.scrubberWrap.classList.add("dragging");
    dom.scrubberWrap.setPointerCapture(e.pointerId);
    seekFromEvent(e);
  });

  dom.scrubberWrap.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    seekFromEvent(e);
  });

  const endDrag = () => {
    dragging = false;
    dom.scrubberWrap.classList.remove("dragging");
  };

  dom.scrubberWrap.addEventListener("pointerup", endDrag);
  dom.scrubberWrap.addEventListener("pointercancel", endDrag);
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
    if (!document.body.classList.contains("theater-mode")) {
      setTimeout(() => fitSlideScale(), 260);
    }
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
    dom.stage.classList.toggle("reveal-all-active", state.revealAll);
    updateIntroStage(getCurrentTime());
    applyCuesAt(getCurrentTime());
    liveSync.update(getCurrentTime(), state.revealAll);
    requestAnimationFrame(() => fitSlideScale());
  });

  function recalcIntroOffset() {
    requestAnimationFrame(() => fitSlideScale());
  }

  function setTheaterMode(on) {
    const currentlyOn = document.body.classList.contains("theater-mode");
    const next = Boolean(on);
    if (next === currentlyOn) return;
    if (next) {
      state.sidebarOpenBeforeTheater = !dom.sidebar.classList.contains("collapsed");
      document.body.classList.add("theater-mode");
      dom.sidebar.classList.add("collapsed");
      dom.toggleSidebar.classList.remove("active");
    } else {
      document.body.classList.remove("theater-mode");
      dom.sidebar.classList.toggle("collapsed", !state.sidebarOpenBeforeTheater);
      dom.toggleSidebar.classList.toggle("active", state.sidebarOpenBeforeTheater);
    }
    if (dom.toggleTheater) dom.toggleTheater.classList.toggle("active", next);
    recalcIntroOffset();
  }

  function setCleanMode(on) {
    const next = Boolean(on);
    document.body.classList.toggle("clean-mode", next);
    dom.toggleClean.classList.toggle("active", next);
    if (dom.cleanExitBar) dom.cleanExitBar.setAttribute("aria-hidden", next ? "false" : "true");
    if (next) {
      document.body.classList.add("clean-ui-visible");
      scheduleCleanAutoHide();
    } else {
      document.body.classList.remove("clean-ui-visible");
      if (state.cleanHideTimer) {
        clearTimeout(state.cleanHideTimer);
        state.cleanHideTimer = null;
      }
    }
    recalcIntroOffset();
  }

  if (dom.toggleTheater) {
    dom.toggleTheater.addEventListener("click", () => {
      setTheaterMode(!document.body.classList.contains("theater-mode"));
    });
  }

  dom.stage.closest(".stage-column")?.addEventListener("pointerdown", () => {
    if (document.body.classList.contains("theater-mode") && !dom.sidebar.classList.contains("collapsed")) {
      dom.sidebar.classList.add("collapsed");
      dom.toggleSidebar.classList.remove("active");
    }
  });

  dom.toggleAutoAdvance.addEventListener("click", () => {
    state.autoAdvance = !state.autoAdvance;
    dom.toggleAutoAdvance.classList.toggle("active", state.autoAdvance);
  });

  dom.toggleClean.addEventListener("click", () => {
    setCleanMode(!document.body.classList.contains("clean-mode"));
  });

  if (dom.btnExitClean) {
    dom.btnExitClean.addEventListener("click", () => setCleanMode(false));
  }

  // Reveal floating controls on pointer movement in Clean Mode
  document.addEventListener("pointermove", revealCleanUiTemporarily, { passive: true });
  for (const el of [dom.controlBar, dom.cleanExitBar]) {
    if (!el) continue;
    el.addEventListener("pointerenter", () => {
      state.cleanPointerHoveringUi = true;
      revealCleanUiTemporarily();
    });
    el.addEventListener("pointerleave", () => {
      state.cleanPointerHoveringUi = false;
      scheduleCleanAutoHide();
    });
  }

  let resizeRaf = null;
  window.addEventListener("resize", () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      recalcIntroOffset();
    });
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
    } else if (e.key.toLowerCase() === "t" && dom.toggleTheater) {
      dom.toggleTheater.click();
    } else if (e.key === "Escape") {
      setCleanMode(false);
      setTheaterMode(false);
    }
  });

  window.__SET_CLEAN_MODE__ = setCleanMode;
}

async function initPlayer() {
  mountThemeSwitcher(dom.themeSwitcher);
  const saved = loadProgress();
  if (Array.isArray(saved.watched?.[LESSON_ID])) {
    saved.watched[LESSON_ID].forEach((i) => state.completedScenes.add(i));
  }

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
  await loadScene(INITIAL_SCENE, false);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => fitSlideScale());
  }

  window.__LESSON_PLAYER__ = {
    goToScene: (idx) => loadScene(idx, false),
    seek: (sec) => setCurrentTime(sec),
    play,
    pause,
    setCleanMode: (on) => window.__SET_CLEAN_MODE__?.(on),
    getState: () => ({
      lessonId: state.lesson.lesson_id,
      sceneIndex: state.sceneIndex,
      scenesCount: state.lesson.scenes.length,
      currentTime: getCurrentTime(),
      audioCurrentTime: audio.currentTime || 0,
      duration: state.duration,
      slideZoom: state.slideZoom,
      isPlaying: state.isPlaying
    })
  };
}

initPlayer();
