// Real-Time Voice-to-Slide Live Sync v3
// Upgrades over v2:
//  1. Sequential MONOTONIC left-to-right formula-atom alignment (NEVER flashes all 6 copies of a symbol at once!)
//  2. Strict SINGLE-BLOCK focus (NEVER flashes formulas inside inactive/other blocks!)
//  3. Full KaTeX DOM support (x_p^2 -> "x2p", \frac{\partial E}{\partial w_0}, \bar{d}, \bar{x}, \Cov, \Var, 1/l, etc.)
//  4. Exact tight MMS_FA phrase spans per math event instead of noisy 1s multi-symbol soup
//  5. Word-by-word sequential clause highlighting + Spotlight + Click-to-Seek + reliable SVG draw

const STOPWORDS = new Set([
  "di","a","da","in","con","su","per","tra","fra","il","lo","la","i","gli","le",
  "un","uno","una","e","ed","o","od","ma","che","chi","cui","se","al","allo","alla",
  "ai","agli","alle","del","dello","della","dei","degli","delle","nel","nello","nella",
  "nei","negli","nelle","sul","sullo","sulla","sui","sugli","sulle","dal","dallo","dalla",
  "si","ci","vi","ne","non","piu","meno","come","dove","quando","anche","solo",
  "sono","era","sia","puo","ha","hanno","fare","fa","suo","sua","suoi","loro",
  "questo","questa","questi","queste","quello","quella","tutti","tutte","ogni",
  "poi","ora","qui","cosi","quindi","cioe","perche","pero","es","cio","molto",
  "dati","dato","modello","modelli","funzione","funzioni","esempio","esempi","caso"
]);

// Ordered longest/most-specific first so multi-word math phrases match as single crisp events!
const SPOKEN_MATH_GRAMMAR = [
  { key: "dE_dw0",     rx: /^derivata(?:\s+parziale)?(?:\s+di\s+e)?\s+rispetto\s+a\s+w\s*(?:con\s+)?zero$/ },
  { key: "dE_dw1",     rx: /^derivata(?:\s+parziale)?(?:\s+di\s+e)?\s+rispetto\s+a\s+w\s*(?:con\s+)?uno$/ },
  { key: "dE_dwj",     rx: /^derivata(?:\s+parziale)?(?:\s+di\s+e)?\s+rispetto\s+a(?:l\s+singolo\s+peso)?\s+w\s*(?:con\s+)?(?:j|i|k)$/ },
  { key: "x_p_sq",     rx: /^x\s*(?:con\s+)?p\s+(?:al\s+quadrato|quadro)$/ },
  { key: "w_0",        rx: /^w\s*(?:con\s+)?zero$/ },
  { key: "w_1",        rx: /^w\s*(?:con\s+)?uno$/ },
  { key: "w_2",        rx: /^w\s*(?:con\s+)?due$/ },
  { key: "w_j",        rx: /^w\s*(?:con\s+)?(?:j|i|k|m|stella|nuovo)$/ },
  { key: "x_p",        rx: /^x\s*(?:con\s+)?p$/ },
  { key: "x_1",        rx: /^x\s*(?:con\s+)?uno$/ },
  { key: "x_2",        rx: /^x\s*(?:con\s+)?due$/ },
  { key: "x_i",        rx: /^x\s*(?:con\s+)?(?:i|j|k|t|zero)$/ },
  { key: "d_p",        rx: /^d\s*(?:con\s+)?(?:p|i)$/ },
  { key: "h_bar",      rx: /^h\s+soprassegnat[oa]$/ },
  { key: "d_bar",      rx: /^d\s+soprassegnat[oa]$/ },
  { key: "x_bar",      rx: /^x\s+soprassegnat[oa]$/ },
  { key: "one_over_l", rx: /^uno\s+su\s+l$/ },
  { key: "X_T",        rx: /^x\s+trasposto$/ },
  { key: "X_plus",     rx: /^(?:x\s+piu|pseudoinversa)$/ },
  { key: "R_emp",      rx: /^(?:r\s+emp|rischio\s+empirico)$/ },
  { key: "E_RMS",      rx: /^(?:e\s+rms|root\s+mean\s+square)$/ },
  { key: "E_w",        rx: /^e\s+di\s+w$/ },
  { key: "h_w",        rx: /^h\s+(?:con\s+w\s+)?di\s+x$/ },
  { key: "sum",        rx: /^(?:somma(?:\s+su\s+p|\s+di)?|sommatoria)$/ },
  { key: "int",        rx: /^integrale$/ },
  { key: "sqrt",       rx: /^radice(?:\s+quadrata)?$/ },
  { key: "Cov",        rx: /^covarianza$/ },
  { key: "Var",        rx: /^varianza$/ },
  { key: "Bias",       rx: /^bias(?:\s+al\s+quadrato)?$/ },
  { key: "VC",         rx: /^(?:vc|vc\s+dimension)$/ },
  { key: "nabla",      rx: /^gradiente$/ },
  { key: "norm",       rx: /^norma(?:\s+quadra|\s+al\s+quadrato)?$/ },
  { key: "lambda",     rx: /^lambda$/ },
  { key: "eta",        rx: /^(?:eta|learning\s+rate)$/ },
  { key: "delta",      rx: /^delta(?:\s+con\s+p)?$/ },
  { key: "sigma",      rx: /^sigma(?:\s+quadro)?$/ },
  { key: "theta",      rx: /^theta$/ },
  { key: "eps",        rx: /^epsilon$/ },
  { key: "pi",         rx: /^pi\s+greco$/ },
  { key: "phi",        rx: /^phi$/ },
  { key: "sign",       rx: /^(?:segno|sign)$/ },
  { key: "w_vec",      rx: /^(?:vettore\s+(?:dei\s+pesi\s+)?w|pesi\s+w)$/ }
];

