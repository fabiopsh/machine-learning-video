// Real-Time Voice-to-Slide Live Sync v2
// Fixes:
//  1. Sequential word-by-word highlighting (NEVER parallel across wrapped 2-line sentences!)
//  2. Strict monotonic alignment with high-precision lexical matching (zero spurious highlights)
//  3. Automatic real-time individual KaTeX formula-term glowing synced to spoken math terms
//  4. Smooth Spotlight focus + Click-to-Seek + SVG live stroke-draw

const STOPWORDS = new Set([
  "di","a","da","in","con","su","per","tra","fra","il","lo","la","i","gli","le",
  "un","uno","una","e","ed","o","od","ma","che","chi","cui","se","al","allo","alla",
  "ai","agli","alle","del","dello","della","dei","degli","delle","nel","nello","nella",
  "nei","negli","nelle","sul","sullo","sulla","sui","sugli","sulle","dal","dallo","dalla",
  "si","ci","vi","ne","non","piu","meno","come","dove","quando","anche","solo",
  "sono","era","sia","puo","ha","hanno","fare","fa","suo","sua","suoi","loro",
  "questo","questa","questi","queste","quello","quella","tutti","tutte","ogni",
  "poi","ora","qui","cosi","quindi","cioe","perche","pero","es","cio","molto","ogni",
  "dati","dato","modello","modelli","funzione","funzioni","esempio","esempi","caso"
]);

const MATH_SPOKEN_PATTERNS = [
  // Multi-word patterns checked first against the live spoken rolling window
  { key: "w_0",     rx: /\bw\s*(?:con\s+)?zero\b|\bintercetta\b|\bbias\s+w\b/ },
  { key: "w_1",     rx: /\bw\s*(?:con\s+)?uno\b/ },
  { key: "w_2",     rx: /\bw\s*(?:con\s+)?due\b/ },
  { key: "w_j",     rx: /\bw\s*(?:con\s+)?(?:j|i|k|m)\b|\bsingolo\s+peso\b/ },
  { key: "x_p",     rx: /\bx\s*(?:con\s+)?p\b|\b(?:p|i)-?esimo\s+(?:esempio|pattern)\b/ },
  { key: "x_1",     rx: /\bx\s*(?:con\s+)?uno\b/ },
  { key: "x_2",     rx: /\bx\s*(?:con\s+)?due\b/ },
  { key: "x_i",     rx: /\bx\s*(?:con\s+)?(?:i|j|k|t)\b/ },
  { key: "d_p",     rx: /\bd\s*(?:con\s+)?(?:p|i)\b|\btarget\s+d\b/ },
  { key: "h_bar",   rx: /\bh\s+soprassegnat[oa]\b|\bpredizione\s+media\b/ },
  { key: "d_bar",   rx: /\bd\s+soprassegnat[oa]\b|\bmedia\s+d\b/ },
  { key: "x_bar",   rx: /\bx\s+soprassegnat[oa]\b|\bmedia\s+x\b/ },
  { key: "h_w",     rx: /\bh\s*(?:con\s+w\s*)?di\s+x\b|\bipotesi\s+h\b/ },
  { key: "E_w",     rx: /\be\s+di\s+w\b|\berrore\s+(?:empirico|quadratico|medio)\b|\bsomma\s+dei\s+quadrati\b/ },
  { key: "R_emp",   rx: /\br\s*emp\b|\brischio\s+empirico\b/ },
  { key: "E_RMS",   rx: /\be\s*rms\b|\broot[\s-]mean[\s-]square\b/ },
  { key: "VC",      rx: /\bvc[\s-]dimension\b|\bvc\b/ },
  { key: "Cov",     rx: /\bcovarianza\b/ },
  { key: "Var",     rx: /\bvarianza\b/ },
  { key: "Bias",    rx: /\bbias(?:\s+al\s+quadrato)?\b/ },
  { key: "sum",     rx: /\bsomma(?:toria)?\b/ },
  { key: "int",     rx: /\bintegrale\b/ },
  { key: "sqrt",    rx: /\bradice(?:\s+quadrata)?\b/ },
  { key: "nabla",   rx: /\bgradiente\b|\bderivata\b/ },
  { key: "norm",    rx: /\bnorma(?:\s+quadra|\s+al\s+quadrato)?\b/ },
  { key: "lambda",  rx: /\blambda\b/ },
  { key: "eta",     rx: /\beta\b|\blearning\s+rate\b/ },
  { key: "delta",   rx: /\bdelta\b/ },
  { key: "sigma",   rx: /\bsigma\b|\brumore\b/ },
  { key: "theta",   rx: /\btheta\b/ },
  { key: "eps",     rx: /\bepsilon\b|\bvc[\s-]confidence\b/ },
  { key: "pi",      rx: /\bpi\s+greco\b/ },
  { key: "phi",     rx: /\bphi\b|\bfunzioni\s+di\s+base\b/ },
  { key: "sign",    rx: /\bsegno\b|\bsign\b/ },
  { key: "X_T",     rx: /\bx\s+trasposto\b/ },
  { key: "X_plus",  rx: /\bx\s+pi[uù]\b|\bpseudoinversa\b/ },
  { key: "Loss",    rx: /\bloss\b|\bfunzione\s+obiettivo\b/ },
  { key: "w_vec",   rx: /\bvettore\s+(?:dei\s+pesi\s+)?w\b|\bpesi\s+w\b|\bnuovo\s+w\b|\bw\s+nuovo\b/ }
];

