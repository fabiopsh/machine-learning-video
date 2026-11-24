// Shared Theme Switcher + Local Study Progress + Mini Thematic SVG Art
// Default theme: "studio" (modern high-craft editorial light)

const THEME_KEY = "ml_videolezioni_theme_v2";
const PROGRESS_KEY = "ml_videolezioni_progress_v1";

export const THEMES = [
  { id: "studio", label: "Studio",       desc: "Chiaro moderno, pulito ed editoriale",     swatches: ["#FFFFFF", "#141413", "#1D4ED8"], metaColor: "#F6F6F3" },
  { id: "carbon", label: "Carbon",       desc: "Scuro minimale in grafite pura",           swatches: ["#121215", "#F4F4F5", "#7AA2F7"], metaColor: "#09090B" },
  { id: "glass",  label: "Liquid Glass", desc: "Vetro satinato traslucido stile Apple",    swatches: ["#DCEBFC", "#0071E3", "#FFFFFF"], metaColor: "#E7EEF8" },
  { id: "arcade", label: "16-bit",       desc: "Retro gaming console & JRPG a pixel",      swatches: ["#161E3A", "#FFD447", "#4FD1FF"], metaColor: "#0D1122" }
];

const DEFAULT_THEME = "studio";

export function getSavedTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved && THEMES.some((t) => t.id === saved)) return saved;
  } catch {}
  return DEFAULT_THEME;
}

export function applyTheme(themeId) {
  const themeObj = THEMES.find((t) => t.id === themeId) || THEMES[0];
  const valid = themeObj.id;
  document.documentElement.setAttribute("data-theme", valid);
  let metaTheme = document.querySelector('meta[name="theme-color"]');
  if (!metaTheme) {
    metaTheme = document.createElement("meta");
    metaTheme.name = "theme-color";
    document.head.appendChild(metaTheme);
  }
  metaTheme.content = themeObj.metaColor;
  try {
    localStorage.setItem(THEME_KEY, valid);
  } catch {}
  document.querySelectorAll(".theme-pill").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.theme === valid);
    btn.setAttribute("aria-pressed", String(btn.dataset.theme === valid));
  });
  return valid;
}

export function mountThemeSwitcher(container) {
  if (!container) return;
  const current = applyTheme(getSavedTheme());
  container.innerHTML = "";
  container.classList.add("theme-switcher");
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", "Selettore stile grafico");

  for (const t of THEMES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `theme-pill ${t.id === current ? "active" : ""}`;
    btn.dataset.theme = t.id;
    btn.title = `${t.label} — ${t.desc}`;
    btn.setAttribute("aria-pressed", String(t.id === current));
    btn.innerHTML = `
      <span class="theme-swatch" style="background:${t.swatches[0]};border-color:${t.swatches[1]}">
        <i style="background:${t.swatches[1]}"></i>
      </span>
      <span class="theme-pill-label">${t.label}</span>
    `;
    btn.addEventListener("click", () => {
      // On phones inside the compact player topbar, tapping the single active dot cycles themes cleanly
      if (container.classList.contains("player-theme-compact") && window.innerWidth <= 680) {
        const cur = document.documentElement.getAttribute("data-theme") || DEFAULT_THEME;
        const idx = THEMES.findIndex((x) => x.id === cur);
        const next = THEMES[(idx + 1) % THEMES.length];
        applyTheme(next.id);
        return;
      }
      applyTheme(t.id);
    });
    container.appendChild(btn);
  }
}

// Local Study Progress (zero-backend persistence)
export function loadProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        parsed.watched = parsed.watched || {};
        return parsed;
      }
    }
  } catch {}
  return { lastLessonId: null, lastSceneIdx: 0, lastUpdated: 0, watched: {} };
}

export function saveSceneProgress(lessonId, sceneIdx, markWatched = false) {
  const p = loadProgress();
  p.lastLessonId = lessonId;
  p.lastSceneIdx = sceneIdx;
  p.lastUpdated = Date.now();
  if (!Array.isArray(p.watched[lessonId])) p.watched[lessonId] = [];
  if (markWatched && !p.watched[lessonId].includes(sceneIdx)) {
    p.watched[lessonId].push(sceneIdx);
  }
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
  } catch {}
  return p;
}