function stripAccents(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function cleanWord(raw) {
  return stripAccents(raw).replace(/[^a-z0-9]+/g, "");
}

function normToken(raw) {
  let t = cleanWord(raw);
  if (!t || t.length <= 2) return "";
  if (STOPWORDS.has(t)) return "";
  if (t.length >= 6) {
    t = t.replace(/(zioni|zione|menti|mento|abili|abile|ando|endo|are|ere|ire|ita)$/, "");
  }
  return t;
}

function extractTokens(text) {
  const parts = (text || "").split(/[\s,;:.!?()\[\]{}«»"—–\-/·→←↔=+×]+/);
  const out = [];
  for (const p of parts) {
    const nt = normToken(p);
    if (nt) out.push(nt);
  }
  return out;
}

// Parse exact timestamped spoken math events from the MMS_FA word timeline (longest match greedy)
function extractSpokenMathEvents(words) {
  const events = []; // { key, start, end }
  const cleaned = words.map((w) => cleanWord(w.raw));
  let i = 0;
  while (i < words.length) {
    let matched = null;
    // Try longest phrase first (up to 7 words)
    const maxLen = Math.min(7, words.length - i);
    for (let len = maxLen; len >= 1; len--) {
      const slice = cleaned.slice(i, i + len).filter(Boolean).join(" ");
      if (!slice) continue;
      for (const rule of SPOKEN_MATH_GRAMMAR) {
        if (rule.rx.test(slice)) {
          matched = {
            key: rule.key,
            start: words[i].start,
            end: words[i + len - 1].end,
            len
          };
          break;
        }
      }
      if (matched) break;
    }
    if (matched) {
      events.push({ key: matched.key, start: matched.start, end: matched.end });
      i += matched.len;
    } else {
      i += 1;
    }
  }
  return events;
}

// Wrap a text-containing element into clause spans where each word is an individual <span class="vw">
function wrapClausesWordByWord(el) {
  const clauses = [];
  if (!el || el.dataset.clausesWrapped) return clauses;
  el.dataset.clausesWrapped = "1";

  const nodes = Array.from(el.childNodes);
  if (nodes.length === 0) return clauses;

  let curClause = document.createElement("span");
  curClause.className = "voice-clause";
  let curWords = [];
  const fragment = document.createDocumentFragment();

  const flush = () => {
    if (curWords.length > 0) {
      fragment.appendChild(curClause);
      clauses.push({ el: curClause, wordEls: curWords });
    } else if (curClause.childNodes.length > 0) {
      while (curClause.firstChild) fragment.appendChild(curClause.firstChild);
    }
    curClause = document.createElement("span");
    curClause.className = "voice-clause";
    curWords = [];
  };

  const appendTextWords = (targetParent, str) => {
    const parts = str.split(/(\s+)/);
    for (const part of parts) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        targetParent.appendChild(document.createTextNode(part));
      } else {
        const wSpan = document.createElement("span");
        wSpan.className = "vw";
        wSpan.textContent = part;
        targetParent.appendChild(wSpan);
        curWords.push(wSpan);
      }
    }
  };

  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const txt = node.textContent || "";
      const chunks = txt.split(/([.;:!?](?:\s+|$)|[→⇒](?:\s+|$))/);
      for (const ch of chunks) {
        if (!ch) continue;
        appendTextWords(curClause, ch);
        if (/^[.;:!?→⇒]/.test(ch.trim())) flush();
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === "BR") {
        flush();
        fragment.appendChild(node);
      } else if (node.classList.contains("katex") || node.classList.contains("katex-display")) {
        curClause.appendChild(node);
      } else if (node.tagName === "STRONG" || node.tagName === "EM" || node.tagName === "B" || node.tagName === "I") {
        const clone = document.createElement(node.tagName.toLowerCase());
        for (const attr of node.attributes) clone.setAttribute(attr.name, attr.value);
        for (const child of Array.from(node.childNodes)) {
          if (child.nodeType === Node.TEXT_NODE) {
            appendTextWords(clone, child.textContent || "");
          } else {
            clone.appendChild(child);
          }
        }
        curClause.appendChild(clone);
      } else {
        curClause.appendChild(node);
      }
    }
  }
  flush();

  el.innerHTML = "";
  el.appendChild(fragment);
  return clauses;
}