function stripAccents(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normToken(raw) {
  let t = stripAccents(raw).replace(/[^a-z0-9]+/g, "");
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

// Wrap a text-containing element into clause spans where each word is an individual <span class="vw">
// so multi-line sentences illuminate sequentially word-by-word across lines (NEVER in parallel!).
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

  const processInlineNode = (node, targetParent) => {
    if (node.nodeType === Node.TEXT_NODE) {
      appendTextWords(targetParent, node.textContent || "");
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.classList.contains("katex") || node.classList.contains("katex-display")) {
        const wrap = document.createElement("span");
        wrap.className = "vw vw-math";
        wrap.appendChild(node);
        targetParent.appendChild(wrap);
        curWords.push(wrap);
        return;
      }
      // Inline formatting (<strong>, <em>, <span>) -> recurse inside so words stay individually highlightable
      const clone = node.cloneNode(false);
      Array.from(node.childNodes).forEach((ch) => processInlineNode(ch, clone));
      targetParent.appendChild(clone);
    }
  };

  for (const node of nodes) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      if (tag === "br" || tag === "ul" || tag === "ol" || tag === "div" || tag === "table" || tag === "svg") {
        flush();
        fragment.appendChild(node);
        continue;
      }
      processInlineNode(node, curClause);
    } else if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || "";
      const pieces = text.split(/(?<=[.;!?·])\s+/);
      pieces.forEach((piece, idx) => {
        if (idx > 0) {
          flush();
          fragment.appendChild(document.createTextNode(" "));
        }
        if (piece) appendTextWords(curClause, piece);
      });
    }
  }
  flush();

  el.innerHTML = "";
  el.appendChild(fragment);
  return clauses;
}

