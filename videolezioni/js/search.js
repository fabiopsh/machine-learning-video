// Global Search Command Palette (Ctrl+K / Cmd+K) across all 20 chapters & 231 scenes.
// Zero dependencies, instant accent-insensitive client-side ranking, full keyboard navigation.

const SUGGESTED_QUERIES = [
  "VC dimension",
  "bias-varianza",
  "double CV",
  "backpropagation",
  "kernel trick",
  "batch norm",
  "LSTM",
  "GNN"
];

function stripAccents(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function escapeHtml(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function highlightMatches(text, terms) {
  if (!text || !terms.length) return escapeHtml(text || "");
  const cleanTerms = terms
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .filter(Boolean);
  if (!cleanTerms.length) return escapeHtml(text);
  // Accent-tolerant highlight via normalized index map
  const normChars = [];
  const origIdx = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i].normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    for (let k = 0; k < ch.length; k++) {
      normChars.push(ch[k]);
      origIdx.push(i);
    }
  }
  const normStr = normChars.join("");
  const ranges = [];
  for (const term of cleanTerms) {
    const rx = new RegExp(term, "gi");
    let m;
    while ((m = rx.exec(normStr)) !== null) {
      if (m[0].length === 0) break;
      const start = origIdx[m.index];
      const end = (origIdx[m.index + m[0].length - 1] ?? start) + 1;
      ranges.push([start, end]);
    }
  }
  if (!ranges.length) return escapeHtml(text);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const prev = merged[merged.length - 1];
    if (ranges[i][0] <= prev[1]) prev[1] = Math.max(prev[1], ranges[i][1]);
    else merged.push(ranges[i]);
  }
  let out = "";
  let pos = 0;
  for (const [s, e] of merged) {
    out += escapeHtml(text.slice(pos, s));
    out += `<mark>${escapeHtml(text.slice(s, e))}</mark>`;
    pos = e;
  }
  out += escapeHtml(text.slice(pos));
  return out;
}

function buildSnippet(text, terms) {
  if (!text) return "";
  const norm = stripAccents(text);
  let bestPos = -1;
  for (const term of terms) {
    const idx = norm.indexOf(term);
    if (idx !== -1 && (bestPos === -1 || idx < bestPos)) bestPos = idx;
  }
  if (bestPos === -1) return text.slice(0, 125) + (text.length > 125 ? "…" : "");
  const start = Math.max(0, bestPos - 42);
  const end = Math.min(text.length, bestPos + 92);
  let slice = text.slice(start, end).trim();
  if (start > 0) slice = "…" + slice.replace(/^\S*\s+/, "");
  if (end < text.length) slice = slice.replace(/\s+\S*$/, "") + "…";
  return slice;
}

export function buildLessonSceneUrl(lessonId, sceneIdx, assetRoot, useCleanUrls) {
  const safe = encodeURIComponent(lessonId);
  const root = (assetRoot || ".").replace(/\/+$/, "");
  const prefix = root && root !== "." ? `${root}/` : "";
  if (useCleanUrls) {
    return sceneIdx > 0 ? `${prefix}${safe}/?scena=${sceneIdx + 1}` : `${prefix}${safe}/`;
  }
  return sceneIdx > 0
    ? `${prefix}lesson.html?id=${safe}&scena=${sceneIdx + 1}`
    : `${prefix}lesson.html?id=${safe}`;
}