// Extract ordered KaTeX formula atoms per block (strictly in visual left-to-right DOM order!)
function indexFormulaAtoms(slideCard) {
  const atoms = []; // { el, keys: Set<string>, block, windows: [] }
  const covered = new Set(); // prevent child sub-elements inside an already-tagged compound atom from double-tagging

  const isCovered = (el) => {
    let cur = el.parentElement;
    while (cur && cur !== slideCard) {
      if (covered.has(cur)) return true;
      cur = cur.parentElement;
    }
    return false;
  };

  const addAtom = (el, key, markCovered = false) => {
    if (!el || !key) return;
    // Skip tiny step-tag badges ("Passo 1 · ∂E/∂w₀ = 0") when inside proof-step so the actual equation glows!
    if (el.closest(".step-tag, .box-label, .slide-title, .slide-kicker, .plot-title")) return;
    if (isCovered(el)) return;
    let rec = atoms.find((a) => a.el === el);
    if (!rec) {
      const block = el.closest(".box, .math-card, .proof-step, .acad-table, .pill-strip, .props-grid, .metrics-row, .gate-card, .plot-card") || el;
      rec = { el, keys: new Set(), block, windows: [] };
      atoms.push(rec);
    }
    rec.keys.add(key);
    el.classList.add("katex-atom");
    if (markCovered) covered.add(el);
  };

  const katexRoots = slideCard.querySelectorAll(".katex-html");
  katexRoots.forEach((root) => {
    if (root.closest(".step-tag, .box-label, .slide-title, .slide-kicker, .plot-title")) return;

    // 1. Compound fractions first: \frac{\partial E}{\partial w_0}, \frac{1}{l}
    root.querySelectorAll(".mfrac").forEach((el) => {
      const txt = el.textContent.replace(/\s+/g, "");
      if (txt.includes("∂") && /w0$/i.test(txt)) addAtom(el, "dE_dw0", true);
      else if (txt.includes("∂") && /w1$/i.test(txt)) addAtom(el, "dE_dw1", true);
      else if (txt.includes("∂") && /w[ijk]$/i.test(txt)) addAtom(el, "dE_dwj", true);
      else if (txt === "1l") addAtom(el, "one_over_l", true);
    });

    // 2. Walk elements in DOM reading order for clean left-to-right alignment
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      const el = node;
      if (isCovered(el)) continue;

      // Operators: outer .mop only (skip inner .op-symbol so \sum doesn't register twice!)
      if (el.classList.contains("mop") && !el.parentElement?.closest(".mop")) {
        const txt = el.textContent.replace(/\s+/g, "");
        if (txt.includes("∑")) addAtom(el, "sum", true);
        else if (txt.includes("∫")) addAtom(el, "int", true);
        else if (txt === "Cov") addAtom(el, "Cov", true);
        else if (txt === "Var") addAtom(el, "Var", true);
        else if (txt === "Bias") addAtom(el, "Bias", true);
        else if (txt === "sign") addAtom(el, "sign", true);
        continue;
      }

      // Square roots
      if (el.classList.contains("sqrt")) {
        addAtom(el, "sqrt", false);
        continue;
      }

      // Accented bars (\bar d, \bar x, \bar h)
      if (el.classList.contains("accent") && el.classList.contains("mord")) {
        const txt = el.textContent.replace(/\s+/g, "");
        if (txt.includes("h")) addAtom(el, "h_bar", true);
        else if (txt.includes("d")) addAtom(el, "d_bar", true);
        else if (txt.includes("x")) addAtom(el, "x_bar", true);
        continue;
      }

      // Compound subscript/superscript .mord (including x_p^2 which KaTeX orders as "x2p"!)
      if (el.classList.contains("mord") && !el.closest(".msupsub")) {
        const hasSubSup = Boolean(el.querySelector(":scope > .msupsub"));
        const txt = el.textContent.replace(/\s+/g, "");

        if (hasSubSup) {
          if (/^x(?:2p|p2)$/i.test(txt)) {
            addAtom(el, "x_p_sq", true);
            addAtom(el, "x_p", true);
          } else if (/^w0$/i.test(txt)) addAtom(el, "w_0", true);
          else if (/^w1$/i.test(txt)) addAtom(el, "w_1", true);
          else if (/^w2$/i.test(txt)) addAtom(el, "w_2", true);
          else if (/^w[ijkm\*]$/i.test(txt) || /^wnew$/i.test(txt)) addAtom(el, "w_j", true);
          else if (/^xp$/i.test(txt) || /^xpT$/i.test(txt)) addAtom(el, "x_p", true);
          else if (/^x1$/i.test(txt)) addAtom(el, "x_1", true);
          else if (/^x2$/i.test(txt)) addAtom(el, "x_2", true);
          else if (/^x[ijkt0]$/i.test(txt) || /^xp,[ij]$/i.test(txt)) addAtom(el, "x_i", true);
          else if (/^d[pi]$/i.test(txt)) addAtom(el, "d_p", true);
          else if (/^Remp$/i.test(txt)) addAtom(el, "R_emp", true);
          else if (/^ERMS$/i.test(txt)) addAtom(el, "E_RMS", true);
          else if (/^hw$/i.test(txt)) addAtom(el, "h_w", true);
          else if (/^XT$/.test(txt)) addAtom(el, "X_T", true);
          else if (/^X\+$/.test(txt)) addAtom(el, "X_plus", true);
          else if (/^σ2$/.test(txt)) addAtom(el, "sigma", true);
          else if (/^δ[pi]?$/.test(txt)) addAtom(el, "delta", true);
          else if (/^θ/.test(txt)) addAtom(el, "theta", true);
          else if (/^φ/.test(txt)) addAtom(el, "phi", true);
          continue;
        }

        // Leaf single-token symbols
        if (!el.querySelector(".mord")) {
          if (txt === "λ") addAtom(el, "lambda", true);
          else if (txt === "η") addAtom(el, "eta", true);
          else if (txt === "δ" || txt === "Δ") addAtom(el, "delta", true);
          else if (txt === "σ") addAtom(el, "sigma", true);
          else if (txt === "θ") addAtom(el, "theta", true);
          else if (txt === "ε" || txt === "ϵ") addAtom(el, "eps", true);
          else if (txt === "π") addAtom(el, "pi", true);
          else if (txt === "ϕ" || txt === "φ") addAtom(el, "phi", true);
          else if (txt === "∇") addAtom(el, "nabla", true);
          else if (txt === "∥") addAtom(el, "norm", true);
          else if (txt === "VC") addAtom(el, "VC", true);
          else if (txt === "E" && el.classList.contains("mathnormal")) addAtom(el, "E_w", true);
          else if (txt === "w" && el.classList.contains("mathbf")) addAtom(el, "w_vec", true);
        }
      }
    }

    root.querySelectorAll("[id^='f-']").forEach((el) => {
      el.classList.add("katex-atom");
    });
  });

  return atoms;
}