// Custom mini thematic SVG emblem per chapter (for Interactive Map & Bento cards)
export function chapterMiniSvg(chapter) {
  const svgs = {
    0: `<svg viewBox="0 0 80 42" class="mini-art"><path d="M10 30 Q26 12 40 21 T70 12" fill="none" stroke="var(--blue)" stroke-width="2"/><circle cx="10" cy="30" r="3" fill="var(--blue)"/><circle cx="40" cy="21" r="3" fill="var(--orange)"/><circle cx="70" cy="12" r="3" fill="var(--green)"/></svg>`,
    1: `<svg viewBox="0 0 80 42" class="mini-art"><text x="14" y="28" fill="var(--blue)" font-family="var(--font-serif)" font-size="16" font-style="italic">∇f(x)</text><path d="M52 32 L68 12" stroke="var(--orange)" stroke-width="2"/><circle cx="68" cy="12" r="2.8" fill="var(--red)"/></svg>`,
    2: `<svg viewBox="0 0 80 42" class="mini-art"><rect x="6" y="13" width="18" height="16" rx="3" fill="none" stroke="var(--muted)" stroke-width="1.4"/><rect x="31" y="11" width="18" height="20" rx="3" fill="var(--blue-soft)" stroke="var(--blue)" stroke-width="1.8"/><rect x="56" y="13" width="18" height="16" rx="3" fill="none" stroke="var(--green)" stroke-width="1.4" stroke-dasharray="3 2"/><line x1="24" y1="21" x2="31" y2="21" stroke="var(--ink-soft)" stroke-width="1.4"/><line x1="49" y1="21" x2="56" y2="21" stroke="var(--ink-soft)" stroke-width="1.4"/></svg>`,
    3: `<svg viewBox="0 0 80 42" class="mini-art"><ellipse cx="40" cy="21" rx="32" ry="15" fill="var(--blue-soft)" stroke="var(--blue)" stroke-width="1.5"/><ellipse cx="48" cy="21" rx="14" ry="8" fill="none" stroke="var(--orange)" stroke-width="1.8"/><circle cx="51" cy="21" r="2.6" fill="var(--red)"/></svg>`,
    4: `<svg viewBox="0 0 80 42" class="mini-art"><line x1="10" y1="34" x2="70" y2="10" stroke="var(--red)" stroke-width="2"/><circle cx="20" cy="26" r="2.5" fill="var(--blue)"/><circle cx="32" cy="27" r="2.5" fill="var(--blue)"/><circle cx="44" cy="16" r="2.5" fill="var(--blue)"/><circle cx="58" cy="18" r="2.5" fill="var(--blue)"/><line x1="20" y1="26" x2="20" y2="30" stroke="var(--green)" stroke-width="1.5"/><line x1="44" y1="16" x2="44" y2="20" stroke="var(--green)" stroke-width="1.5"/></svg>`,
    5: `<svg viewBox="0 0 80 42" class="mini-art"><path d="M8 22 Q24 4 40 21 T72 20" fill="none" stroke="var(--green)" stroke-width="1.7"/><path d="M8 28 C18 4 24 38 34 10 C44 36 56 4 72 24" fill="none" stroke="var(--red)" stroke-width="1.6" stroke-dasharray="3 2"/><circle cx="16" cy="16" r="2.2" fill="var(--blue)"/><circle cx="40" cy="21" r="2.2" fill="var(--blue)"/><circle cx="62" cy="28" r="2.2" fill="var(--blue)"/></svg>`,
    6: `<svg viewBox="0 0 80 42" class="mini-art"><circle cx="40" cy="21" r="15" fill="var(--blue-soft)" stroke="var(--blue)" stroke-width="1.3" stroke-dasharray="3 2"/><circle cx="40" cy="21" r="2.5" fill="var(--ink)"/><circle cx="33" cy="16" r="2.5" fill="var(--red)"/><circle cx="47" cy="17" r="2.5" fill="var(--blue)"/><circle cx="45" cy="27" r="2.5" fill="var(--red)"/><circle cx="33" cy="26" r="2.5" fill="var(--red)"/><circle cx="63" cy="12" r="2.2" fill="var(--blue)"/></svg>`,
    7: `<svg viewBox="0 0 80 42" class="mini-art"><path d="M10 10 Q28 32 70 35" fill="none" stroke="var(--blue)" stroke-width="1.7"/><path d="M10 35 Q44 32 70 10" fill="none" stroke="var(--red)" stroke-width="1.7"/><path d="M10 14 Q36 30 70 12" fill="none" stroke="var(--orange)" stroke-width="2.1"/><circle cx="38" cy="23" r="2.8" fill="var(--orange)"/></svg>`,
    8: `<svg viewBox="0 0 80 42" class="mini-art"><circle cx="24" cy="21" r="14" fill="none" stroke="var(--muted)" stroke-width="1.1"/><circle cx="24" cy="21" r="7" fill="none" stroke="var(--muted)" stroke-width="1"/><circle cx="24" cy="21" r="2.4" fill="var(--red)"/><circle cx="22" cy="19" r="1.8" fill="var(--blue)"/><circle cx="26" cy="22" r="1.8" fill="var(--blue)"/><circle cx="56" cy="21" r="14" fill="none" stroke="var(--muted)" stroke-width="1.1"/><circle cx="56" cy="21" r="2.4" fill="var(--red)"/><circle cx="63" cy="13" r="1.8" fill="var(--blue)"/><circle cx="65" cy="16" r="1.8" fill="var(--blue)"/><circle cx="61" cy="15" r="1.8" fill="var(--blue)"/></svg>`,
    9: `<svg viewBox="0 0 80 42" class="mini-art"><line x1="12" y1="36" x2="68" y2="8" stroke="var(--muted)" stroke-width="1.2" stroke-dasharray="3 2"/><path d="M12 36 Q18 10 68 8" fill="none" stroke="var(--red)" stroke-width="2.1"/><path d="M12 36 Q28 18 68 8" fill="none" stroke="var(--blue)" stroke-width="1.6"/></svg>`,
    10: `<svg viewBox="0 0 80 42" class="mini-art"><circle cx="14" cy="10" r="4" fill="none" stroke="var(--muted)" stroke-width="1.3"/><circle cx="14" cy="21" r="4" fill="none" stroke="var(--muted)" stroke-width="1.3"/><circle cx="14" cy="32" r="4" fill="none" stroke="var(--muted)" stroke-width="1.3"/><circle cx="46" cy="21" r="8" fill="var(--blue-soft)" stroke="var(--blue)" stroke-width="1.8"/><line x1="18" y1="10" x2="38" y2="19" stroke="var(--blue)" stroke-width="1.4"/><line x1="18" y1="21" x2="38" y2="21" stroke="var(--blue)" stroke-width="1.4"/><line x1="18" y1="32" x2="38" y2="23" stroke="var(--blue)" stroke-width="1.4"/><line x1="54" y1="21" x2="70" y2="21" stroke="var(--orange)" stroke-width="2"/></svg>`,
    11: `<svg viewBox="0 0 80 42" class="mini-art"><line x1="16" y1="12" x2="40" y2="9" stroke="var(--muted)" stroke-width="1.1"/><line x1="16" y1="12" x2="40" y2="21" stroke="var(--blue)" stroke-width="1.3"/><line x1="16" y1="30" x2="40" y2="21" stroke="var(--muted)" stroke-width="1.1"/><line x1="16" y1="30" x2="40" y2="33" stroke="var(--blue)" stroke-width="1.3"/><line x1="40" y1="9" x2="64" y2="21" stroke="var(--orange)" stroke-width="1.4"/><line x1="40" y1="21" x2="64" y2="21" stroke="var(--orange)" stroke-width="1.6"/><line x1="40" y1="33" x2="64" y2="21" stroke="var(--orange)" stroke-width="1.4"/><circle cx="16" cy="12" r="3.5" fill="var(--bg-surface)" stroke="var(--ink-soft)"/><circle cx="16" cy="30" r="3.5" fill="var(--bg-surface)" stroke="var(--ink-soft)"/><circle cx="40" cy="9" r="3.5" fill="var(--blue-soft)" stroke="var(--blue)"/><circle cx="40" cy="21" r="3.5" fill="var(--blue-soft)" stroke="var(--blue)"/><circle cx="40" cy="33" r="3.5" fill="var(--blue-soft)" stroke="var(--blue)"/><circle cx="64" cy="21" r="4.2" fill="var(--amber-wash)" stroke="var(--orange)"/></svg>`,
    12: `<svg viewBox="0 0 80 42" class="mini-art"><path d="M10 10 Q28 38 44 33 T70 16" fill="none" stroke="var(--ink-soft)" stroke-width="1.6"/><path d="M16 16 L26 27 L36 33 L43 33" fill="none" stroke="var(--red)" stroke-width="2"/><circle cx="43" cy="33" r="3" fill="var(--green)"/></svg>`,
    13: `<svg viewBox="0 0 80 42" class="mini-art"><line x1="14" y1="36" x2="66" y2="6" stroke="var(--blue)" stroke-width="2"/><line x1="10" y1="28" x2="56" y2="2" stroke="var(--muted)" stroke-width="1.2" stroke-dasharray="3 2"/><line x1="22" y1="40" x2="70" y2="13" stroke="var(--muted)" stroke-width="1.2" stroke-dasharray="3 2"/><circle cx="24" cy="19" r="2.8" fill="var(--blue)"/><circle cx="52" cy="23" r="2.8" fill="var(--red)"/></svg>`,
    14: `<svg viewBox="0 0 80 42" class="mini-art"><circle cx="24" cy="21" r="10" fill="var(--blue-soft)" stroke="var(--blue)" stroke-width="1.4"/><circle cx="54" cy="21" r="10" fill="var(--accent-soft)" stroke="var(--red)" stroke-width="1.4"/><circle cx="24" cy="21" r="2" fill="var(--blue)"/><circle cx="54" cy="21" r="2" fill="var(--red)"/></svg>`,
    15: `<svg viewBox="0 0 80 42" class="mini-art"><rect x="10" y="9" width="12" height="24" rx="2" fill="var(--blue-soft)" stroke="var(--blue)"/><rect x="27" y="13" width="12" height="16" rx="2" fill="var(--blue-soft)" stroke="var(--blue)"/><rect x="44" y="16" width="12" height="10" rx="2" fill="var(--amber-wash)" stroke="var(--orange)"/><rect x="61" y="14" width="9" height="14" rx="2" fill="none" stroke="var(--green)"/></svg>`,
    16: `<svg viewBox="0 0 80 42" class="mini-art"><rect x="10" y="12" width="18" height="18" rx="2" fill="none" stroke="var(--muted)"/><rect x="14" y="16" width="8" height="8" fill="var(--blue-soft)" stroke="var(--blue)"/><rect x="48" y="14" width="16" height="14" rx="2" fill="var(--amber-wash)" stroke="var(--orange)"/><line x1="28" y1="21" x2="48" y2="21" stroke="var(--blue)" stroke-width="1.5"/></svg>`,
    17: `<svg viewBox="0 0 80 42" class="mini-art"><path d="M12 22 C12 8 30 8 30 22" fill="none" stroke="var(--orange)" stroke-width="1.7"/><circle cx="21" cy="26" r="6" fill="var(--blue-soft)" stroke="var(--blue)" stroke-width="1.6"/><line x1="27" y1="26" x2="44" y2="26" stroke="var(--ink-soft)" stroke-width="1.4"/><circle cx="50" cy="26" r="6" fill="var(--blue-soft)" stroke="var(--blue)" stroke-width="1.6"/><line x1="56" y1="26" x2="70" y2="26" stroke="var(--green)" stroke-width="1.6"/></svg>`,
    18: `<svg viewBox="0 0 80 42" class="mini-art"><rect x="10" y="28" width="10" height="8" rx="2" fill="var(--blue-soft)" stroke="var(--blue)"/><rect x="35" y="28" width="10" height="8" rx="2" fill="var(--blue-soft)" stroke="var(--blue)"/><rect x="60" y="28" width="10" height="8" rx="2" fill="var(--blue-soft)" stroke="var(--blue)"/><path d="M15 28 Q40 4 65 28" fill="none" stroke="var(--orange)" stroke-width="1.6"/><path d="M15 28 Q27 12 40 28" fill="none" stroke="var(--blue)" stroke-width="1.4"/><path d="M40 28 Q52 12 65 28" fill="none" stroke="var(--green)" stroke-width="1.4"/></svg>`,
    19: `<svg viewBox="0 0 80 42" class="mini-art"><line x1="22" y1="12" x2="46" y2="10" stroke="var(--muted)" stroke-width="1.4"/><line x1="22" y1="12" x2="30" y2="30" stroke="var(--muted)" stroke-width="1.4"/><line x1="46" y1="10" x2="58" y2="28" stroke="var(--blue)" stroke-width="1.6"/><line x1="30" y1="30" x2="58" y2="28" stroke="var(--orange)" stroke-width="1.6"/><circle cx="22" cy="12" r="4" fill="var(--blue-soft)" stroke="var(--blue)"/><circle cx="46" cy="10" r="4" fill="var(--blue-soft)" stroke="var(--blue)"/><circle cx="30" cy="30" r="4" fill="var(--amber-wash)" stroke="var(--orange)"/><circle cx="58" cy="28" r="4" fill="var(--accent-soft)" stroke="var(--red)"/></svg>`
  };
  return svgs[chapter] || svgs[0];
}