// Classify a rendered KaTeX DOM element into semantic math keys so individual formula pieces glow when spoken!
function indexFormulaAtoms(slideCard) {
  const atoms = []; // { el, keys: Set<string>, block }
  const seen = new Set();

  const addAtom = (el, key) => {
    if (!el || !key) return;
    let rec = atoms.find((a) => a.el === el);
    if (!rec) {
      const block = el.closest(".box, .math-card, .proof-step, .acad-table, .pill-strip, .props-grid, .metrics-row, .gate-card, .plot-card") || el;
      rec = { el, keys: new Set(), block };
      atoms.push(rec);
    }
    rec.keys.add(key);
    el.classList.add("katex-atom");
  };

  const katexRoots = slideCard.querySelectorAll(".katex-html");
  katexRoots.forEach((root) => {
    // 1. Operators: \sum, \int, \Cov, \Var, \Bias, \sign, \nabla
    root.querySelectorAll(".mop").forEach((el) => {
      const txt = el.textContent.trim();
      if (txt.includes("∑")) addAtom(el, "sum");
      else if (txt.includes("∫")) addAtom(el, "int");
      else if (txt === "Cov") addAtom(el, "Cov");
      else if (txt === "Var") addAtom(el, "Var");
      else if (txt === "Bias") addAtom(el, "Bias");
      else if (txt === "sign") addAtom(el, "sign");
    });

    // 2. Square roots
    root.querySelectorAll(".sqrt").forEach((el) => addAtom(el, "sqrt"));

    // 3. Accented bars (\bar h, \bar d, \bar x)
    root.querySelectorAll(".accent").forEach((el) => {
      const txt = el.textContent.replace(/\s+/g, "");
      if (txt.includes("h")) addAtom(el, "h_bar");
      else if (txt.includes("d")) addAtom(el, "d_bar");
      else if (txt.includes("x")) addAtom(el, "x_bar");
    });

    // 4. Compound subscript/superscript symbols (.mord containing .msupsub)
    root.querySelectorAll(".mord").forEach((el) => {
      if (el.closest(".msupsub")) return; // skip inner sub/sup pieces when parent covers it
      const hasSubSup = Boolean(el.querySelector(":scope > .msupsub"));
      const txt = el.textContent.replace(/\s+/g, "");

      if (hasSubSup) {
        if (/^w0$/i.test(txt)) addAtom(el, "w_0");
        else if (/^w1$/i.test(txt)) addAtom(el, "w_1");
        else if (/^w2$/i.test(txt)) addAtom(el, "w_2");
        else if (/^w[ijkm\*]/.test(txt) || /^wnew$/i.test(txt)) addAtom(el, "w_j");
        else if (/^xp/i.test(txt)) addAtom(el, "x_p");
        else if (/^x1$/i.test(txt)) addAtom(el, "x_1");
        else if (/^x2$/i.test(txt)) addAtom(el, "x_2");
        else if (/^x[ijkt]$/i.test(txt)) addAtom(el, "x_i");
        else if (/^d[pi]$/i.test(txt)) addAtom(el, "d_p");
        else if (/^Remp$/i.test(txt)) addAtom(el, "R_emp");
        else if (/^ERMS$/i.test(txt)) addAtom(el, "E_RMS");
        else if (/^hw$/i.test(txt)) addAtom(el, "h_w");
        else if (/^XT$/.test(txt)) addAtom(el, "X_T");
        else if (/^X\+$/.test(txt)) addAtom(el, "X_plus");
        else if (/^σ2$/.test(txt)) addAtom(el, "sigma");
        else if (/^δ[pi]?$/.test(txt)) addAtom(el, "delta");
        else if (/^θ/.test(txt)) addAtom(el, "theta");
        else if (/^φ/.test(txt)) addAtom(el, "phi");
        seen.add(el);
        return;
      }

      // Single-token math atoms (only leaf .mord without children .mord)
      if (el.querySelector(".mord")) return;
      if (txt === "λ") addAtom(el, "lambda");
      else if (txt === "η") addAtom(el, "eta");
      else if (txt === "δ" || txt === "Δ") addAtom(el, "delta");
      else if (txt === "σ") addAtom(el, "sigma");
      else if (txt === "θ") addAtom(el, "theta");
      else if (txt === "ε" || txt === "ϵ") addAtom(el, "eps");
      else if (txt === "π") addAtom(el, "pi");
      else if (txt === "ϕ" || txt === "φ") addAtom(el, "phi");
      else if (txt === "∇" || txt === "∂") addAtom(el, "nabla");
      else if (txt === "∥") addAtom(el, "norm");
      else if (txt === "VC") addAtom(el, "VC");
      else if (txt === "Loss") addAtom(el, "Loss");
      else if (txt === "E" && el.classList.contains("mathnormal")) addAtom(el, "E_w");
      else if (txt === "w" && el.classList.contains("mathbf")) addAtom(el, "w_vec");
    });

    // 5. Explicit \htmlId spans get semantic tags from their text too
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
    this.clauses = [];   // { el, wordEls, block, start, end }
    this.blocks = [];    // { el, showAt, cueEnd, start, end }
    this.atoms = [];     // { el, keys, block }
    this.words = [];     // flattened MMS_FA word timeline
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
    for (const cue of scene.cues || []) {
      if (cue.action === "show") {
        this.stage.querySelectorAll(cue.target).forEach((el) => {
          const prev = showAtMap.get(el);
          if (prev === undefined || cue.at < prev) showAtMap.set(el, cue.at);
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

    // 3. Wrap prose clauses word-by-word (NEVER touching KaTeX internals)
    const textTargets = slideCard.querySelectorAll(".box p, .box li, .math-note, .proof-step > div, .prop-item, .acad-table tbody td");
    const clauseCandidates = [];
    textTargets.forEach((target) => {
      if (target.querySelector(".katex-display") && target.textContent.replace(/\s+/g, "").length < 22) {
        return;
      }
      const parentBlock = target.closest(blockSelectors) || target;
      const wrapped = wrapClausesWordByWord(target);
      for (const c of wrapped) {
        const toks = extractTokens(c.el.textContent);
        if (toks.length >= 2) {
          clauseCandidates.push({
            el: c.el,
            wordEls: c.wordEls,
            block: parentBlock,
            showAt: getShowAt(c.el),
            tokens: toks,
            start: -1,
            end: -1
          });
        }
      }
    });

    // 4. Strict monotonic alignment of clauses to spoken timeline (high precision, zero random jumps!)
    if (this.words.length > 0) {
      const sortedShowCues = (scene.cues || [])
        .filter((c) => c.action === "show")
        .sort((a, b) => a.at - b.at);

      let lastWordCursorByBlock = new Map();

      for (const item of clauseCandidates) {
        const tokSet = new Set(item.tokens);
        // Restrict search window to after block reveal and before much later unrelated sections
        const minTime = Math.max(0, item.showAt - 1.2);
        let nextShowTime = totalDur;
        for (const sc of sortedShowCues) {
          if (sc.at > item.showAt + 4.0) {
            nextShowTime = Math.min(totalDur, sc.at + 6.0);
            break;
          }
        }

        let startIdx = 0;
        while (startIdx < this.words.length && this.words[startIdx].end < minTime) startIdx++;
        const prevCursor = lastWordCursorByBlock.get(item.block);
        if (typeof prevCursor === "number") {
          startIdx = Math.max(startIdx, prevCursor);
        }

        const winSize = Math.min(20, Math.max(7, Math.round(item.tokens.length * 1.9)));
        let bestScore = 0;
        let bestI = -1;
        let bestJ = -1;

        for (let i = startIdx; i < this.words.length; i++) {
          if (this.words[i].start > nextShowTime) break;
          const endLim = Math.min(this.words.length, i + winSize);
          const matched = new Set();
          let weightSum = 0;
          let firstHit = -1;
          let lastHit = -1;

          for (let j = i; j < endLim; j++) {
            const wt = this.words[j].tok;
            if (wt && tokSet.has(wt) && !matched.has(wt)) {
              matched.add(wt);
              weightSum += (wt.length >= 6 ? 1.45 : 1.0);
              if (firstHit === -1) firstHit = j;
              lastHit = j;
            }
          }

          if (firstHit !== -1) {
            const recall = matched.size / Math.max(1, tokSet.size);
            // Require strong evidence: at least 2 content words & >= 38% recall, OR 1 long unique keyword when short
            const strong = (matched.size >= 2 && recall >= 0.36) || (tokSet.size <= 2 && matched.size === 1 && weightSum >= 1.4);
            if (strong) {
              const spanPenalty = (lastHit - firstHit) * 0.03;
              const score = weightSum * 0.8 + recall * 2.4 - spanPenalty;
              if (score > bestScore) {
                bestScore = score;
                bestI = firstHit;
                bestJ = lastHit;
              }
            }
          }
        }

        if (bestI !== -1 && bestJ !== -1) {
          const t0 = Math.max(0, this.words[bestI].start - 0.12);
          const t1 = Math.min(totalDur, Math.max(this.words[bestJ].end + 0.32, t0 + 1.4));
          item.start = t0;
          item.end = t1;
          lastWordCursorByBlock.set(item.block, Math.max(startIdx, bestI + 1));

          item.el.classList.add("voice-syncable");
          item.el.title = `Clicca per saltare a ${this._fmt(t0)}`;
          item.el.addEventListener("click", (e) => {
            e.stopPropagation();
            if (typeof this.onSeek === "function") this.onSeek(t0);
          });
        }
      }
    }

    this.clauses = clauseCandidates.filter((c) => c.start >= 0);

    // 5. Index individual KaTeX formula terms for real-time voice-to-formula glowing!
    this.atoms = indexFormulaAtoms(slideCard);

    // 6. Build Block timeline for smooth Spotlight
    const sortedShowCues = (scene.cues || [])
      .filter((c) => c.action === "show")
      .sort((a, b) => a.at - b.at);

    for (const bEl of rawBlocks) {
      const showAt = getShowAt(bEl);
      let cueEnd = totalDur;
      for (const c of sortedShowCues) {
        if (c.at > showAt + 0.4) {
          cueEnd = c.at;
          break;
        }
      }
      this.blocks.push({ el: bEl, showAt, cueEnd });
    }

    // 7. Prep smooth SVG stroke-draw for continuous curve paths
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

    // 2. Word-by-word sequential clause highlighting (line 1 -> THEN line 2, ZERO parallel sweep!)
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

    // 3. Determine active Spotlight block
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

    // 4. REAL-TIME FORMULA-TERM GLOW: match live spoken 6-word window against KaTeX formula atoms!
    const spokenWindow = this._getSpokenWindow(t, 0.45, 0.55);
    const activeMathKeys = new Set();
    if (spokenWindow) {
      for (const pat of MATH_SPOKEN_PATTERNS) {
        if (pat.rx.test(spokenWindow)) {
          activeMathKeys.add(pat.key);
        }
      }
    }

    for (const atom of this.atoms) {
      const visible = !atom.block.classList.contains("cue-hidden");
      // Prefer illuminating atoms inside the currently active block (or any visible math-card/theorem)
      const inFocus = !activeBlock || atom.block === activeBlock || atom.block.classList.contains("math-card") || atom.block.classList.contains("box-theorem");
      let hit = false;
      if (visible && inFocus && activeMathKeys.size > 0) {
        for (const k of atom.keys) {
          if (activeMathKeys.has(k)) {
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

  _getSpokenWindow(t, lookback, lookahead) {
    if (this.words.length === 0) return "";
    const out = [];
    for (const w of this.words) {
      if (w.end >= t - lookback && w.start <= t + lookahead) {
        out.push(w.clean);
      } else if (w.start > t + lookahead) {
        break;
      }
    }
    return out.join(" ");
  }

  _fmt(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
}