export class LiveSyncEngine {
  constructor(stageEl, onSeek) {
    this.stage = stageEl;
    this.onSeek = onSeek;
    this.enabled = true;
    this.clauses = [];
    this.blocks = [];
    this.atoms = [];
    this.words = [];
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    this.stage.classList.toggle("live-sync-enabled", this.enabled);
    if (!this.enabled) {
      this.clearVisuals();
      this.stage.querySelectorAll(".svg-drawable").forEach((p) => p.classList.add("svg-drawn"));
    }
  }

  clearVisuals() {
    this.stage.querySelectorAll(".voice-active, .voice-spoken").forEach((el) => {
      el.classList.remove("voice-active", "voice-spoken");
    });
    this.stage.querySelectorAll(".vw-lit, .vw-cur").forEach((el) => {
      el.classList.remove("vw-lit", "vw-cur");
    });
    this.stage.querySelectorAll(".math-live-glow").forEach((el) => {
      el.classList.remove("math-live-glow");
    });
    this.stage.querySelectorAll(".spotlight-active, .spotlight-dim").forEach((el) => {
      el.classList.remove("spotlight-active", "spotlight-dim");
    });
  }

  prepareScene(scene, subtitles) {
    this.clearVisuals();
    this.clauses = [];
    this.blocks = [];
    this.atoms = [];
    this.words = [];

    const slideCard = this.stage.querySelector(".slide-card");
    if (!slideCard) return;

    // 1. Collect reveal timestamps per element from cues
    const showAtMap = new Map();
    const untilMap = new Map();
    for (const cue of scene.cues || []) {
      if (cue.action === "show") {
        this.stage.querySelectorAll(cue.target).forEach((el) => {
          const prev = showAtMap.get(el);
          if (prev === undefined || cue.at < prev) showAtMap.set(el, cue.at);
          if (typeof cue.until === "number") untilMap.set(el, cue.until);
        });
      }
    }

    const blockSelectors = ".box, .math-card, .proof-step, .svg-panel, .acad-table, .pill-strip, .props-grid, .metrics-row, .gate-card, .plot-card";
    const rawBlocks = Array.from(slideCard.querySelectorAll(blockSelectors)).filter(
      (el) => !el.parentElement?.closest(".box, .math-card, .proof-step, .svg-panel")
    );

    const getShowAt = (el) => {
      let cur = el;
      while (cur && cur !== slideCard) {
        if (showAtMap.has(cur)) return showAtMap.get(cur);
        cur = cur.parentElement;
      }
      return 0;
    };

    const getUntilAt = (el) => {
      let cur = el;
      while (cur && cur !== slideCard) {
        if (untilMap.has(cur)) return untilMap.get(cur);
        cur = cur.parentElement;
      }
      return null;
    };

    // 2. Flatten MMS_FA word-level timestamps
    if (subtitles && Array.isArray(subtitles.segments)) {
      for (const seg of subtitles.segments) {
        if (Array.isArray(seg.words)) {
          for (const w of seg.words) {
            this.words.push({
              raw: w.text,
              clean: stripAccents(w.text),
              tok: normToken(w.text),
              start: w.start,
              end: w.end
            });
          }
        }
      }
    }
    const totalDur = (subtitles && subtitles.duration) || 60;

    // 3. Build Block timeline (each block owns [showAt, cueEnd])
    const sortedShowCues = (scene.cues || [])
      .filter((c) => c.action === "show")
      .sort((a, b) => a.at - b.at);

    for (const bEl of rawBlocks) {
      const showAt = getShowAt(bEl);
      const explicitUntil = getUntilAt(bEl);
      let cueEnd = explicitUntil !== null ? explicitUntil : totalDur;
      if (explicitUntil === null) {
        for (const c of sortedShowCues) {
          if (c.at > showAt + 0.4) {
            cueEnd = c.at;
            break;
          }
        }
      }
      this.blocks.push({ el: bEl, showAt, cueEnd });
    }

    // 4. Wrap prose clauses word-by-word & align monotonically
    const clauseCandidates = [];
    for (const b of this.blocks) {
      const bEl = b.el;
      if (bEl.classList.contains("svg-panel")) continue;
      const textTargets = bEl.querySelectorAll("p, li, td");
      textTargets.forEach((tEl) => {
        if (tEl.closest(".katex")) return;
        const wrapped = wrapClausesWordByWord(tEl);
        for (const wObj of wrapped) {
          const toks = extractTokens(wObj.el.textContent || "");
          if (toks.length >= 2) {
            clauseCandidates.push({
              el: wObj.el,
              wordEls: wObj.wordEls,
              block: bEl,
              tokens: toks,
              showAt: b.showAt,
              start: -1,
              end: -1
            });
          }
        }
      });
    }

    if (this.words.length > 0 && clauseCandidates.length > 0) {
      let monoWordCursor = 0;
      for (const item of clauseCandidates) {
        const cSet = new Set(item.tokens);
        const minHits = item.tokens.length >= 4 ? 3 : 2;
        const minRecall = 0.5;
        const winSize = Math.min(28, Math.max(8, item.tokens.length * 3 + 4));

        let startIdx = monoWordCursor;
        while (startIdx < this.words.length && this.words[startIdx].end < item.showAt - 0.6) {
          startIdx++;
        }
        if (item.showAt > 0 && startIdx > 0 && this.words[Math.min(monoWordCursor, this.words.length - 1)].start < item.showAt - 1.0) {
          let s2 = 0;
          while (s2 < this.words.length && this.words[s2].end < item.showAt - 0.6) s2++;
          startIdx = Math.max(startIdx, s2);
        }

        let bestScore = 0;
        let bestRange = null;
        for (let i = startIdx; i < this.words.length; i++) {
          const wTok = this.words[i].tok;
          if (!wTok || !cSet.has(wTok)) continue;
          const matched = new Set();
          let firstMatch = i;
          let lastMatch = i;
          const endLim = Math.min(this.words.length, i + winSize);
          for (let j = i; j < endLim; j++) {
            const jt = this.words[j].tok;
            if (jt && cSet.has(jt)) {
              matched.add(jt);
              lastMatch = j;
            }
          }
          const hits = matched.size;
          const recall = hits / cSet.size;
          if (hits >= minHits && recall >= minRecall) {
            const span = Math.max(1, lastMatch - firstMatch + 1);
            const density = hits / span;
            const timeDist = Math.abs(this.words[firstMatch].start - item.showAt);
            const proxBonus = item.showAt > 0 && timeDist < 22 ? 0.14 : 0;
            const score = recall * 0.68 + Math.min(1, density * 1.4) * 0.24 + proxBonus;
            if (score > bestScore) {
              bestScore = score;
              bestRange = [firstMatch, lastMatch];
            }
          }
        }

        if (bestRange && bestScore >= 0.54) {
          const [i0, i1] = bestRange;
          const t0 = Math.max(0, this.words[i0].start - 0.08);
          const t1 = Math.min(totalDur, this.words[i1].end + 0.18);
          item.start = t0;
          item.end = Math.max(t0 + 0.45, t1);
          monoWordCursor = Math.min(this.words.length - 1, i0 + 1);
          item.el.classList.add("voice-syncable");
          item.el.title = `Vai a ${this._fmt(t0)}`;
          item.el.addEventListener("click", (e) => {
            e.stopPropagation();
            if (typeof this.onSeek === "function") this.onSeek(t0);
          });
        }
      }
    }

    this.clauses = clauseCandidates.filter((c) => c.start >= 0);

    // 5. Index KaTeX atoms and align them SEQUENTIALLY LEFT-TO-RIGHT per block against exact spoken math events!
    this.atoms = indexFormulaAtoms(slideCard);
    if (this.atoms.length > 0 && this.words.length > 0) {
      const mathEvents = extractSpokenMathEvents(this.words);
      // Group atoms by their owning block (already in exact left-to-right DOM order)
      const atomsByBlock = new Map();
      for (const a of this.atoms) {
        if (!atomsByBlock.has(a.block)) atomsByBlock.set(a.block, []);
        atomsByBlock.get(a.block).push(a);
      }

      for (const b of this.blocks) {
        const bAtoms = atomsByBlock.get(b.el);
        if (!bAtoms || bAtoms.length === 0) continue;

        // Filter spoken math events belonging to this block's time window [showAt - 0.35, cueEnd + 0.35]
        const bEvents = mathEvents.filter(
          (ev) => ev.end >= b.showAt - 0.35 && ev.start <= b.cueEnd + 0.35
        );
        if (bEvents.length === 0) continue;

        // Walk monotonically left-to-right through bAtoms so repeated symbols (e.g. 6 sums) glow ONE AT A TIME in order!
        let cursor = 0;
        for (const ev of bEvents) {
          let picked = -1;
          // Prefer next occurrence forward from cursor (within generous forward lookahead of 12 atoms)
          const lookLim = Math.min(bAtoms.length, cursor + 12);
          for (let k = cursor; k < lookLim; k++) {
            if (bAtoms[k].keys.has(ev.key)) {
              picked = k;
              break;
            }
          }
          // Fallback 1: anywhere further forward in the block
          if (picked === -1) {
            for (let k = lookLim; k < bAtoms.length; k++) {
              if (bAtoms[k].keys.has(ev.key)) {
                picked = k;
                break;
              }
            }
          }
          // Fallback 2: speaker revisited an earlier symbol in this same block -> pick nearest previous match
          if (picked === -1) {
            for (let k = Math.min(cursor - 1, bAtoms.length - 1); k >= 0; k--) {
              if (bAtoms[k].keys.has(ev.key)) {
                picked = k;
                break;
              }
            }
          }

          if (picked !== -1) {
            bAtoms[picked].windows.push({
              start: Math.max(b.showAt, ev.start - 0.08),
              end: ev.end + 0.24
            });
            // Advance cursor past picked atom only when moving forward (preserves left-to-right sweep)
            if (picked >= cursor) {
              cursor = picked + 1;
            }
          }
        }
      }
    }

    // 6. Prep smooth SVG stroke-draw for continuous curve paths
    slideCard.querySelectorAll(".diagram-svg path[class*='svg-curve-']").forEach((p) => {
      if (p.getAttribute("stroke-dasharray") || p.classList.contains("svg-curve-ink-dash")) return;
      try {
        const len = p.getTotalLength();
        if (len > 20 && len < 3000) {
          p.classList.add("svg-drawable");
          p.style.setProperty("--path-len", `${Math.ceil(len)}`);
        }
      } catch {}
    });

    this.stage.classList.toggle("live-sync-enabled", this.enabled);
  }

