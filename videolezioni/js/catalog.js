// Dual-view Catalog Hub (Interactive Course Map + Editorial Bento Grid)
// Features: live Theme Switcher, Resume Hero banner, local study progress, instant search & filters.

import { mountThemeSwitcher, loadProgress, chapterMiniSvg } from "./theme.js";

const VIEW_KEY = "ml_videolezioni_catalog_view_v1";
const USE_CLEAN_URLS = document.documentElement.dataset.cleanUrls === "true";

function lessonUrl(id, sceneIdx = 0) {
  const safeId = encodeURIComponent(id);
  if (USE_CLEAN_URLS) {
    return sceneIdx > 0 ? `${safeId}/?scena=${sceneIdx + 1}` : `${safeId}/`;
  }
  return sceneIdx > 0 ? `lesson.html?id=${safeId}&scena=${sceneIdx + 1}` : `lesson.html?id=${safeId}`;
}

const ICON_CHEVRON = `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>`;
const ICON_CHECK = `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>`;
const ICON_LINK = `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>`;

function getSavedView() {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === "map" || v === "bento") return v;
  } catch {}
  return "map";
}

function fmtHours(totalMin) {
  if (!totalMin) return "0 min";
  const h = Math.floor(totalMin / 60);
  const m = Math.round(totalMin % 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m} min`;
}

async function initCatalog() {
  mountThemeSwitcher(document.getElementById("catalog-theme-switcher"));

  const root = document.getElementById("catalog-content");
  const countEl = document.getElementById("ready-count");
  const progressBar = document.getElementById("ready-progress");
  const statReady = document.getElementById("stat-ready");
  const statScenes = document.getElementById("stat-scenes");
  const statHours = document.getElementById("stat-hours");
  const statWatched = document.getElementById("stat-watched");
  const resumeCard = document.getElementById("resume-card");
  const resumeKicker = document.getElementById("resume-kicker");
  const resumeTitle = document.getElementById("resume-title");
  const resumeMeta = document.getElementById("resume-meta");
  const resumeCta = document.getElementById("resume-cta");
  const searchInput = document.getElementById("catalog-search");
  const filterButtons = Array.from(document.querySelectorAll(".filter-btn"));
  const viewButtons = Array.from(document.querySelectorAll(".view-btn"));

  let manifest;
  try {
    const res = await fetch("lessons/manifest.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (err) {
    root.innerHTML = `<div class="box box-warn"><div class="box-label">Errore di caricamento</div><p>Impossibile leggere <code>lessons/manifest.json</code>. Avvia l'app con <code>python videolezioni/scripts/serve.py</code>.</p></div>`;
    return;
  }

  const progress = loadProgress();
  const readyLessons = manifest.lessons.filter((l) => l.status === "ready");
  const readyCount = readyLessons.length;
  const totalCount = manifest.lessons.length;
  const totalScenes = readyLessons.reduce((acc, l) => acc + (l.scenes_count || 0), 0);
  const totalMins = readyLessons.reduce((acc, l) => acc + (l.duration_min || l.estimated_minutes || 0), 0);
  const watchedScenes = Object.values(progress.watched || {}).reduce((acc, arr) => acc + (Array.isArray(arr) ? arr.length : 0), 0);

  countEl.textContent = `${readyCount} / ${totalCount} pronti`;
  progressBar.style.width = `${Math.round((readyCount / totalCount) * 100)}%`;
  statReady.textContent = `${readyCount}/${totalCount}`;
  statScenes.textContent = String(totalScenes);
  statHours.textContent = fmtHours(totalMins);
  statWatched.textContent = String(watchedScenes);

  // Configure Resume Hero Card
  const lastLesson = progress.lastLessonId
    ? readyLessons.find((l) => l.id === progress.lastLessonId)
    : null;
  const featured = lastLesson || readyLessons[0] || manifest.lessons[0];
  if (featured) {
    const isResuming = Boolean(lastLesson);
    const sceneIdx = isResuming ? (progress.lastSceneIdx || 0) : 0;
    const chapNum = String(featured.chapter).padStart(2, "0");
    const dur = featured.duration_min || featured.estimated_minutes || 10;
    resumeCard.href = lessonUrl(featured.id, sceneIdx);
    resumeKicker.textContent = isResuming ? `Riprendi · Cap. ${chapNum}` : `Consigliato · Cap. ${chapNum}`;
    resumeTitle.textContent = featured.title;
    resumeMeta.textContent = isResuming
      ? `Scena ${sceneIdx + 1} di ${featured.scenes_count || "?"} · ~${dur} min`
      : `${featured.scenes_count || ""} scene · ~${dur} min · Audio Kore sincronizzato`;
    resumeCta.innerHTML = `<span>${isResuming ? "Riprendi da qui" : "Avvia lezione"}</span>${ICON_CHEVRON}`;
  }

  let activeFilter = "all";
  let activeView = getSavedView();
  let query = "";

  viewButtons.forEach((b) => b.classList.toggle("active", b.dataset.view === activeView));

  function matchesFilter(lesson, part) {
    if (activeFilter === "ready" && lesson.status !== "ready") return false;
    if (activeFilter === "planned" && lesson.status === "ready") return false;
    if (query) {
      const hay = `${lesson.chapter} ${lesson.id} ${lesson.title} ${lesson.summary} ${part.title}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  }

  function chapterProgressPct(lesson) {
    const arr = progress.watched?.[lesson.id];
    if (!Array.isArray(arr) || !lesson.scenes_count) return 0;
    return Math.min(100, Math.round((arr.length / lesson.scenes_count) * 100));
  }

  function renderMap() {
    const wrap = document.createElement("div");
    wrap.className = "roadmap-wrap";
    let renderedAny = false;

    for (const part of manifest.parts) {
      const partLessons = manifest.lessons.filter((l) => l.part === part.id && matchesFilter(l, part));
      if (partLessons.length === 0) continue;
      renderedAny = true;

      const readyInPart = partLessons.filter((l) => l.status === "ready").length;
      const stage = document.createElement("section");
      stage.className = "roadmap-stage";
      stage.innerHTML = `
        <div class="roadmap-stage-head">
          <div>
            <div class="roadmap-part-pill">${part.label}</div>
            <h2 class="roadmap-part-title">${part.title}</h2>
          </div>
          <span class="roadmap-part-count">${readyInPart} / ${partLessons.length} disponibili</span>
        </div>
        <div class="roadmap-track"></div>
      `;

      const track = stage.querySelector(".roadmap-track");
      partLessons.forEach((lesson, idx) => {
        const isReady = lesson.status === "ready";
        const chapLabel = `Cap. ${String(lesson.chapter).padStart(2, "0")}`;
        const dur = lesson.duration_min || lesson.estimated_minutes || 10;
        const pct = chapterProgressPct(lesson);

        const nodeWrap = document.createElement("div");
        nodeWrap.className = "map-node-wrap";

        if (idx > 0) {
          const conn = document.createElement("span");
          conn.className = `map-connector ${isReady ? "active" : ""}`;
          conn.setAttribute("aria-hidden", "true");
          conn.innerHTML = ICON_LINK;
          nodeWrap.appendChild(conn);
        }

        const node = document.createElement(isReady ? "a" : "div");
        node.className = `map-node ${isReady ? "ready" : "planned"}`;
        if (isReady) node.href = lessonUrl(lesson.id);

        node.innerHTML = `
          <div>
            <div class="map-node-top">
              <div>
                <span class="chap-num">${chapLabel}</span>
                <span class="${isReady ? "status-pill-ready" : "status-pill-planned"}" style="margin-left:6px;">
                  ${isReady ? (pct === 100 ? `${ICON_CHECK} Completato` : "Pronto") : "In preparazione"}
                </span>
              </div>
              <div class="map-node-art">${chapterMiniSvg(lesson.chapter)}</div>
            </div>
            <h3 style="margin-top:8px;">${lesson.title}</h3>
            <p style="margin-top:4px;">${lesson.summary}</p>
          </div>
          <div>
            ${pct > 0 ? `<div class="node-progress-bar"><div class="node-progress-fill" style="width:${pct}%"></div></div>` : ""}
            <div class="map-node-foot">
              <span>${isReady ? `${lesson.scenes_count} scene · ~${dur} min` : lesson.source_tex.split("/").pop()}</span>
              ${isReady ? `<span class="lesson-cta"><span>${pct > 0 && pct < 100 ? `${pct}%` : "Apri"}</span>${ICON_CHEVRON}</span>` : ""}
            </div>
          </div>
        `;
        nodeWrap.appendChild(node);
        track.appendChild(nodeWrap);
      });

      wrap.appendChild(stage);
    }

    if (!renderedAny) {
      root.innerHTML = `<div class="empty-state">Nessun capitolo trovato per «${query}». Prova con un altro termine o rimuovi i filtri.</div>`;
    } else {
      root.innerHTML = "";
      root.appendChild(wrap);
    }
  }

  function renderBento() {
    root.innerHTML = "";
    let renderedAny = false;

    for (const part of manifest.parts) {
      const partLessons = manifest.lessons.filter((l) => l.part === part.id && matchesFilter(l, part));
      if (partLessons.length === 0) continue;
      renderedAny = true;

      const sec = document.createElement("section");
      sec.className = "part-section";
      sec.innerHTML = `
        <div class="part-header">
          <span class="part-label">${part.label}</span>
          <h2 class="part-title">${part.title}</h2>
        </div>
        <div class="bento-grid"></div>
      `;
      const grid = sec.querySelector(".bento-grid");

      for (const lesson of partLessons) {
        const isReady = lesson.status === "ready";
        const chapLabel = `Cap. ${String(lesson.chapter).padStart(2, "0")}`;
        const dur = lesson.duration_min || lesson.estimated_minutes || 10;
        const pct = chapterProgressPct(lesson);

        const card = document.createElement(isReady ? "a" : "div");
        card.className = `bento-card ${isReady ? "ready" : "planned"}`;
        if (isReady) card.href = lessonUrl(lesson.id);

        card.innerHTML = `
          <div>
            <div class="bento-visual">
              <div>
                <div class="chap-num">${chapLabel}</div>
                <div style="margin-top:6px;">
                  <span class="${isReady ? "status-pill-ready" : "status-pill-planned"}">
                    ${isReady ? (pct === 100 ? `${ICON_CHECK} Completato` : "Disponibile") : "In preparazione"}
                  </span>
                </div>
              </div>
              ${chapterMiniSvg(lesson.chapter)}
            </div>
            <div class="bento-body">
              <h3>${lesson.title}</h3>
              <p>${lesson.summary}</p>
            </div>
          </div>
          <div>
            ${pct > 0 ? `<div class="node-progress-bar" style="margin:0 18px 4px;"><div class="node-progress-fill" style="width:${pct}%"></div></div>` : ""}
            <div class="bento-foot">
              <span>${isReady ? `${lesson.scenes_count} scene · ~${dur} min` : `Sorgente: ${lesson.source_tex.split("/").pop()}`}</span>
              ${isReady ? `<span class="lesson-cta"><span>Avvia</span>${ICON_CHEVRON}</span>` : ""}
            </div>
          </div>
        `;
        grid.appendChild(card);
      }
      root.appendChild(sec);
    }

    if (!renderedAny) {
      root.innerHTML = `<div class="empty-state">Nessun capitolo trovato per «${query}». Prova con un altro termine.</div>`;
    }
  }

  function render() {
    if (activeView === "map") renderMap();
    else renderBento();
  }

  for (const btn of filterButtons) {
    btn.addEventListener("click", () => {
      activeFilter = btn.dataset.filter;
      filterButtons.forEach((b) => b.classList.toggle("active", b === btn));
      render();
    });
  }

  for (const btn of viewButtons) {
    btn.addEventListener("click", () => {
      activeView = btn.dataset.view;
      viewButtons.forEach((b) => b.classList.toggle("active", b === btn));
      try { localStorage.setItem(VIEW_KEY, activeView); } catch {}
      render();
    });
  }

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      query = searchInput.value.trim().toLowerCase();
      render();
    });
  }

  render();
}

initCatalog();
