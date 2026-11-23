// Catalog hub renderer for index.html

async function initCatalog() {
  const root = document.getElementById("catalog-content");
  const countEl = document.getElementById("ready-count");
  const progressBar = document.getElementById("ready-progress");
  const filterButtons = Array.from(document.querySelectorAll(".filter-btn"));

  let manifest;
  try {
    const res = await fetch("lessons/manifest.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (err) {
    root.innerHTML = `<div class="box box-warn"><div class="box-label">Errore di caricamento</div><p>Impossibile leggere <code>lessons/manifest.json</code>. Avvia l'app con <code>python videolezioni/scripts/serve.py</code> invece di aprire il file HTML direttamente.</p></div>`;
    return;
  }

  const readyCount = manifest.lessons.filter((l) => l.status === "ready").length;
  const totalCount = manifest.lessons.length;
  countEl.textContent = `${readyCount} / ${totalCount} capitoli pronti`;
  progressBar.style.width = `${Math.round((readyCount / totalCount) * 100)}%`;

  let activeFilter = "all";

  function render() {
    root.innerHTML = "";
    for (const part of manifest.parts) {
      const partLessons = manifest.lessons.filter((l) => {
        if (l.part !== part.id) return false;
        if (activeFilter === "ready") return l.status === "ready";
        if (activeFilter === "planned") return l.status !== "ready";
        return true;
      });
      if (partLessons.length === 0) continue;

      const sec = document.createElement("section");
      sec.className = "part-section";
      sec.innerHTML = `
        <div class="part-header">
          <span class="part-label">${part.label}</span>
          <h2 class="part-title">${part.title}</h2>
        </div>
        <div class="lesson-grid"></div>
      `;
      const grid = sec.querySelector(".lesson-grid");

      for (const lesson of partLessons) {
        const isReady = lesson.status === "ready";
        const card = document.createElement(isReady ? "a" : "div");
        card.className = `lesson-card ${isReady ? "ready" : "planned"}`;
        if (isReady) {
          card.href = `lesson.html?id=${encodeURIComponent(lesson.id)}`;
        }
        const chapLabel = lesson.chapter === 0 ? "Cap. 00" : `Cap. ${String(lesson.chapter).padStart(2, "0")}`;
        const metaRight = isReady
          ? `<span class="lesson-cta">Avvia lezione →</span>`
          : `<span>${lesson.id}/</span>`;
        const metaLeft = isReady
          ? `${lesson.scenes_count || ""} scene · ~${lesson.estimated_minutes || 10} min`
          : `Sorgente: ${lesson.source_tex.split("/").pop()}`;

        card.innerHTML = `
          <div>
            <div class="lesson-card-top">
              <span class="chap-num">${chapLabel}</span>
              <span class="status-badge ${isReady ? "status-ready" : "status-planned"}">
                ${isReady ? "Disponibile" : "In preparazione"}
              </span>
            </div>
            <h3>${lesson.title}</h3>
            <p>${lesson.summary}</p>
          </div>
          <div class="lesson-card-foot">
            <span>${metaLeft}</span>
            ${metaRight}
          </div>
        `;
        grid.appendChild(card);
      }
      root.appendChild(sec);
    }
  }

  for (const btn of filterButtons) {
    btn.addEventListener("click", () => {
      activeFilter = btn.dataset.filter;
      filterButtons.forEach((b) => b.classList.toggle("active", b === btn));
      render();
    });
  }

  render();
}

initCatalog();
