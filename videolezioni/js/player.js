// Synchronized dynamic web lesson player
// Handles local WAV/MP3 playback with Range seeking, deterministic cue engine,
// KaTeX formula-atom glow, word-synced teleprompter subtitles, Spotify controls, and auto-hide Clean mode.

import { renderSlideMath } from "./math.js";
import { mountThemeSwitcher, saveSceneProgress, loadProgress } from "./theme.js";
import { LiveSyncEngine } from "./live-sync.js";
import { TutorAvatar, isAvatarAvailable, getSavedAvatarOn } from "./avatar.js";
import { initGlobalSearch, buildLessonSceneUrl } from "./search.js";

const GITHUB_ISSUES_URL = "https://github.com/fabiopsh/machine-learning-video/issues/new";

const params = new URLSearchParams(window.location.search);
const rootEl = document.documentElement;
const ASSET_ROOT = (rootEl.dataset.root || ".").replace(/\/+$/, "");
const IS_CLEAN_PAGE = Boolean(rootEl.dataset.lessonId);
const LESSON_ID = rootEl.dataset.lessonId || params.get("id") || "10-perceptron";
const CATALOG_HREF = IS_CLEAN_PAGE ? `${ASSET_ROOT}/` : "index.html";

function parseInitialScene() {
  const scenaParam = params.get("scena");
  if (scenaParam !== null) {
    const n = parseInt(scenaParam, 10);
    if (Number.isFinite(n) && n >= 1) return n - 1;
  }
  const hashMatch = /^#scena-(\d+)$/i.exec(window.location.hash || "");
  if (hashMatch) {
    const n = parseInt(hashMatch[1], 10);
    if (Number.isFinite(n) && n >= 1) return n - 1;
  }
  const sceneParam = params.get("scene");
  if (sceneParam !== null) {
    const n = parseInt(sceneParam, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

const INITIAL_SCENE = parseInitialScene();
const LESSON_BASE = `${ASSET_ROOT}/lessons/${LESSON_ID}`;

function syncSceneUrl(sceneIdx) {
  try {
    const url = new URL(window.location.href);
    url.hash = "";
    url.searchParams.delete("scene");
    url.searchParams.delete("scena");
    if (!IS_CLEAN_PAGE) {
      url.searchParams.set("id", LESSON_ID);
    } else {
      url.searchParams.delete("id");
    }
    if (sceneIdx > 0) {
      url.searchParams.set("scena", String(sceneIdx + 1));
    }
    window.history.replaceState(null, "", url.pathname + url.search);
  } catch {
    // Ignore history API restrictions in non-standard contexts
  }
}

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
  avatarCard: document.getElementById("tutor-avatar"),
  avatarSprite: document.getElementById("tutor-avatar-sprite"),
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
  toggleAvatar: document.getElementById("toggle-avatar"),
  toggleRevealAll: document.getElementById("toggle-reveal-all"),
  toggleAutoAdvance: document.getElementById("toggle-auto-advance"),
  toggleClean: document.getElementById("toggle-clean"),
  toggleTheater: document.getElementById("toggle-theater"),
  btnSearch: document.getElementById("btn-search"),
  btnShare: document.getElementById("btn-share"),
  btnReportError: document.getElementById("btn-report-error"),
  chapterNextBanner: document.getElementById("chapter-next-banner"),
  chapterNextKicker: document.getElementById("chapter-next-kicker"),
  chapterNextTitle: document.getElementById("chapter-next-title"),
  chapterNextLink: document.getElementById("chapter-next-link"),
  chapterNextCta: document.getElementById("chapter-next-cta"),
  chapterNextDismiss: document.getElementById("chapter-next-dismiss"),
  themeSwitcher: document.getElementById("player-theme-switcher"),
  audioNotice: document.getElementById("audio-notice")
};

const audio = new Audio();
audio.preload = "auto";

const liveSync = new LiveSyncEngine(dom.stage, (sec) => {
  setCurrentTime(sec);
  if (!state.isPlaying) play();
});
dom.stage.__liveSync = liveSync;

const tutorAvatar = new TutorAvatar(dom.avatarCard, dom.avatarSprite, ASSET_ROOT);

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
  lastSubSegIdx: -1,
  lastSubWordSpans: null,
  autoAdvanceTimer: null,
  sceneLoadToken: 0,
  completedScenes: new Set(),
  firstCueAt: 0,
  slideZoom: 1,
  sidebarOpenBeforeTheater: true,
  cleanHideTimer: null,
  cleanPointerHoveringUi: false,
  nextLesson: null,
  isLastChapter: false,
  nextBannerDismissed: false,
  globalSearch: null,
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

function clearAutoAdvanceTimer() {
  if (state.autoAdvanceTimer) {
    clearTimeout(state.autoAdvanceTimer);
    state.autoAdvanceTimer = null;
  }
}

function setCurrentTime(t) {
  clearAutoAdvanceTimer();
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
      <span class="scene-item-title">${escapeHtml(scene.title)}</span>
      <span class="scene-item-dur">${fmtTime(dur)}</span>
    `;
    btn.addEventListener("click", () => {
      loadScene(idx, true);
      if (document.body.classList.contains("theater-mode") || isDrawerViewport()) {
        dom.sidebar.classList.add("collapsed");
        dom.toggleSidebar.classList.remove("active");
      }
    });
    dom.sceneList.appendChild(btn);
  });
  if (state.nextLesson) {
    const nextHref = buildLessonSceneUrl(state.nextLesson.id, 0, ASSET_ROOT, IS_CLEAN_PAGE);
    const chapNum = String(state.nextLesson.chapter).padStart(2, "0");
    const foot = document.createElement("a");
    foot.className = "sidebar-next-chap";
    foot.href = nextHref;
    foot.innerHTML = `
      <span class="sidebar-next-kicker">Capitolo successivo</span>
      <span class="sidebar-next-title">Cap. ${chapNum} · ${escapeHtml(state.nextLesson.title)} →</span>
    `;
    dom.sceneList.appendChild(foot);
  }
  updateSidebarActive();
}

function setChapterNextBannerVisible(show) {
  if (!dom.chapterNextBanner) return;
  const visible = Boolean(show && !state.nextBannerDismissed && (state.nextLesson || state.isLastChapter));
  dom.chapterNextBanner.classList.toggle("visible", visible);
  dom.chapterNextBanner.setAttribute("aria-hidden", visible ? "false" : "true");
  document.body.classList.toggle("next-banner-visible", visible);
}

function configureChapterNextBanner() {
  if (!dom.chapterNextBanner) return;
  if (state.nextLesson) {
    const chapNum = String(state.nextLesson.chapter).padStart(2, "0");
    if (dom.chapterNextKicker) dom.chapterNextKicker.textContent = `Capitolo ${String(state.lesson.chapter).padStart(2, "0")} completato`;
    if (dom.chapterNextTitle) dom.chapterNextTitle.textContent = `Cap. ${chapNum} · ${state.nextLesson.title}`;
    if (dom.chapterNextCta) dom.chapterNextCta.textContent = "Capitolo successivo";
    if (dom.chapterNextLink) dom.chapterNextLink.href = buildLessonSceneUrl(state.nextLesson.id, 0, ASSET_ROOT, IS_CLEAN_PAGE);
  } else if (state.isLastChapter) {
    if (dom.chapterNextKicker) dom.chapterNextKicker.textContent = "Percorso completato ✓";
    if (dom.chapterNextTitle) dom.chapterNextTitle.textContent = "Hai completato tutti i 20 capitoli!";
    if (dom.chapterNextCta) dom.chapterNextCta.textContent = "Torna al catalogo";
    if (dom.chapterNextLink) dom.chapterNextLink.href = CATALOG_HREF;
  }
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
    marker.title = fmtTime(cue.at);
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

  let newlyRevealedEl = null;
  for (const [selector, ranges] of showRanges.entries()) {
    const els = dom.stage.querySelectorAll(selector);
    const visible = state.revealAll || ranges.some((r) => t >= r.start && t < r.end);
    els.forEach((el) => {
      const wasHidden = el.classList.contains("cue-hidden");
      el.classList.toggle("cue-visible", visible);
      el.classList.toggle("cue-hidden", !visible);
      if (visible && wasHidden && !state.revealAll) newlyRevealedEl = el;
    });
  }
  if (newlyRevealedEl && isPhoneViewport()) {
    newlyRevealedEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
    if (state.lastSubSegIdx !== -2) {
      dom.subtitleBox.innerHTML = "";
      state.lastSubSegIdx = -2;
      state.lastSubWordSpans = null;
    }
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
  const hasWords = Array.isArray(active.words) && active.words.length > 0;

  if (activeIdx !== state.lastSubSegIdx) {
    const nextSeg = activeIdx + 1 < segs.length ? segs[activeIdx + 1] : null;

    let curHtml = "";
    if (hasWords) {
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
    state.lastSubSegIdx = activeIdx;
    state.lastSubWordSpans = hasWords ? dom.subtitleBox.querySelectorAll(".sub-current .subtitle-word") : null;
    return;
  }

  if (hasWords && state.lastSubWordSpans) {
    const words = active.words;
    const spans = state.lastSubWordSpans;
    const n = Math.min(words.length, spans.length);
    for (let i = 0; i < n; i++) {
      const w = words[i];
      let cls = "subtitle-word upcoming";
      if (t >= w.end) cls = "subtitle-word past";
      else if (t >= w.start - 0.04) cls = "subtitle-word current";
      if (spans[i].className !== cls) {
        spans[i].className = cls;
      }
    }
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isPhoneViewport() {
  return window.innerWidth <= 680;
}

function isDrawerViewport() {
  return window.innerWidth <= 1024;
}

function fitSlideScale() {
  const card = dom.stage.querySelector(".slide-card");
  if (!card) return 1;

  // On phones (<= 680px), keep crisp 1.0x single-column typography with smooth touch scroll
  if (isPhoneViewport()) {
    card.style.zoom = "";
    state.slideZoom = 1;
    const hdr = card.querySelector(".slide-header-group");
    if (hdr) {
      const frameRect = dom.stage.getBoundingClientRect();
      const hdrRect = hdr.getBoundingClientRect();
      const shiftY = Math.max(0, Math.round((frameRect.height - hdrRect.height) / 2 - (hdrRect.top - frameRect.top)));
      card.style.setProperty("--intro-y", `${Math.min(shiftY, 130)}px`);
    }
    return 1;
  }

  // Freeze transitions & animations during synchronous measurement so intro-stage transform never distorts bounds
  dom.stage.classList.add("measuring-fit");
  const wasIntro = card.classList.contains("intro-stage");
  card.classList.remove("intro-stage");
  card.style.zoom = "1";
  void card.offsetWidth;

  const frameStyle = getComputedStyle(dom.stage);
  const padX = (parseFloat(frameStyle.paddingLeft) || 0) + (parseFloat(frameStyle.paddingRight) || 0);
  const padY = (parseFloat(frameStyle.paddingTop) || 0) + (parseFloat(frameStyle.paddingBottom) || 0);

  const vp = dom.stage.parentElement;
  const vpStyle = vp ? getComputedStyle(vp) : null;
  const vpPadY = vpStyle ? (parseFloat(vpStyle.paddingTop) || 0) + (parseFloat(vpStyle.paddingBottom) || 0) : 0;
  const availW = Math.max(300, dom.stage.clientWidth - padX);
  const availH = vp ? Math.max(340, vp.clientHeight - vpPadY - padY - 12) : Math.max(340, dom.stage.clientHeight - padY - 12);

  // Never narrow logical layout below 660px on desktop (580px on tablet)
  const minLogicalW = window.innerWidth <= 1024 ? 580 : 660;
  const maxByWidth = Math.max(1, availW / minLogicalW);
  const hiCap = Math.min(window.innerWidth <= 1024 ? 1.35 : 1.65, maxByWidth);
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

  // Bi-directional binary search [0.52 .. hiCap]: scales UP when spacious AND DOWN on dense slides -> ZERO scrollbars EVER!
  const minZoom = 0.52;
  let best = minZoom;
  if (fitsAt(hiCap)) {
    best = hiCap;
  } else {
    let lo = minZoom;
    let hi = hiCap;
    for (let i = 0; i < 9; i++) {
      const mid = (lo + hi) / 2;
      if (fitsAt(mid)) {
        best = mid;
        lo = mid;
      } else {
        hi = mid;
      }
    }
  }
  // Keep a gentle 3% safety margin so nothing ever touches frame borders
  best = Math.max(minZoom, Math.floor(best * 0.97 * 100) / 100);

  card.style.zoom = Math.abs(best - 1) > 0.01 ? String(best) : "";
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
  void card.offsetWidth;
  dom.stage.classList.remove("measuring-fit");
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
  if (dom.scrubberWrap) {
    dom.scrubberWrap.setAttribute("aria-valuenow", String(Math.round(pct)));
    dom.scrubberWrap.setAttribute("aria-valuetext", `${fmtTime(t)} di ${fmtTime(dur)}`);
  }
  if (dom.timeCurrent) dom.timeCurrent.textContent = fmtTime(t);
  if (dom.timeTotal) dom.timeTotal.textContent = fmtTime(dur);
  updateIntroStage(t);
  applyCuesAt(t);
  renderSubtitleAt(t);
  liveSync.update(t, state.revealAll);
  tutorAvatar.update(t, state.subtitles, state.isPlaying);
  const isLastScene = state.lesson && state.sceneIndex === state.lesson.scenes.length - 1;
  if (isLastScene && t >= dur - 2.2) {
    setChapterNextBannerVisible(true);
  } else if (!isLastScene || t < dur - 3.5) {
    setChapterNextBannerVisible(false);
  }
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
  clearAutoAdvanceTimer();
  if (state.isPlaying) return;
  state.isPlaying = true;
  updatePlayButton();
  scheduleCleanAutoHide();
  tutorAvatar.onPlayStart(getCurrentTime());

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
  clearAutoAdvanceTimer();
  state.isPlaying = false;
  updatePlayButton();
  tutorAvatar.onPause();
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
  tutorAvatar.onSceneEnded();
  state.completedScenes.add(state.sceneIndex);
  saveSceneProgress(LESSON_ID, state.sceneIndex, true);
  updateSidebarActive();
  if (state.autoAdvance && state.sceneIndex < state.lesson.scenes.length - 1) {
    const endedScene = state.sceneIndex;
    state.autoAdvanceTimer = setTimeout(() => {
      state.autoAdvanceTimer = null;
      if (state.autoAdvance && state.sceneIndex === endedScene && !state.isPlaying) {
        loadScene(state.sceneIndex + 1, true);
      }
    }, 2400);
  } else if (state.sceneIndex === state.lesson.scenes.length - 1) {
    state.nextBannerDismissed = false;
    setChapterNextBannerVisible(true);
  }
}

async function loadScene(index, autoplay = false) {
  const loadToken = ++state.sceneLoadToken;
  pause();
  state.lastSubSegIdx = -1;
  state.lastSubWordSpans = null;
  state.nextBannerDismissed = false;
  setChapterNextBannerVisible(false);
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

  const loadedSubs = await loadSubtitlesForScene(scene, state.duration);
  if (loadToken !== state.sceneLoadToken) return;
  state.subtitles = loadedSubs;
  if (state.subtitles && state.subtitles.duration > 0) {
    state.duration = state.subtitles.duration;
    renderCueMarkers(scene);
  }

  liveSync.prepareScene(scene, state.subtitles);
  fitSlideScale();
  saveSceneProgress(LESSON_ID, state.sceneIndex, false);
  syncSceneUrl(state.sceneIndex);
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
  dom.scrubberWrap.addEventListener("keydown", (e) => {
    if (e.code === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      setCurrentTime(getCurrentTime() + (e.shiftKey ? 10 : 5));
    } else if (e.code === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      setCurrentTime(getCurrentTime() - (e.shiftKey ? 10 : 5));
    } else if (e.code === "Home") {
      e.preventDefault();
      setCurrentTime(0);
    } else if (e.code === "End") {
      e.preventDefault();
      setCurrentTime(state.duration);
    }
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

  const setPressed = (btn, pressed) => {
    if (!btn) return;
    btn.classList.toggle("active", Boolean(pressed));
    btn.setAttribute("aria-pressed", String(Boolean(pressed)));
  };

  dom.toggleSidebar.addEventListener("click", () => {
    const collapsed = dom.sidebar.classList.toggle("collapsed");
    setPressed(dom.toggleSidebar, !collapsed);
    if (!document.body.classList.contains("theater-mode")) {
      setTimeout(() => fitSlideScale(), 260);
    }
  });

  function syncSubtitleAndAvatarDock() {
    const subsOn = state.subtitlesOn;
    const avOn = tutorAvatar.enabled;
    const floating = !subsOn && avOn;
    dom.subtitleDock.classList.toggle("hidden", !subsOn && !avOn);
    dom.subtitleDock.classList.toggle("subs-off-avatar-only", floating);
    document.body.classList.toggle("floating-avatar-active", floating);
    tutorAvatar.setFloatingMode(floating);
    setPressed(dom.toggleAvatar, avOn);
  }

  dom.toggleSubtitles.addEventListener("click", () => {
    state.subtitlesOn = !state.subtitlesOn;
    setPressed(dom.toggleSubtitles, state.subtitlesOn);
    syncSubtitleAndAvatarDock();
    if (state.subtitlesOn) {
      state.lastSubSegIdx = -1;
      renderSubtitleAt(getCurrentTime());
    }
  });

  if (dom.toggleAvatar) {
    dom.toggleAvatar.addEventListener("click", () => {
      tutorAvatar.setEnabled(!tutorAvatar.enabled);
      syncSubtitleAndAvatarDock();
    });
  }

  if (dom.avatarCard) {
    dom.avatarCard.addEventListener("click", () => {
      tutorAvatar.triggerHappy(750);
    });
  }

  const avatarAvailable = isAvatarAvailable();
  if (avatarAvailable) {
    if (dom.toggleAvatar) dom.toggleAvatar.hidden = false;
    tutorAvatar.init(true, getSavedAvatarOn());
    syncSubtitleAndAvatarDock();
  } else {
    if (dom.toggleAvatar) dom.toggleAvatar.hidden = true;
    tutorAvatar.init(false, false);
  }

  dom.toggleRevealAll.addEventListener("click", () => {
    state.revealAll = !state.revealAll;
    setPressed(dom.toggleRevealAll, state.revealAll);
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
      setPressed(dom.toggleSidebar, false);
    } else {
      document.body.classList.remove("theater-mode");
      dom.sidebar.classList.toggle("collapsed", !state.sidebarOpenBeforeTheater);
      setPressed(dom.toggleSidebar, state.sidebarOpenBeforeTheater);
    }
    setPressed(dom.toggleTheater, next);
    recalcIntroOffset();
  }

  function setCleanMode(on) {
    const next = Boolean(on);
    document.body.classList.toggle("clean-mode", next);
    setPressed(dom.toggleClean, next);
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
    if ((document.body.classList.contains("theater-mode") || isDrawerViewport()) && !dom.sidebar.classList.contains("collapsed")) {
      dom.sidebar.classList.add("collapsed");
      setPressed(dom.toggleSidebar, false);
    }
  });

  // Start with sidebar collapsed on tablets and phones so slides use full width immediately
  if (isDrawerViewport()) {
    dom.sidebar.classList.add("collapsed");
    setPressed(dom.toggleSidebar, false);
  }

  dom.toggleAutoAdvance.addEventListener("click", () => {
    state.autoAdvance = !state.autoAdvance;
    setPressed(dom.toggleAutoAdvance, state.autoAdvance);
    if (!state.autoAdvance) clearAutoAdvanceTimer();
  });

  dom.toggleClean.addEventListener("click", () => {
    setCleanMode(!document.body.classList.contains("clean-mode"));
  });

  if (dom.btnExitClean) {
    dom.btnExitClean.addEventListener("click", () => setCleanMode(false));
  }

  if (dom.btnShare) {
    let shareResetTimer = null;
    const origShareHtml = dom.btnShare.innerHTML;
    const origShareTip = dom.btnShare.dataset.tip || "Condividi";
    const ICON_CHECK_SHARE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>`;
    const flashCopied = (label) => {
      dom.btnShare.innerHTML = ICON_CHECK_SHARE;
      dom.btnShare.dataset.tip = label;
      dom.btnShare.title = label;
      dom.btnShare.classList.add("active");
      if (shareResetTimer) clearTimeout(shareResetTimer);
      shareResetTimer = setTimeout(() => {
        dom.btnShare.innerHTML = origShareHtml;
        dom.btnShare.dataset.tip = origShareTip;
        dom.btnShare.title = "Copia link diretto";
        dom.btnShare.classList.remove("active");
      }, 1800);
    };
    dom.btnShare.addEventListener("click", async () => {
      syncSceneUrl(state.sceneIndex);
      const shareUrl = window.location.href;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(shareUrl);
          flashCopied("Link copiato!");
          return;
        }
      } catch {
        // Fallback below
      }
      const ta = document.createElement("textarea");
      ta.value = shareUrl;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        flashCopied("Link copiato!");
      } catch {
        flashCopied("Copia dalla barra");
      } finally {
        ta.remove();
      }
    });
  }

  if (dom.btnReportError) {
    dom.btnReportError.addEventListener("click", () => {
      if (!state.lesson) return;
      syncSceneUrl(state.sceneIndex);
      const scene = state.lesson.scenes[state.sceneIndex];
      const chapStr = String(state.lesson.chapter).padStart(2, "0");
      const sceneNum = state.sceneIndex + 1;
      const totalScenes = state.lesson.scenes.length;
      const ts = fmtTime(getCurrentTime());
      const theme = document.documentElement.dataset.theme || "studio";
      const pageUrl = window.location.href;
      const title = `[Segnalazione] Cap. ${chapStr} · Scena ${sceneNum}/${totalScenes} — ${scene.title} (@ ${ts})`;
      const body = [
        "### Contesto rilevato automaticamente",
        `- **Capitolo**: Cap. ${chapStr} — ${state.lesson.title} (\`${LESSON_ID}\`)`,
        `- **Scena**: ${sceneNum} / ${totalScenes} — ${scene.title}`,
        scene.section ? `- **Sezione**: ${scene.section}` : null,
        `- **Timestamp**: \`${ts}\``,
        `- **Tema attivo**: \`${theme}\``,
        `- **Link diretto**: ${pageUrl}`,
        "",
        "### Tipo di problema",
        "- [ ] Formula / errore matematico",
        "- [ ] Sincronizzazione highlight / sottotitoli",
        "- [ ] Audio / pronuncia",
        "- [ ] Grafico / layout / altro",
        "",
        "### Descrizione",
        "<!-- Descrivi brevemente cosa hai notato -->",
        ""
      ].filter((line) => line !== null).join("\n");
      const issueUrl = `${GITHUB_ISSUES_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
      window.open(issueUrl, "_blank", "noopener,noreferrer");
    });
  }

  if (dom.chapterNextDismiss) {
    dom.chapterNextDismiss.addEventListener("click", () => {
      state.nextBannerDismissed = true;
      setChapterNextBannerVisible(false);
    });
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

  const syncMobileViewportHeight = () => {
    if (isDrawerViewport()) {
      const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
      document.documentElement.style.setProperty("--app-h", `${Math.round(vh)}px`);
    } else {
      document.documentElement.style.removeProperty("--app-h");
    }
  };
  syncMobileViewportHeight();

  let resizeRaf = null;
  const scheduleFit = () => {
    syncMobileViewportHeight();
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      fitSlideScale();
    });
  };
  window.addEventListener("resize", scheduleFit);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", scheduleFit);
  }
  if (typeof ResizeObserver !== "undefined") {
    let lastW = 0;
    let lastH = 0;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (!cr) return;
      const w = Math.round(cr.width);
      const h = Math.round(cr.height);
      if (Math.abs(w - lastW) > 2 || Math.abs(h - lastH) > 2) {
        lastW = w;
        lastH = h;
        scheduleFit();
      }
    });
    ro.observe(dom.stage);
  }

  document.addEventListener("keydown", (e) => {
    if (state.globalSearch && state.globalSearch.isOpen()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
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
    } else if (e.key.toLowerCase() === "v" && dom.toggleAvatar && !dom.toggleAvatar.hidden) {
      dom.toggleAvatar.click();
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
    dom.stage.innerHTML = `<div class="box box-warn"><div class="box-label">Lezione non disponibile</div><p>Impossibile caricare <code>${escapeHtml(LESSON_BASE)}/lesson.json</code>. Torna al <a href="${escapeHtml(CATALOG_HREF)}" style="text-decoration:underline">catalogo</a> o avvia il server locale.</p></div>`;
    return;
  }

  document.title = `Cap. ${state.lesson.chapter} · ${state.lesson.title} — Machine Learning`;
  dom.chapTag.textContent = `Cap. ${String(state.lesson.chapter).padStart(2, "0")}`;
  dom.titleBar.textContent = state.lesson.title;

  // Load manifest to resolve next chapter for end-of-chapter button & sidebar footer
  try {
    const mRes = await fetch(`${ASSET_ROOT}/lessons/manifest.json`, { cache: "no-store" });
    if (mRes.ok) {
      const mData = await mRes.json();
      const ready = (mData.lessons || []).filter((l) => l.status === "ready");
      const curIdx = ready.findIndex((l) => l.id === LESSON_ID);
      if (curIdx >= 0 && curIdx + 1 < ready.length) {
        state.nextLesson = ready[curIdx + 1];
      } else if (curIdx === ready.length - 1 && ready.length > 0) {
        state.isLastChapter = true;
      }
    }
  } catch {
    // Non-blocking fallback
  }
  configureChapterNextBanner();

  state.globalSearch = initGlobalSearch({
    assetRoot: ASSET_ROOT,
    useCleanUrls: IS_CLEAN_PAGE,
    currentLessonId: LESSON_ID,
    onSameLessonJump: (idx) => loadScene(idx, false),
    triggerEls: [dom.btnSearch]
  });

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