export function initGlobalSearch({
  assetRoot = ".",
  useCleanUrls = false,
  currentLessonId = null,
  onSameLessonJump = null,
  triggerEls = []
} = {}) {
  const rootPrefix = (assetRoot || ".").replace(/\/+$/, "");
  const indexUrl = `${rootPrefix}/lessons/search-index.json`;

  let indexData = null;
  let indexLoading = null;
  let isOpen = false;
  let activeIdx = 0;
  let currentResults = [];

  // Create modal DOM lazily on first init
  const backdrop = document.createElement("div");
  backdrop.id = "global-search-modal";
  backdrop.className = "gsearch-backdrop";
  backdrop.setAttribute("aria-hidden", "true");
  backdrop.innerHTML = `
    <div class="gsearch-dialog" role="dialog" aria-modal="true" aria-label="Ricerca globale nel corso">
      <div class="gsearch-head">
        <svg class="gsearch-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>
        <input id="gsearch-input" class="gsearch-input" type="search" autocomplete="off" spellcheck="false" placeholder="Cerca formule, teoremi, concetti o parole in tutte le 20 lezioni…" aria-label="Cerca in tutte le lezioni" />
        <button id="gsearch-close" class="gsearch-esc-btn" type="button" title="Chiudi (Esc)"><kbd>Esc</kbd></button>
      </div>
      <div id="gsearch-results" class="gsearch-results" role="listbox"></div>
      <div class="gsearch-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> naviga · <kbd>↵</kbd> apri scena · <kbd>Esc</kbd> chiudi</span>
        <span id="gsearch-count" class="gsearch-count">20 capitoli · 231 scene</span>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const inputEl = backdrop.querySelector("#gsearch-input");
  const resultsEl = backdrop.querySelector("#gsearch-results");
  const countEl = backdrop.querySelector("#gsearch-count");
  const closeBtn = backdrop.querySelector("#gsearch-close");

  async function ensureIndex() {
    if (indexData) return indexData;
    if (!indexLoading) {
      indexLoading = fetch(indexUrl, { cache: "no-store" })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((raw) => {
          const lessonsByIdx = raw.lessons || [];
          const prepared = (raw.scenes || []).map((sc) => {
            const lInfo = lessonsByIdx[sc.l] || { id: "", ch: 0, t: "" };
            return {
              lessonId: lInfo.id,
              chapter: lInfo.ch,
              lessonTitle: lInfo.t,
              sceneIdx: sc.i,
              section: sc.sec || "",
              title: sc.t || "",
              text: sc.txt || "",
              nLesson: stripAccents(`cap ${lInfo.ch} ${lInfo.t}`),
              nSec: stripAccents(sc.sec || ""),
              nTitle: stripAccents(sc.t || ""),
              nText: stripAccents(sc.txt || "")
            };
          });
          indexData = { lessons: lessonsByIdx, scenes: prepared };
          return indexData;
        })
        .catch(() => null);
    }
    return indexLoading;
  }

  function renderEmptyState() {
    currentResults = [];
    activeIdx = 0;
    const chips = SUGGESTED_QUERIES.map(
      (q) => `<button type="button" class="gsearch-chip" data-query="${escapeHtml(q)}">${escapeHtml(q)}</button>`
    ).join("");
    resultsEl.innerHTML = `
      <div class="gsearch-empty">
        <div class="gsearch-empty-title">Cerca istantaneamente tra slide, formule e trascrizioni</div>
        <div class="gsearch-chips">${chips}</div>
      </div>
    `;
    if (indexData) {
      countEl.textContent = `${indexData.lessons.length} capitoli · ${indexData.scenes.length} scene`;
    }
    resultsEl.querySelectorAll(".gsearch-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        inputEl.value = btn.dataset.query || "";
        runSearch(inputEl.value);
        inputEl.focus();
      });
    });
  }

  function navigateToResult(item) {
    if (!item) return;
    close();
    if (currentLessonId && item.lessonId === currentLessonId && typeof onSameLessonJump === "function") {
      onSameLessonJump(item.sceneIdx);
      return;
    }
    window.location.href = buildLessonSceneUrl(item.lessonId, item.sceneIdx, assetRoot, useCleanUrls);
  }

  function updateActiveRow() {
    const rows = resultsEl.querySelectorAll(".gsearch-item");
    rows.forEach((row, idx) => {
      const isAct = idx === activeIdx;
      row.classList.toggle("active", isAct);
      row.setAttribute("aria-selected", isAct ? "true" : "false");
      if (isAct) row.scrollIntoView({ block: "nearest" });
    });
  }

  function runSearch(rawQuery) {
    const q = (rawQuery || "").trim();
    if (!q) {
      renderEmptyState();
      return;
    }
    if (!indexData) {
      resultsEl.innerHTML = `<div class="gsearch-empty"><div class="gsearch-empty-title">Caricamento indice di ricerca…</div></div>`;
      ensureIndex().then(() => {
        if (isOpen) runSearch(inputEl.value);
      });
      return;
    }

    const normQ = stripAccents(q);
    const terms = normQ.split(/\s+/).filter((t) => t.length >= 1);
    if (!terms.length) {
      renderEmptyState();
      return;
    }

    const scored = [];
    for (const sc of indexData.scenes) {
      const hay = `${sc.nLesson} ${sc.nSec} ${sc.nTitle} ${sc.nText}`;
      let ok = true;
      for (const term of terms) {
        if (!hay.includes(term)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      let score = 0;
      if (sc.nTitle.includes(normQ)) score += 110;
      if (sc.nSec.includes(normQ)) score += 65;
      if (sc.nLesson.includes(normQ)) score += 45;
      if (sc.nText.includes(normQ)) score += 35;

      for (const term of terms) {
        if (sc.nTitle.includes(term)) score += 36;
        if (sc.nSec.includes(term)) score += 18;
        if (sc.nLesson.includes(term)) score += 12;
        if (sc.nText.includes(term)) score += 8;
      }
      if (currentLessonId && sc.lessonId === currentLessonId) score += 6;
      scored.push({ sc, score });
    }

    scored.sort((a, b) => b.score - a.score || a.sc.chapter - b.sc.chapter || a.sc.sceneIdx - b.sc.sceneIdx);
    const top = scored.slice(0, 24).map((x) => x.sc);
    currentResults = top;
    activeIdx = 0;

    countEl.textContent =
      scored.length === 0
        ? "Nessun risultato"
        : `${scored.length} ${scored.length === 1 ? "scena trovata" : "scene trovate"}${scored.length > 24 ? " (prime 24)" : ""}`;

    if (top.length === 0) {
      resultsEl.innerHTML = `<div class="gsearch-empty"><div class="gsearch-empty-title">Nessuna scena trovata per «${escapeHtml(q)}»</div><div class="gsearch-empty-sub">Prova con un altro termine, sigla o simbolo (es. ROC, K-fold, ridge, perceptron).</div></div>`;
      return;
    }

    resultsEl.innerHTML = top
      .map((item, idx) => {
        const chapBadge = `Cap. ${String(item.chapter).padStart(2, "0")}`;
        const sceneBadge = `Scena ${item.sceneIdx + 1}`;
        const sameTag = currentLessonId && item.lessonId === currentLessonId ? `<span class="gsearch-here">Qui</span>` : "";
        const snip = buildSnippet(item.text, terms);
        return `
          <button type="button" class="gsearch-item${idx === 0 ? " active" : ""}" role="option" aria-selected="${idx === 0 ? "true" : "false"}" data-idx="${idx}">
            <div class="gsearch-item-meta">
              <span class="gsearch-chap">${chapBadge}</span>
              <span class="gsearch-lesson-name">${highlightMatches(item.lessonTitle, terms)}</span>
              <span class="gsearch-dot">·</span>
              <span class="gsearch-scene-num">${sceneBadge}</span>
              ${sameTag}
            </div>
            <div class="gsearch-item-title">${highlightMatches(item.title, terms)}</div>
            <div class="gsearch-item-snip">${highlightMatches(snip, terms)}</div>
          </button>
        `;
      })
      .join("");

    resultsEl.querySelectorAll(".gsearch-item").forEach((btn) => {
      const idx = Number(btn.dataset.idx);
      btn.addEventListener("pointerenter", () => {
        activeIdx = idx;
        updateActiveRow();
      });
      btn.addEventListener("click", () => navigateToResult(currentResults[idx]));
    });
  }

  function open(initialQuery = "") {
    if (isOpen) {
      inputEl.focus();
      inputEl.select();
      return;
    }
    isOpen = true;
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
    document.body.classList.add("gsearch-open");
    ensureIndex();
    if (initialQuery) {
      inputEl.value = initialQuery;
      runSearch(initialQuery);
    } else if (inputEl.value.trim()) {
      runSearch(inputEl.value);
    } else {
      renderEmptyState();
    }
    requestAnimationFrame(() => {
      inputEl.focus();
      inputEl.select();
    });
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
    document.body.classList.remove("gsearch-open");
  }

  inputEl.addEventListener("input", () => runSearch(inputEl.value));
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) close();
  });

  // Keyboard navigation inside modal + global Ctrl+K / Cmd+K shortcut
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (isOpen) close();
      else open();
      return;
    }
    if (!isOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (currentResults.length > 0) {
        activeIdx = (activeIdx + 1) % currentResults.length;
        updateActiveRow();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (currentResults.length > 0) {
        activeIdx = (activeIdx - 1 + currentResults.length) % currentResults.length;
        updateActiveRow();
      }
    } else if (e.key === "Enter") {
      if (currentResults.length > 0 && currentResults[activeIdx]) {
        e.preventDefault();
        navigateToResult(currentResults[activeIdx]);
      }
    }
  });

  for (const el of triggerEls) {
    if (!el) continue;
    el.addEventListener("click", (e) => {
      e.preventDefault();
      open();
    });
  }

  return { open, close, isOpen: () => isOpen };
}