  update(t, isRevealAll) {
    // 1. ALWAYS keep SVG curve visibility synced (even when Reveal All is on or Focus live is off!)
    this.stage.querySelectorAll(".svg-drawable").forEach((p) => {
      const hiddenAncestor = p.closest(".cue-hidden");
      if (isRevealAll || !this.enabled || !hiddenAncestor) {
        p.classList.add("svg-drawn");
      } else {
        p.classList.remove("svg-drawn");
      }
    });

    if (!this.enabled || isRevealAll) {
      this.clearVisuals();
      return;
    }

    // 2. Word-by-word sequential clause highlighting
    let bestClause = null;
    for (const c of this.clauses) {
      const isVisible = !c.block.classList.contains("cue-hidden");
      if (isVisible && t >= c.start && t <= c.end) {
        if (!bestClause || c.start > bestClause.start) {
          bestClause = c;
        }
      }
    }

    for (const c of this.clauses) {
      if (c === bestClause) {
        c.el.classList.add("voice-active");
        c.el.classList.remove("voice-spoken");
        const frac = Math.max(0.05, Math.min(1, (t - c.start) / Math.max(0.25, c.end - c.start)));
        const n = c.wordEls.length;
        const activeIdx = Math.min(n - 1, Math.floor(frac * n));
        for (let k = 0; k < n; k++) {
          const wEl = c.wordEls[k];
          wEl.classList.toggle("vw-lit", k <= activeIdx);
          wEl.classList.toggle("vw-cur", k === activeIdx);
        }
      } else {
        c.el.classList.remove("voice-active");
        const isPast = t > c.end;
        c.el.classList.toggle("voice-spoken", isPast);
        for (const wEl of c.wordEls) {
          wEl.classList.remove("vw-lit", "vw-cur");
        }
      }
    }

    // 3. Determine SINGLE active Spotlight block
    let activeBlock = null;
    const explicitHl = this.stage.querySelector(".cue-highlight");
    if (explicitHl) {
      activeBlock = explicitHl.closest(".box, .math-card, .proof-step, .svg-panel, .acad-table, .pill-strip, .props-grid, .metrics-row");
    }
    if (!activeBlock && bestClause) {
      activeBlock = bestClause.block;
    }
    if (!activeBlock) {
      let latestShow = -1;
      for (const b of this.blocks) {
        if (!b.el.classList.contains("cue-hidden") && t >= b.showAt && b.showAt >= latestShow) {
          latestShow = b.showAt;
          activeBlock = b.el;
        }
      }
    }

    // 4. SEQUENTIAL MONOTONIC FORMULA-ATOM GLOW (STRICTLY inside activeBlock — single exact atom at a time!)
    for (const atom of this.atoms) {
      const visible = !atom.block.classList.contains("cue-hidden");
      const inActiveBlock = !activeBlock || atom.block === activeBlock;
      let hit = false;
      if (visible && inActiveBlock && atom.windows.length > 0) {
        for (const w of atom.windows) {
          if (t >= w.start && t <= w.end) {
            hit = true;
            break;
          }
        }
      }
      atom.el.classList.toggle("math-live-glow", hit);
    }

    // 5. Apply gentle Spotlight to active block
    const visibleBlocks = this.blocks.filter((b) => !b.el.classList.contains("cue-hidden"));
    const shouldDim = visibleBlocks.length >= 2 && Boolean(activeBlock) && t > 0.25;

    for (const b of this.blocks) {
      if (!shouldDim) {
        b.el.classList.remove("spotlight-active", "spotlight-dim");
      } else if (b.el === activeBlock) {
        b.el.classList.add("spotlight-active");
        b.el.classList.remove("spotlight-dim");
      } else if (!b.el.classList.contains("cue-hidden")) {
        b.el.classList.remove("spotlight-active");
        b.el.classList.add("spotlight-dim");
      }
    }
  }

  _fmt(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
}
