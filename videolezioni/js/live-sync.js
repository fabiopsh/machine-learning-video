// Real-Time Voice-to-Slide Live Sync v4
// Upgrades over v3:
//  1. Universal KaTeX Atomizer: indexes ALL variables, subscripts/superscripts, primes, bars, norms,
//     operators, Greek symbols, powers, inline derivatives, integers & Italian decimals (grouped multi-span atoms).
//  2. Full Italian Math-Speech + Number Parser: handles multi-word Italian numbers/decimals/powers/symbols
//     while guarding against Italian prose stopwords (e, i, a, bare small integers).
//  3. Viterbi Monotonic Sequence Aligner per block + cross-block visible fallback + table-row highlight awareness
//     (fixes nested block mismatch and side-SVG cueEnd truncation!).
//  4. Strict SINGLE-ATOM invariant: globally non-overlapping windows + single winning atom at every instant t
//     (zero simultaneous multi-atom flashing!).
//  5. Word-by-word sequential clause highlighting + Spotlight + Click-to-Seek + reliable SVG draw.

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
  // Light Italian morphological stemmer so singular/plural & verb inflections match cleanly
  // (e.g. epoche/epoca, errori/errore, pesi/peso, neuroni/neurone, vettori/vettore, classi/classe)
  if (t.length >= 6) {
    t = t.replace(/(azioni|azione|zioni|zione|menti|mento|abili|abile|ibili|ibile|ando|endo|iamo|ate|ete|ite|are|ere|ire|ita|iche|ichi|che|chi)$/, "");
  }
  if (t.length >= 4 && !/^\d+$/.test(t)) {
    t = t.replace(/[aeiou]$/, "");
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

// ---------- Italian Number Word Parser ----------

const IT_UNITS = {
  zero: 0, uno: 1, un: 1, due: 2, tre: 3, quattro: 4,
  cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9
};
const IT_TEENS = {
  dieci: 10, undici: 11, dodici: 12, tredici: 13, quattordici: 14,
  quindici: 15, sedici: 16, diciassette: 17, diciotto: 18, diciannove: 19
};
const IT_TENS = [
  ["venti", 20], ["vent", 20],
  ["trenta", 30], ["trent", 30],
  ["quaranta", 40], ["quarant", 40],
  ["cinquanta", 50], ["cinquant", 50],
  ["sessanta", 60], ["sessant", 60],
  ["settanta", 70], ["settant", 70],
  ["ottanta", 80], ["ottant", 80],
  ["novanta", 90], ["novant", 90]
];
const IT_UNIT_LIST = [
  ["quattro", 4], ["cinque", 5], ["sette", 7], ["nove", 9],
  ["otto", 8], ["zero", 0], ["uno", 1], ["due", 2], ["tre", 3], ["sei", 6]
];
const IT_TEEN_LIST = Object.entries(IT_TEENS).sort((a, b) => b[0].length - a[0].length);

// Parse a single Italian integer word (e.g. "cinquantacinque" -> 55, "centodieci" -> 110, "sessantacinquemila" -> 65000)
function parseSingleItalianInt(w) {
  if (!w) return null;
  if (/^\d+$/.test(w)) return parseInt(w, 10);
  if (w in IT_UNITS) return IT_UNITS[w];
  if (w in IT_TEENS) return IT_TEENS[w];
  if (w === "cento") return 100;
  if (w === "mille") return 1000;

  let rem = w;
  let total = 0;

  // Handle ...mila (e.g. "sessantacinquemila", "duecentotrentatremila")
  const milaIdx = rem.indexOf("mila");
  if (milaIdx > 0) {
    const mult = parseSubThousand(rem.slice(0, milaIdx));
    if (mult === null) return null;
    total += mult * 1000;
    rem = rem.slice(milaIdx + 4);
    if (!rem) return total;
  } else if (rem.startsWith("mille")) {
    total += 1000;
    rem = rem.slice(5);
    if (!rem) return total;
  }

  const sub = parseSubThousand(rem);
  if (sub === null) return null;
  return total + sub;
}

function parseSubThousand(s) {
  if (!s) return 0;
  if (s in IT_UNITS) return IT_UNITS[s];
  if (s in IT_TEENS) return IT_TEENS[s];
  if (s === "cento") return 100;

  let rem = s;
  let val = 0;

  const cIdx = rem.indexOf("cento");
  const cIdxShort = cIdx === -1 ? rem.indexOf("cent") : -1;
  if (cIdx !== -1 || (cIdxShort !== -1 && /^ott/.test(rem.slice(cIdxShort + 4)))) {
    const idx = cIdx !== -1 ? cIdx : cIdxShort;
    const step = cIdx !== -1 ? 5 : 4;
    const prefix = rem.slice(0, idx);
    let hundreds = 1;
    if (prefix) {
      if (prefix in IT_UNITS && IT_UNITS[prefix] >= 2) hundreds = IT_UNITS[prefix];
      else return null;
    }
    val += hundreds * 100;
    rem = rem.slice(idx + step);
    if (!rem) return val;
  }

  for (const [k, v] of IT_TEEN_LIST) {
    if (rem === k) return val + v;
  }
  for (const [k, v] of IT_TENS) {
    if (rem.startsWith(k)) {
      val += v;
      rem = rem.slice(k.length);
      if (!rem) return val;
      for (const [uk, uv] of IT_UNIT_LIST) {
        if (rem === uk) return val + uv;
      }
      return null;
    }
  }
  for (const [uk, uv] of IT_UNIT_LIST) {
    if (rem === uk) return val + uv;
  }
  return null;
}

function canonicalNumKey(numStr) {
  const n = Number(numStr);
  if (!Number.isFinite(n)) return null;
  // Normalize -0 -> 0 and strip trailing decimal zeros (0.80 -> 0.8)
  const clean = Object.is(n, -0) ? "0" : String(n);
  return `num:${clean}`;
}

const MATH_CONTEXT_CUES = new Set([
  "uguale", "vale", "valgono", "pari", "diviso", "per", "piu", "meno", "alla", "elevato",
  "su", "virgola", "punto", "da", "maggiore", "minore", "va", "risponde", "vota",
  "input", "target", "grado", "soglia", "fattore", "classe", "classi", "valore", "valori",
  "mezzi", "circa", "sotto", "totale", "errore", "accuratezza", "peso", "pesi",
  "zero", "uno", "due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove", "dieci",
  "x", "w", "d", "h", "f", "l", "n", "m", "k", "p", "e", "r", "eta", "lambda", "delta", "sigma"
]);

const PROSE_NUMBER_PREFIXES = new Set([
  "capitolo", "capitoli", "passo", "passi", "scenario", "scenari", "punti",
  "esempio", "esempi", "ingrediente", "ingredienti", "requisito", "requisiti",
  "paradigma", "paradigmi", "fase", "fasi", "ragione", "ragioni", "limite", "limiti",
  "proprieta", "tabella", "figura", "schema", "forma", "forme", "famiglia", "famiglie",
  "domanda", "domande", "scelta", "scelte", "coppia", "coppie", "variabile", "variabili",
  "dimensione", "dimensioni", "modalita", "regola", "regole", "loss", "caso", "casi",
  "punto", "campione", "campioni", "istanza", "istanze", "classe", "classi"
]);

function hasMathContext(cleaned, i, len) {
  if (i > 0 && PROSE_NUMBER_PREFIXES.has(cleaned[i - 1])) return false;
  if (i + len < cleaned.length && PROSE_NUMBER_PREFIXES.has(cleaned[i + len])) return false;
  for (let j = Math.max(0, i - 2); j < Math.min(cleaned.length, i + len + 2); j++) {
    if (j >= i && j < i + len) continue;
    if (MATH_CONTEXT_CUES.has(cleaned[j])) return true;
  }
  return false;
}

// Try to parse an Italian integer/decimal (optionally signed) starting at word index i
function tryParseSpokenNumber(words, cleaned, i) {
  let sign = 1;
  let hasExplicitSign = false;
  let pos = i;

  if (cleaned[pos] === "meno" && pos + 1 < cleaned.length) {
    const nextInt = parseSingleItalianInt(cleaned[pos + 1]);
    if (nextInt !== null) {
      sign = -1;
      hasExplicitSign = true;
      pos += 1;
    }
  } else if (cleaned[pos] === "piu" && pos + 1 < cleaned.length) {
    const nextInt = parseSingleItalianInt(cleaned[pos + 1]);
    if (nextInt !== null && (hasMathContext(cleaned, pos, 2) || cleaned[pos + 2] === "virgola" || cleaned[pos + 2] === "punto")) {
      sign = 1;
      hasExplicitSign = true;
      pos += 1;
    }
  }

  // Never consume standalone "un" as integer 1 unless part of "un mezzo" (handled in grammar)
  if (cleaned[pos] === "un") return null;

  let intVal = parseSingleItalianInt(cleaned[pos]);
  if (intVal === null) return null;
  pos += 1;

  // Merge thousands word + sub-thousand word (e.g. "sessantacinquemila cinquecentotrentasei" -> 65536)
  if (intVal >= 1000 && intVal % 1000 === 0 && pos < cleaned.length) {
    const nextPart = parseSingleItalianInt(cleaned[pos]);
    if (nextPart !== null && nextPart > 0 && nextPart < 1000) {
      intVal += nextPart;
      pos += 1;
    }
  }

  let isDecimal = false;
  let fracStr = "";

  // Check decimal separator: "punto" (always decimal) or "virgola" (decimal if NOT followed by "<num> punto")
  if (pos + 1 < cleaned.length && (cleaned[pos] === "punto" || cleaned[pos] === "virgola")) {
    const sep = cleaned[pos];
    const nextW = cleaned[pos + 1];
    const nextIsPuntoAfter = sep === "virgola" && pos + 2 < cleaned.length && cleaned[pos + 2] === "punto";
    if (!nextIsPuntoAfter && nextW !== "un") {
      if (nextW === "zero" && pos + 2 < cleaned.length) {
        // Support multiple leading zeros after comma: "zero virgola zero zero uno" -> 0.001
        let zCount = 0;
        let zPos = pos + 1;
        while (zPos < cleaned.length && cleaned[zPos] === "zero") {
          zCount++;
          zPos++;
        }
        const tailVal = zPos < cleaned.length ? parseSingleItalianInt(cleaned[zPos]) : null;
        if (tailVal !== null && tailVal >= 0 && tailVal < 100) {
          isDecimal = true;
          fracStr = "0".repeat(zCount) + String(tailVal);
          pos = zPos + 1;
        } else if (sep === "punto") {
          isDecimal = true;
          fracStr = "0".repeat(zCount);
          pos = zPos;
        }
      } else {
        const fracVal = parseSingleItalianInt(nextW);
        if (fracVal !== null && fracVal >= 0 && fracVal < 1000) {
          isDecimal = true;
          fracStr = String(fracVal);
          pos += 2;
        }
      }
    }
  }

  const len = pos - i;
  // Guard bare small integers (1..10) in prose (e.g. "due requisiti", "cinque ingredienti")
  if (!isDecimal && !hasExplicitSign && intVal >= 1 && intVal <= 10) {
    if (!hasMathContext(cleaned, i, len)) return null;
  }

  const numStr = isDecimal
    ? `${sign < 0 ? "-" : ""}${intVal}.${fracStr}`
    : `${sign < 0 ? "-" : ""}${intVal}`;
  const primary = canonicalNumKey(numStr);
  if (!primary) return null;

  const keys = [primary];
  if (sign < 0) {
    const absKey = canonicalNumKey(numStr.replace(/^-/, ""));
    if (absKey && absKey !== primary) keys.push(absKey);
  }
  return {
    keys,
    start: words[i].start,
    end: words[pos - 1].end,
    len,
    specificity: (isDecimal || intVal >= 11 || hasExplicitSign) ? 10 : 7
  };
}

// ---------- Spoken Math Grammar (longest match first) ----------
// Note: rules match on accent-stripped lowercase `slice`; optional `rawTest(rawSlice)` checks case sensitivity.
const SPOKEN_MATH_GRAMMAR = [
  // 1. Derivatives & atomic fractions
  { keys: ["dE_dw0"], rx: /^(?:derivata|derivando)(?:\s+parziale)?(?:\s+di\s+e)?\s+rispetto\s+a\s+w\s*(?:con\s+)?zero$/, spec: 11 },
  { keys: ["dE_dw1"], rx: /^(?:derivata|derivando)(?:\s+parziale)?(?:\s+di\s+e)?\s+rispetto\s+a\s+w\s*(?:con\s+)?uno$/, spec: 11 },
  { keys: ["dE_dwj"], rx: /^(?:derivata|derivando)(?:\s+parziale)?(?:\s+di\s+e)?\s+rispetto\s+a(?:l\s+singolo\s+peso)?\s+w\s*(?:con\s+)?(?:j|i|k)$/, spec: 11 },
  { keys: ["frac:1/l"], rx: /^uno\s+su\s+l$/, spec: 11 },
  { keys: ["frac:1/2"], rx: /^(?:un\s+mezzo|uno\s+su\s+due)$/, spec: 10 },

  // 2. Powers & norms & dimensions
  { keys: ["pow:2^2^n"], rx: /^due\s+(?:elevato\s+a|alla)\s+due\s+alla\s+n$/, spec: 11 },
  { keys: ["pow:2^4"], rx: /^due\s+alla\s+quarta$/, spec: 11 },
  { keys: ["pow:2^16"], rx: /^due\s+alla\s+sedicesima$/, spec: 11 },
  { keys: ["pow:2^9"], rx: /^due\s+alla\s+nona$/, spec: 11 },
  { keys: ["pow:3^n"], rx: /^tre\s+alla\s+n$/, spec: 11 },
  { keys: ["pow:x^j"], rx: /^x\s+alla\s+j$/, spec: 11 },
  { keys: ["pow:x^M"], rx: /^x\s+alla\s+m$/, spec: 11 },
  { keys: ["var:x_p_sq", "var:x_p"], rx: /^x\s*(?:con\s+)?p\s+(?:al\s+quadrato|quadro)$/, spec: 11 },
  { keys: ["var:w_j_sq", "var:w_j"], rx: /^w\s*(?:con\s+)?j\s+(?:al\s+quadrato|quadro)$/, spec: 11 },
  { keys: ["var:w_sq", "var:w"], rx: /^w\s+(?:al\s+quadrato|quadro)$/, spec: 10 },
  { keys: ["pow:x^2", "var:x"], rx: /^x\s+(?:al\s+quadrato|quadro)$/, spec: 10 },
  { keys: ["norm:L1"], rx: /^(?:norma\s+)?l\s+uno$/, spec: 11 },
  { keys: ["norm:L2"], rx: /^(?:norma\s+)?l\s+due$/, spec: 11 },
  { keys: ["set:R^n", "set:R"], rx: /^r\s+alla\s+n$/, spec: 11 },
  { keys: ["set:R^K", "set:R"], rx: /^r\s+alla\s+k$/, spec: 11 },
  { keys: ["dim:lxn"], rx: /^l\s+per\s+n$/, spec: 10 },
  { keys: ["sqrt:2", "op:sqrt"], rx: /^radice(?:\s+quadrata)?\s+di\s+due$/, spec: 11 },

  // 3. Compound Delta / Negation / Subscripts / Superscripts / Primes / Bars
  { keys: ["var:Delta_p_wj", "var:Delta_wj"], rx: /^delta\s*(?:con\s+)?p\s+w\s*(?:con\s+)?j$/, spec: 11 },
  { keys: ["var:Delta_wj", "var:w_j"], rx: /^delta\s+w\s*(?:con\s+)?(?:j|i|k)$/, spec: 11 },
  { keys: ["var:Delta_w", "var:w"], rx: /^delta\s+w$/, spec: 10 },
  { keys: ["var:neg_xi", "var:x_i"], rx: /^non\s+x\s*(?:con\s+)?i$/, spec: 11 },
  { keys: ["var:neg_x1", "var:x_1"], rx: /^non\s+x\s*(?:con\s+)?uno$/, spec: 11 },
  { keys: ["var:x_pi", "var:x_p"], rx: /^x\s*(?:con\s+)?p\s+virgola\s+i$/, spec: 11 },
  { keys: ["var:x_pj", "var:x_p"], rx: /^x\s*(?:con\s+)?p\s+virgola\s+j$/, spec: 11 },
  { keys: ["var:x_p_T", "var:x_p"], rx: /^x\s*(?:con\s+)?p\s+trasposto$/, spec: 11 },
  { keys: ["var:x_i_T", "var:x_i"], rx: /^x\s*(?:con\s+)?i\s+trasposto$/, spec: 11 },
  { keys: ["var:w_o_T", "var:w_o", "var:w_T"], rx: /^w\s*(?:con\s+)?(?:o|zero)\s+trasposto$/, spec: 11 },
  { keys: ["var:w_o", "var:w_0"], rx: /^w\s*(?:con\s+)?o$/, spec: 10 },
  { keys: ["var:b_o", "var:b_0"], rx: /^b\s*(?:con\s+)?(?:o|zero)$/, spec: 10 },
  { keys: ["var:a_T"], rx: /^a\s+trasposto$/, spec: 10 },
  { keys: ["var:x_1_sq", "var:x_1"], rx: /^x\s*(?:con\s+)?uno\s+(?:al\s+quadrato|quadro)$/, spec: 11 },
  { keys: ["var:x_2_sq", "var:x_2"], rx: /^x\s*(?:con\s+)?due\s+(?:al\s+quadrato|quadro)$/, spec: 11 },
  { keys: ["var:y_sq", "var:y"], rx: /^y\s+(?:al\s+quadrato|quadro)$/, spec: 10 },
  { keys: ["var:w_i_star", "var:w_star", "var:w_i"], rx: /^w\s*(?:con\s+)?i\s+stella$/, spec: 11 },
  { keys: ["var:i_star"], rx: /^i\s+stella$/, spec: 10 },
  { keys: ["var:alpha_i_prime", "var:alpha_i", "sym:alpha"], rx: /^al(?:fa|pha)\s*(?:primo\s*(?:con\s+)?i|(?:con\s+)?i\s+primo)$/, spec: 11 },
  { keys: ["var:alpha_j", "sym:alpha"], rx: /^al(?:fa|pha)\s*(?:con\s+)?j$/, spec: 10 },
  { keys: ["var:alpha_oi", "var:alpha_i", "sym:alpha"], rx: /^al(?:fa|pha)\s*(?:con\s+)?(?:o|zero)\s*(?:virgola\s+)?i$/, spec: 11 },
  { keys: ["var:xi_i_prime", "var:xi_i", "sym:xi"], rx: /^(?:csi|xi)\s*(?:primo\s*(?:con\s+)?i|(?:con\s+)?i\s+primo)$/, spec: 11 },
  { keys: ["var:gamma_i", "sym:gamma"], rx: /^gamma\s*(?:con\s+)?i$/, spec: 10 },
  { keys: ["var:d_j"], rx: /^d\s*(?:con\s+)?j$/, spec: 10 },
  { keys: ["var:h_i"], rx: /^h\s*(?:con\s+)?i$/, spec: 10 },
  { keys: ["var:h_v"], rx: /^h\s*(?:con\s+)?v$/, spec: 10 },
  { keys: ["var:h_u"], rx: /^h\s*(?:con\s+)?u$/, spec: 10 },
  { keys: ["var:k_1"], rx: /^k\s*(?:con\s+)?uno$/, spec: 10 },
  { keys: ["var:k_2"], rx: /^k\s*(?:con\s+)?due$/, spec: 10 },
  { keys: ["set:R^3", "set:R"], rx: /^r\s+(?:alla\s+terza|al\s+cubo|tre)$/, spec: 11 },
  { keys: ["set:R^2", "set:R"], rx: /^r\s+(?:alla\s+seconda|al\s+quadrato|quadro|due)$/, spec: 11 },
  { keys: ["var:x_p"], rx: /^x\s*(?:con\s+)?p$/, spec: 10 },
  { keys: ["var:x_0"], rx: /^x\s*(?:con\s+)?zero$/, spec: 10 },
  { keys: ["var:x_1"], rx: /^x\s*(?:con\s+)?uno$/, spec: 10 },
  { keys: ["var:x_2"], rx: /^x\s*(?:con\s+)?due$/, spec: 10 },
  { keys: ["var:x_3"], rx: /^x\s*(?:con\s+)?tre$/, spec: 10 },
  { keys: ["var:x_4"], rx: /^x\s*(?:con\s+)?quattro$/, spec: 10 },
  { keys: ["var:x_a"], rx: /^x\s*(?:con\s+)?a$/, spec: 10 },
  { keys: ["var:x_b"], rx: /^x\s*(?:con\s+)?b$/, spec: 10 },
  { keys: ["var:x_i"], rx: /^x\s*(?:con\s+)?i$/, spec: 10 },
  { keys: ["var:x_j"], rx: /^x\s*(?:con\s+)?j$/, spec: 10 },
  { keys: ["var:x_k"], rx: /^x\s*(?:con\s+)?k$/, spec: 10 },
  { keys: ["var:X_T", "var:x_T"], rx: /^x\s+trasposto$/, rawTest: (r) => /^X\b/.test(r), spec: 10 },
  { keys: ["var:x_T", "var:X_T"], rx: /^x\s+trasposto$/, spec: 10 },
  { keys: ["var:X_plus"], rx: /^(?:x\s+piu|pseudoinversa)$/, spec: 10 },
  { keys: ["var:Sigma_plus"], rx: /^sigma\s+piu$/, spec: 10 },
  { keys: ["var:V_T", "var:v_T"], rx: /^v\s+trasposto$/, rawTest: (r) => /^V\b/.test(r), spec: 10 },
  { keys: ["var:v_T", "var:V_T"], rx: /^v\s+trasposto$/, spec: 10 },
  { keys: ["var:U_T"], rx: /^u\s+trasposto$/, spec: 10 },
  { keys: ["var:w_T"], rx: /^w\s+trasposto$/, spec: 10 },
  { keys: ["var:w_0"], rx: /^w\s*(?:con\s+)?zero$/, spec: 10 },
  { keys: ["var:w_1"], rx: /^w\s*(?:con\s+)?uno$/, spec: 10 },
  { keys: ["var:w_2"], rx: /^w\s*(?:con\s+)?due$/, spec: 10 },
  { keys: ["var:w_3"], rx: /^w\s*(?:con\s+)?tre$/, spec: 10 },
  { keys: ["var:w_i"], rx: /^w\s*(?:con\s+)?i$/, spec: 10 },
  { keys: ["var:w_j"], rx: /^w\s*(?:con\s+)?j$/, spec: 10 },
  { keys: ["var:w_k"], rx: /^w\s*(?:con\s+)?k$/, spec: 10 },
  { keys: ["var:w_kj"], rx: /^w\s*(?:con\s+)?k\s+j$/, spec: 11 },
  { keys: ["var:w_ji"], rx: /^w\s*(?:con\s+)?j\s+i$/, spec: 11 },
  { keys: ["var:w_ij"], rx: /^w\s*(?:con\s+)?i\s+j$/, spec: 11 },
  { keys: ["var:w_tu"], rx: /^w\s*(?:con\s+)?t\s+u$/, spec: 11 },
  { keys: ["var:w_t0"], rx: /^w\s*(?:con\s+)?t\s+zero$/, spec: 11 },
  { keys: ["var:w_ts"], rx: /^w\s*(?:con\s+)?t\s+s$/, spec: 11 },
  { keys: ["var:w_hj"], rx: /^w\s*(?:con\s+)?h\s+j$/, spec: 11 },
  { keys: ["var:w_i0"], rx: /^w\s*(?:con\s+)?i\s+zero$/, spec: 11 },
  { keys: ["var:w_star"], rx: /^w\s+stella$/, spec: 10 },
  { keys: ["var:w_new"], rx: /^w\s+nuovo$/, spec: 10 },
  { keys: ["var:w_old"], rx: /^w\s+vecchio$/, spec: 10 },
  { keys: ["var:w_i_prime"], rx: /^w\s+primo\s*(?:con\s+)?i$/, spec: 11 },
  { keys: ["var:Delta_p_wtu", "var:Delta_w"], rx: /^delta\s*(?:con\s+)?p\s*(?:di\s+)?w\s*(?:con\s+)?t\s+u$/, spec: 11 },
  { keys: ["var:Delta_wkj", "var:w_kj"], rx: /^delta\s+w\s*(?:con\s+)?k\s+j$/, spec: 11 },
  { keys: ["var:Delta_wji", "var:w_ji"], rx: /^delta\s+w\s*(?:con\s+)?j\s+i$/, spec: 11 },
  { keys: ["var:Delta_w_old", "var:Delta_w"], rx: /^delta\s+w\s+vecchio$/, spec: 11 },
  { keys: ["var:Delta_w_new", "var:Delta_w"], rx: /^delta\s+w\s+nuovo$/, spec: 11 },
  { keys: ["var:d_p"], rx: /^d\s*(?:con\s+)?p$/, spec: 10 },
  { keys: ["var:d_i"], rx: /^d\s*(?:con\s+)?i$/, spec: 10 },
  { keys: ["var:d_k"], rx: /^d\s*(?:con\s+)?k$/, spec: 10 },
  { keys: ["var:d_r"], rx: /^d\s*(?:con\s+)?r$/, spec: 10 },
  { keys: ["var:D_l", "var:D"], rx: /^d\s*(?:con\s+)?l$/, rawTest: (r) => /^D\b/.test(r), spec: 10 },
  { keys: ["var:D_r", "var:D"], rx: /^d\s*(?:con\s+)?r$/, rawTest: (r) => /^D\b/.test(r), spec: 10 },
  { keys: ["var:D_k", "var:D"], rx: /^d\s*(?:con\s+)?k$/, rawTest: (r) => /^D\b/.test(r), spec: 10 },
  { keys: ["var:D_i", "var:D"], rx: /^d\s*(?:con\s+)?i$/, rawTest: (r) => /^D\b/.test(r), spec: 10 },
  { keys: ["var:D_1", "var:D"], rx: /^d\s*(?:con\s+)?uno$/, spec: 10 },
  { keys: ["var:D_2", "var:D"], rx: /^d\s*(?:con\s+)?due$/, spec: 10 },
  { keys: ["var:D_TR", "var:TR"], rx: /^d\s*(?:con\s+)?t\s*r$/, spec: 10 },
  { keys: ["var:D_VL", "var:VL"], rx: /^d\s*(?:con\s+)?v\s*l$/, spec: 10 },
  { keys: ["var:D_TS", "var:TS"], rx: /^d\s*(?:con\s+)?t\s*s$/, spec: 10 },
  { keys: ["var:o_k"], rx: /^o\s+con\s+k$/, spec: 10 },
  { keys: ["var:o_j"], rx: /^o\s+con\s+j$/, spec: 10 },
  { keys: ["var:o_i"], rx: /^o\s+con\s+i$/, spec: 10 },
  { keys: ["var:o_t"], rx: /^o\s+con\s+t$/, spec: 10 },
  { keys: ["var:o_u"], rx: /^o\s+con\s+u$/, spec: 10 },
  { keys: ["var:o_p"], rx: /^o\s+con\s+p$/, spec: 10 },
  { keys: ["var:o_r"], rx: /^o\s+con\s+r$/, spec: 10 },
  { keys: ["var:o_0"], rx: /^o\s+con\s+zero$/, spec: 10 },
  { keys: ["bar:o"], rx: /^o\s+(?:medio|soprassegnat[oa])$/, spec: 10 },
  { keys: ["var:e_i_sq", "var:e_i"], rx: /^e\s+con\s+i\s+(?:al\s+quadrato|quadro)$/, spec: 11 },
  { keys: ["var:e_i"], rx: /^e\s+con\s+i$/, spec: 10 },
  { keys: ["var:y_i"], rx: /^y\s*(?:con\s+)?i$/, spec: 10 },
  { keys: ["var:y_t"], rx: /^y\s*(?:con\s+|al\s+tempo\s+)?t$/, spec: 10 },
  { keys: ["var:h_t"], rx: /^h\s*(?:con\s+|al\s+tempo\s+)?t$/, spec: 10 },
  { keys: ["var:c_t"], rx: /^c\s*(?:con\s+|al\s+tempo\s+)?t$/, spec: 10 },
  { keys: ["var:x_t"], rx: /^x\s*(?:con\s+|al\s+tempo\s+)?t$/, spec: 10 },
  { keys: ["var:x_q"], rx: /^x\s*(?:con\s+)?q$/, spec: 10 },
  { keys: ["var:x_i_prime", "var:x_prime"], rx: /^x\s+primo\s*(?:con\s+)?i$/, spec: 10 },
  { keys: ["var:z_1"], rx: /^z\s*(?:con\s+)?uno$/, spec: 10 },
  { keys: ["var:z_l"], rx: /^z\s*(?:con\s+)?l$/, spec: 10 },
  { keys: ["var:z_i"], rx: /^z\s*(?:con\s+)?i$/, spec: 10 },
  { keys: ["var:z_r"], rx: /^z\s*(?:con\s+)?r$/, spec: 10 },
  { keys: ["var:N_k"], rx: /^n\s+con\s+k$/, spec: 10 },
  { keys: ["var:N_0"], rx: /^n\s*(?:con\s+)?zero$/, spec: 10 },
  { keys: ["var:H_1", "var:h_1"], rx: /^h\s*(?:con\s+)?uno$/, rawTest: (r) => /^H\b/.test(r), spec: 10 },
  { keys: ["var:H_2", "var:h_2"], rx: /^h\s*(?:con\s+)?due$/, rawTest: (r) => /^H\b/.test(r), spec: 10 },
  { keys: ["var:h_1", "var:H_1"], rx: /^h\s*(?:con\s+)?uno$/, spec: 10 },
  { keys: ["var:h_2", "var:H_2"], rx: /^h\s*(?:con\s+)?due$/, spec: 10 },
  { keys: ["var:h_star", "var:h"], rx: /^h\s+stella$/, spec: 10 },
  { keys: ["var:h_prime"], rx: /^h\s+primo$/, spec: 10 },
  { keys: ["var:E_prime"], rx: /^e\s+primo$/, spec: 10 },
  { keys: ["var:R_prime"], rx: /^r\s+primo$/, spec: 10 },
  { keys: ["var:x_prime"], rx: /^x\s+primo$/, spec: 10 },
  { keys: ["var:d_prime"], rx: /^d\s+primo$/, spec: 10 },
  { keys: ["bar:h"], rx: /^h\s+soprassegnat[oa]$/, spec: 10 },
  { keys: ["bar:d"], rx: /^d\s+soprassegnat[oa]$/, spec: 10 },
  { keys: ["bar:x"], rx: /^x\s+soprassegnat[oa]$/, spec: 10 },
  { keys: ["bar:D_k"], rx: /^d\s+soprassegnat[oa]\s+k$/, spec: 10 },
  { keys: ["var:h_w"], rx: /^h\s+con\s+w$/, spec: 10 },
  { keys: ["var:f_sigma_prime", "var:f_prime"], rx: /^f\s+primo\s+sigma$/, spec: 11 },
  { keys: ["var:f_sigma"], rx: /^f\s+sigma$/, spec: 10 },
  { keys: ["var:f_k_prime", "var:f_prime"], rx: /^f\s+primo\s*(?:con\s+)?k$/, spec: 11 },
  { keys: ["var:f_j_prime", "var:f_prime"], rx: /^f\s+primo\s*(?:con\s+)?j$/, spec: 11 },
  { keys: ["var:f_t_prime", "var:f_prime"], rx: /^f\s+primo\s*(?:con\s+)?t$/, spec: 11 },
  { keys: ["var:f_prime"], rx: /^f\s+primo$/, spec: 10 },
  { keys: ["var:f_k"], rx: /^f\s+con\s+k$/, spec: 10 },
  { keys: ["var:f_j"], rx: /^f\s+con\s+j$/, spec: 10 },
  { keys: ["var:f_t"], rx: /^f\s+con\s+t$/, spec: 10 },
  { keys: ["var:net_i", "var:net"], rx: /^net\s*(?:con\s+)?i$/, spec: 10 },
  { keys: ["var:net_j", "var:net"], rx: /^net\s*(?:con\s+)?j$/, spec: 10 },
  { keys: ["var:net_k", "var:net"], rx: /^net\s*(?:con\s+)?k$/, spec: 10 },
  { keys: ["var:net_t", "var:net"], rx: /^net\s*(?:con\s+)?t$/, spec: 10 },
  { keys: ["var:net"], rx: /^(?:net|input\s+netto)$/, spec: 10 },
  { keys: ["var:phi_k", "sym:phi"], rx: /^(?:phi|fi)\s*(?:con\s+)?k$/, spec: 10 },
  { keys: ["var:phi_j", "sym:phi"], rx: /^(?:phi|fi)\s*(?:con\s+)?j$/, spec: 10 },
  { keys: ["var:delta_p", "var:delta"], rx: /^delta\s*(?:con\s+)?p$/, spec: 10 },
  { keys: ["var:delta_k", "var:delta"], rx: /^delta\s*(?:con\s+)?k$/, spec: 10 },
  { keys: ["var:delta_j", "var:delta"], rx: /^delta\s*(?:con\s+)?j$/, spec: 10 },
  { keys: ["var:delta_t", "var:delta"], rx: /^delta\s*(?:con\s+)?t$/, spec: 10 },
  { keys: ["var:delta_h", "var:delta"], rx: /^delta\s*(?:con\s+)?h$/, spec: 10 },
  { keys: ["var:alpha_i", "sym:alpha"], rx: /^al(?:fa|pha)\s*(?:con\s+)?i$/, spec: 10 },
  { keys: ["var:xi_i", "sym:xi"], rx: /^(?:csi|xi)\s*(?:con\s+)?i$/, spec: 10 },
  { keys: ["var:theta_m_star", "var:theta_m", "sym:theta"], rx: /^theta\s+stella(?:\s*(?:con\s+)?m)?$/, spec: 10 },
  { keys: ["var:theta_m", "sym:theta"], rx: /^theta\s*(?:con\s+)?m$/, spec: 10 },
  { keys: ["var:eta_0", "sym:eta"], rx: /^eta\s*(?:con\s+)?zero$/, spec: 10 },
  { keys: ["var:eta_tau", "sym:eta"], rx: /^eta\s*(?:con\s+)?tau$/, spec: 10 },
  { keys: ["var:E_tot", "var:E"], rx: /^e\s+tot$/, spec: 10 },
  { keys: ["var:E_p", "var:E"], rx: /^e\s+con\s+p$/, spec: 10 },
  { keys: ["var:E_pk", "var:E"], rx: /^e\s+con\s+p\s+k$/, spec: 10 },
  { keys: ["var:E_RMS"], rx: /^(?:e\s+rms|root\s+mean\s+square)$/, spec: 10 },
  { keys: ["var:R_emp"], rx: /^(?:r\s+emp|rischio\s+empirico)$/, spec: 10 },
  { keys: ["var:R_sq"], rx: /^r\s+(?:al\s+quadrato|quadro)$/, spec: 10 },
  { keys: ["var:S_d_sq", "var:S_sq"], rx: /^s\s*(?:con\s+)?d\s+(?:al\s+quadrato|quadro)$/, spec: 10 },
  { keys: ["var:S_sq"], rx: /^s\s+(?:al\s+quadrato|quadro)$/, spec: 10 },
  { keys: ["pow:2^m"], rx: /^due\s+alla\s+m$/, spec: 10 },
  { keys: ["pow:2^3"], rx: /^due\s+alla\s+terza$/, spec: 10 },
  { keys: ["pow:alpha^2"], rx: /^al(?:fa|pha)\s+(?:al\s+quadrato|quadro)$/, spec: 10 },
  { keys: ["frac:1/k"], rx: /^uno\s+su\s+k$/, spec: 10 },
  { keys: ["frac:1/r"], rx: /^uno\s+su\s+r$/, spec: 10 },
  { keys: ["var:VS"], rx: /^version\s+space$/, spec: 9 },
  { keys: ["var:TR"], rx: /^training\s+set$/, spec: 8 },
  { keys: ["var:P_X"], rx: /^insieme\s+delle\s+parti(?:\s+di\s+x)?$/, spec: 10 },

  // 4. Operators & Relations & Greek
  { keys: ["op:sum"], rx: /^(?:somma(?:\s+su\s+[ijkp]|\s+da\s+[ijkp]\s+uguale\s+(?:zero|uno)\s+a\s+[lnmk]|\s+per\s+[ijkp]\s+da\s+(?:zero|uno)\s+a\s+[lnmk]|\s+di)?|sommatoria)$/, spec: 10 },
  { keys: ["op:prod"], rx: /^prodotto(?:\s+delle\s+probabilita)?$/, spec: 9 },
  { keys: ["op:int"], rx: /^integrale$/, spec: 10 },
  { keys: ["op:E", "var:E"], rx: /^valore\s+atteso$/, spec: 10 },
  { keys: ["op:argmin"], rx: /^arg\s*min$/, spec: 10 },
  { keys: ["op:argmax"], rx: /^arg\s*max$/, spec: 10 },
  { keys: ["op:max"], rx: /^massimo$/, spec: 9 },
  { keys: ["op:min"], rx: /^minimo$/, spec: 9 },
  { keys: ["op:tanh"], rx: /^tangente\s+iperbolica$/, spec: 10 },
  { keys: ["op:sqrt"], rx: /^(?:radice(?:\s+quadrata)?|radici)$/, spec: 10 },
  { keys: ["op:Cov"], rx: /^covarianza$/, spec: 10 },
  { keys: ["op:Var"], rx: /^varianza$/, spec: 10 },
  { keys: ["op:Bias"], rx: /^bias(?:\s+al\s+quadrato)?$/, spec: 9 },
  { keys: ["op:sign"], rx: /^(?:segno|sign)$/, spec: 10 },
  { keys: ["op:ln", "op:log"], rx: /^logaritmo\s+naturale$/, spec: 10 },
  { keys: ["op:ln", "op:log"], rx: /^logaritm[oi]$/, spec: 9 },
  { keys: ["op:sin"], rx: /^seno$/, spec: 10 },
  { keys: ["op:cos"], rx: /^coseno$/, spec: 10 },
  { keys: ["op:exp"], rx: /^esponenziale$/, spec: 10 },
  { keys: ["op:inv"], rx: /^invers[oa]$/, spec: 10 },
  { keys: ["op:nabla"], rx: /^(?:(?:sub\s+)?gradiente|nabla)$/, spec: 9 },
  { keys: ["op:norm"], rx: /^norma(?:\s+quadra|\s+al\s+quadrato)?$/, spec: 10 },
  { keys: ["op:abs"], rx: /^(?:modulo|valore\s+assoluto|valori\s+assoluti|cardinalita)$/, spec: 9 },
  { keys: ["op:pm"], rx: /^piu\s+o\s+meno$/, spec: 9 },
  { keys: ["var:false"], rx: /^falso$/, spec: 9 },
  { keys: ["sym:alpha"], rx: /^al(?:fa|pha)$/, spec: 10 },
  { keys: ["sym:beta"], rx: /^beta$/, spec: 10 },
  { keys: ["sym:gamma"], rx: /^gamma$/, spec: 10 },
  { keys: ["sym:tau"], rx: /^tau$/, spec: 10 },
  { keys: ["sym:rho"], rx: /^(?:rho|ro)$/, spec: 10 },
  { keys: ["sym:xi"], rx: /^(?:csi|xi)$/, spec: 10 },
  { keys: ["sym:infty"], rx: /^infinit[ao]$/, spec: 9 },
  { keys: ["sym:lambda"], rx: /^lambda$/, spec: 10 },
  { keys: ["sym:eta"], rx: /^(?:eta|learning\s+rate)$/, spec: 10 },
  { keys: ["var:delta"], rx: /^delta$/, spec: 9 },
  { keys: ["sym:sigma_sq", "sym:sigma"], rx: /^(?:sigma\s+quadro|varianza\s+del\s+rumore)$/, spec: 10 },
  { keys: ["sym:Sigma", "sym:sigma"], rx: /^sigma$/, rawTest: (r) => /^Sigma\b/.test(r), spec: 10 },
  { keys: ["sym:sigma", "sym:Sigma"], rx: /^sigma$/, spec: 10 },
  { keys: ["sym:theta"], rx: /^the?ta$/, spec: 10 },
  { keys: ["sym:eps"], rx: /^(?:epsilon|vc\s*confidence)$/, spec: 10 },
  { keys: ["sym:pi"], rx: /^pi\s+greco$/, spec: 10 },
  { keys: ["sym:phi"], rx: /^(?:phi|fi)$/, spec: 10 },
  { keys: ["sym:mu"], rx: /^mu$/, spec: 10 },
  { keys: ["var:VC"], rx: /^(?:vc|vc\s*dimension)$/, spec: 10 },
  { keys: ["rel:ge"], rx: /^(?:maggiore\s+o\s+uguale|almeno)$/, spec: 9 },
  { keys: ["rel:le"], rx: /^minore\s+o\s+uguale$/, spec: 9 },
  { keys: ["rel:gt"], rx: /^maggiore$/, spec: 8 },
  { keys: ["rel:lt"], rx: /^minore$/, spec: 8 },
  { keys: ["rel:neq"], rx: /^(?:diverso|non\s+nullo)$/, spec: 9 },
  { keys: ["var:w"], rx: /^(?:vettore\s+(?:dei\s+pesi\s+)?w|pesi\s+w)$/, spec: 9 }
];

// Check if word i is sentence-initial (previous word ended with . ? ! : or i === 0)
function isSentenceStart(words, i) {
  if (i === 0) return true;
  return /[.?!:]$/.test((words[i - 1].raw || "").trim());
}

// Parse exact timestamped spoken math events from MMS_FA words
function extractSpokenMathEvents(words) {
  const events = []; // { keys: string[], start, end, specificity }
  const cleaned = words.map((w) => cleanWord(w.raw));
  const rawLetters = words.map((w) => (w.raw || "").replace(/[^A-Za-z0-9]+/g, ""));

  let i = 0;
  while (i < words.length) {
    let matched = null;

    // 1. Try multi-word / compound grammar rules (longest first, up to 8 words)
    const maxLen = Math.min(8, words.length - i);
    for (let len = maxLen; len >= 1; len--) {
      const slice = cleaned.slice(i, i + len).filter(Boolean).join(" ");
      if (!slice) continue;
      const rawSlice = words.slice(i, i + len).map((w) => (w.raw || "").trim()).join(" ");
      for (const rule of SPOKEN_MATH_GRAMMAR) {
        if (rule.rx.test(slice) && (!rule.rawTest || rule.rawTest(rawSlice))) {
          matched = {
            keys: rule.keys,
            start: words[i].start,
            end: words[i + len - 1].end,
            len,
            specificity: rule.spec || 9
          };
          break;
        }
      }
      if (matched) break;
    }

    // 2. Try Italian number / decimal parser (only if no grammar rule matched, e.g. avoids splitting "uno su l" or "due alla quarta")
    if (!matched) {
      const numMatch = tryParseSpokenNumber(words, cleaned, i);
      if (numMatch) matched = numMatch;
    }

    // 3. Try single-letter mathematical variables (case-sensitive via rawLetters!)
    if (!matched) {
      const rl = rawLetters[i];
      if (rl && rl.length === 1 && /[A-Za-z]/.test(rl)) {
        const sentStart = isSentenceStart(words, i);
        const nextC = cleaned[i + 1] || "";
        const prevC = cleaned[i - 1] || "";
        let key = null;

        if ("HXLRMKUVDPNSOGW".includes(rl)) {
          key = `var:${rl}`;
        } else if (rl === "E") {
          if (!sentStart || nextC === "di" || nextC === "uguale" || prevC === "errore" || prevC === "derivata") {
            key = "var:E";
          }
        } else if (rl === "I") {
          if (!sentStart && (prevC === "lambda" || prevC === "identita" || nextC === "inverso")) {
            key = "var:I";
          }
        } else if (rl === "A" || rl === "B" || rl === "C") {
          if (!sentStart || nextC === "diventa" || nextC === "uguale") {
            key = `var:${rl}`;
          }
        } else if ("xwdhflnpvjkmqtrzbcuy".includes(rl)) {
          key = `var:${rl}`;
        } else if (rl === "i") {
          if (prevC === "da" || prevC === "per" || prevC === "componente" || prevC === "indice" || nextC === "uguale" || nextC === "da" || nextC === "di") {
            key = "var:i";
          }
        }

        if (key) {
          const keys = [key];
          if (rl === "h") keys.push("var:h_w"); // speaker often says "h di x" when formula writes h_w(x)
          if (rl === "R") keys.push("set:R");
          matched = {
            keys,
            start: words[i].start,
            end: words[i].end,
            len: 1,
            specificity: 7
          };
        }
      }
    }

    if (matched) {
      events.push({
        keys: matched.keys,
        start: matched.start,
        end: matched.end,
        specificity: matched.specificity
      });
      i += matched.len;
    } else {
      i += 1;
    }
  }
  return events;
}

// ---------- Prose Clause Word-by-Word Wrapper ----------

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

// ---------- Universal KaTeX Formula Atomizer ----------

function katexText(el) {
  return (el?.textContent || "").replace(/[\s\u200b-\u200d\ufeff]+/g, "");
}

function getMfracParts(mfracEl) {
  // Inside KaTeX .mfrac > .vlist-t > .vlist-r > .vlist, children are stacked bottom-to-top:
  // [denomSpan, fracLineSpan, numSpan]. Return { num, den } in true reading order!
  const vlist =
    mfracEl.querySelector(":scope > .vlist-t > .vlist-r > .vlist") ||
    mfracEl.querySelector(":scope > .vlist-t > .vlist");
  if (!vlist) return null;
  const kids = Array.from(vlist.children).filter((c) => !c.querySelector(":scope > .frac-line"));
  if (kids.length < 2) return null;
  return { den: kids[0], num: kids[kids.length - 1] };
}

function isMsupsubSuperscriptOnly(mordEl) {
  const msupsub = mordEl.querySelector(":scope > .msupsub");
  if (!msupsub) return false;
  // In KaTeX: .vlist-t2 means subscript (or sub+sup); plain .vlist-t without .vlist-t2 means superscript only!
  return !msupsub.querySelector(".vlist-t2");
}

function isSimpleDigitsSpan(el) {
  if (!el || !el.classList || !el.classList.contains("mord")) return false;
  if (el.querySelector(".msupsub, .mfrac, .sqrt")) return false;
  return /^\d+$/.test(katexText(el));
}

function isDecimalCommaWrapper(el) {
  if (!el || !el.classList) return false;
  // KaTeX renders {,} as <span class="mord"><span class="mpunct">,</span></span>
  return el.classList.contains("mord") && katexText(el) === ",";
}

function isThinSpaceSpan(el) {
  return Boolean(el && el.classList && el.classList.contains("mspace"));
}

function isUnarySignSpan(el) {
  if (!el || !el.classList || !el.classList.contains("mord")) return false;
  const t = katexText(el);
  return t === "−" || t === "-" || t === "+";
}

function indexFormulaAtoms(slideCard, blocks) {
  const atoms = []; // { els: Element[], keys: Set<string>, blockEl, katexRoot, isHeader, windows: [] }
  const covered = new Set();

  const isCovered = (el) => {
    let cur = el;
    while (cur && cur !== slideCard) {
      if (covered.has(cur)) return true;
      cur = cur.parentElement;
    }
    return false;
  };

  // Find most specific owning block in `blocks` for an element
  const findOwnerBlock = (el) => {
    let best = null;
    for (const b of blocks) {
      if (b.el === el || b.el.contains(el)) {
        if (!best || best.el.contains(b.el)) best = b;
      }
    }
    return best ? best.el : slideCard;
  };

  const addAtom = (elsInput, keysInput, markCovered = true, katexRoot = null) => {
    const els = Array.isArray(elsInput) ? elsInput.filter(Boolean) : [elsInput].filter(Boolean);
    const keys = Array.isArray(keysInput) ? keysInput.filter(Boolean) : [keysInput].filter(Boolean);
    if (els.length === 0 || keys.length === 0) return null;
    if (els.some((e) => isCovered(e))) return null;

    const first = els[0];
    const isHeader = Boolean(first.closest(".step-tag, .box-label, .slide-title, .slide-kicker, .plot-title"));
    const blockEl = findOwnerBlock(first);
    const root = katexRoot || first.closest(".katex-html") || first;

    const rec = { els, keys: new Set(keys), blockEl, katexRoot: root, isHeader, windows: [] };
    atoms.push(rec);
    for (const e of els) {
      e.classList.add("katex-atom");
      if (markCovered) covered.add(e);
    }
    return rec;
  };

  const katexRoots = slideCard.querySelectorAll(".katex-html");
  katexRoots.forEach((root) => {
    // Recursive walker that visits .mfrac numerator BEFORE denominator and detects sibling compound groups
    // in exact human left-to-right reading order!
    const visitChildren = (parent) => {
      if (isCovered(parent)) return;
      const kids = Array.from(parent.children);
      for (let i = 0; i < kids.length; i++) {
        const el = kids[i];
        if (isCovered(el)) continue;

        // 0. Multi-sibling compound groups (when not inside .msupsub)
        if (!parent.closest(".msupsub") && i + 1 < kids.length) {
          const t0 = katexText(el);

          // 0a. Inline slash derivative: ∂ E / ∂ w_0 (5 consecutive children)
          if (t0 === "∂" && i + 4 < kids.length) {
            const t1 = katexText(kids[i + 1]);
            const t2 = katexText(kids[i + 2]);
            const t3 = katexText(kids[i + 3]);
            const t4 = katexText(kids[i + 4]);
            if (t1 === "E" && t2 === "/" && t3 === "∂") {
              let dk = null;
              if (/^w0$/i.test(t4)) dk = "dE_dw0";
              else if (/^w1$/i.test(t4)) dk = "dE_dw1";
              else if (/^w[ijk]$/i.test(t4)) dk = "dE_dwj";
              if (dk) {
                addAtom(kids.slice(i, i + 5), dk, true, root);
                i += 4;
                continue;
              }
            }
          }

          // 0b. \Delta w_j, \Delta_p w_j, \Delta w
          if ((t0 === "Δ" || t0 === "Δp") && !isCovered(kids[i + 1])) {
            const t1 = katexText(kids[i + 1]);
            if (t0 === "Δp" && /^w[ijk]$/i.test(t1)) {
              addAtom([el, kids[i + 1]], ["var:Delta_p_wj", "var:Delta_wj"], true, root);
              i += 1;
              continue;
            }
            if (t0 === "Δ" && /^w[ijk]$/i.test(t1)) {
              addAtom([el, kids[i + 1]], ["var:Delta_wj", "var:w_j"], true, root);
              i += 1;
              continue;
            }
            if (t0 === "Δ" && t1 === "w") {
              addAtom([el, kids[i + 1]], ["var:Delta_w", "var:w"], true, root);
              i += 1;
              continue;
            }
          }

          // 0c. \neg x_i / \neg x_1
          if (t0 === "¬" && !isCovered(kids[i + 1])) {
            const t1 = katexText(kids[i + 1]);
            if (t1 === "xi") {
              addAtom([el, kids[i + 1]], ["var:neg_xi", "var:x_i"], true, root);
              i += 1;
              continue;
            }
            if (t1 === "x1") {
              addAtom([el, kids[i + 1]], ["var:neg_x1", "var:x_1"], true, root);
              i += 1;
              continue;
            }
          }

          // 0d. Adjacent T R -> var:TR, V S -> var:VS
          if (t0 === "T" && katexText(kids[i + 1]) === "R" && !isCovered(kids[i + 1])) {
            addAtom([el, kids[i + 1]], "var:TR", true, root);
            i += 1;
            continue;
          }
          if (t0 === "V" && katexText(kids[i + 1]) === "S" && !isCovered(kids[i + 1])) {
            addAtom([el, kids[i + 1]], "var:VS", true, root);
            i += 1;
            continue;
          }

          // 0e. Unary sign + Italian decimal / thousands / integer (e.g. -4{,}9, 110{,}8, 65\,536, -2, +0{,}1)
          let signEl = null;
          let signNeg = false;
          let numStart = i;
          if (isUnarySignSpan(el) && isSimpleDigitsSpan(kids[i + 1])) {
            signEl = el;
            signNeg = t0 === "−" || t0 === "-";
            numStart = i + 1;
          }
          if (isSimpleDigitsSpan(kids[numStart]) && !isCovered(kids[numStart])) {
            const d0 = katexText(kids[numStart]);
            if (
              numStart + 2 < kids.length &&
              isDecimalCommaWrapper(kids[numStart + 1]) &&
              isSimpleDigitsSpan(kids[numStart + 2]) &&
              !isCovered(kids[numStart + 2])
            ) {
              const d1 = katexText(kids[numStart + 2]);
              const group = signEl
                ? [signEl, kids[numStart], kids[numStart + 1], kids[numStart + 2]]
                : [kids[numStart], kids[numStart + 1], kids[numStart + 2]];
              const valStr = `${signNeg ? "-" : ""}${d0}.${d1}`;
              const keys = [canonicalNumKey(valStr)];
              if (signNeg) keys.push(canonicalNumKey(`${d0}.${d1}`));
              addAtom(group, keys, true, root);
              i = numStart + 2;
              continue;
            }
            if (
              numStart + 2 < kids.length &&
              isThinSpaceSpan(kids[numStart + 1]) &&
              isSimpleDigitsSpan(kids[numStart + 2]) &&
              katexText(kids[numStart + 2]).length === 3 &&
              !isCovered(kids[numStart + 2])
            ) {
              const d1 = katexText(kids[numStart + 2]);
              const group = signEl
                ? [signEl, kids[numStart], kids[numStart + 1], kids[numStart + 2]]
                : [kids[numStart], kids[numStart + 1], kids[numStart + 2]];
              const valStr = `${signNeg ? "-" : ""}${d0}${d1}`;
              const keys = [canonicalNumKey(valStr)];
              if (signNeg) keys.push(canonicalNumKey(`${d0}${d1}`));
              addAtom(group, keys, true, root);
              i = numStart + 2;
              continue;
            }
            if (signEl) {
              const valStr = `${signNeg ? "-" : ""}${d0}`;
              const keys = [canonicalNumKey(valStr)];
              if (signNeg) keys.push(canonicalNumKey(d0));
              addAtom([signEl, kids[numStart]], keys, true, root);
              i = numStart;
              continue;
            }
          }
        }

        // 1. Fractions (.mfrac): atomic derivatives / 1/l / 1/2, OR walk numerator BEFORE denominator!
        if (el.classList.contains("mfrac")) {
          const parts = getMfracParts(el);
          if (parts) {
            const numTxt = katexText(parts.num);
            const denTxt = katexText(parts.den);
            if (numTxt.startsWith("∂E") && /^∂w0$/i.test(denTxt)) {
              addAtom(el, "dE_dw0", true, root);
              continue;
            }
            if (numTxt.startsWith("∂E") && /^∂w1$/i.test(denTxt)) {
              addAtom(el, "dE_dw1", true, root);
              continue;
            }
            if (numTxt.startsWith("∂E") && /^∂w[ijk]$/i.test(denTxt)) {
              addAtom(el, "dE_dwj", true, root);
              continue;
            }
            if (numTxt === "1" && denTxt === "l") {
              addAtom(el, "frac:1/l", true, root);
              continue;
            }
            if (numTxt === "1" && denTxt === "2") {
              addAtom(el, "frac:1/2", true, root);
              continue;
            }
            if (numTxt === "1" && (denTxt === "k" || denTxt === "K")) {
              addAtom(el, "frac:1/k", true, root);
              continue;
            }
            if (numTxt === "1" && denTxt === "r") {
              addAtom(el, "frac:1/r", true, root);
              continue;
            }
            // Non-atomic fraction: visit NUMERATOR first, DENOMINATOR second!
            visitChildren(parts.num);
            visitChildren(parts.den);
            continue;
          }
        }

        // 2. Outer operators (.mop)
        if (el.classList.contains("mop") && !el.parentElement?.closest(".mop")) {
          const txt = katexText(el);
          if (txt.includes("∑")) { addAtom(el, "op:sum", true, root); continue; }
          if (txt.includes("∏")) { addAtom(el, "op:prod", true, root); continue; }
          if (txt.includes("∫")) { addAtom(el, "op:int", true, root); continue; }
          if (txt === "Cov") { addAtom(el, "op:Cov", true, root); continue; }
          if (txt === "Var") { addAtom(el, "op:Var", true, root); continue; }
          if (txt === "Bias") { addAtom(el, "op:Bias", true, root); continue; }
          if (txt === "sign") { addAtom(el, "op:sign", true, root); continue; }
          if (txt === "ln") { addAtom(el, "op:ln", true, root); continue; }
          if (txt === "log") { addAtom(el, ["op:log", "op:ln"], true, root); continue; }
          if (txt === "sin") { addAtom(el, "op:sin", true, root); continue; }
          if (txt === "cos") { addAtom(el, "op:cos", true, root); continue; }
          if (txt === "exp") { addAtom(el, "op:exp", true, root); continue; }
          if (txt === "tanh") { addAtom(el, "op:tanh", true, root); continue; }
          if (txt === "max") { addAtom(el, "op:max", true, root); continue; }
          if (txt === "min") { addAtom(el, "op:min", true, root); continue; }
          if (/^argmin/i.test(txt)) { addAtom(el, "op:argmin", true, root); continue; }
          if (/^argmax/i.test(txt)) { addAtom(el, "op:argmax", true, root); continue; }
        }

        // 3. Square roots
        if (el.classList.contains("sqrt")) {
          const txt = katexText(el);
          if (txt === "√2") {
            addAtom(el, ["sqrt:2", "op:sqrt"], true, root);
            continue;
          }
          const signChild = el.querySelector(".sqrt-sign, .hide-tail") || el;
          addAtom(signChild, "op:sqrt", false, root);
          visitChildren(el);
          continue;
        }

        // 4. Norms (∥...∥) and Absolute values (∣...∣) — highlight BOTH paired delimiter bars (+ closing ^2) together!
        if (el.classList.contains("mopen") || el.classList.contains("mclose")) {
          const txt = katexText(el);
          if (el.classList.contains("mopen") && (txt === "∥" || txt === "∣")) {
            const pairKey = txt === "∥" ? "op:norm" : "op:abs";
            // Find matching closing delimiter sibling at same nesting level
            let depth = 1;
            let closeEl = null;
            for (let j = i + 1; j < kids.length; j++) {
              const kt = katexText(kids[j]);
              if (kids[j].classList.contains("mopen") && kt === txt) depth++;
              else if (kids[j].classList.contains("mclose") && kt.startsWith(txt)) {
                depth--;
                if (depth === 0) {
                  closeEl = kids[j];
                  break;
                }
              }
            }
            const pairEls = closeEl ? [el, closeEl] : [el];
            addAtom(pairEls, pairKey, true, root);
            continue;
          }
          if (el.classList.contains("mclose") && el.querySelector(":scope > .msupsub")) {
            const sup = el.querySelector(":scope > .msupsub");
            if (/^[−-]1$/.test(katexText(sup))) {
              addAtom(sup, "op:inv", true, root);
            }
          }
          continue;
        }

        // 5. Relations (.mrel)
        if (el.classList.contains("mrel") && !el.closest(".msupsub")) {
          const txt = katexText(el);
          if (txt === "≥") { addAtom(el, "rel:ge", true, root); continue; }
          if (txt === "≤") { addAtom(el, "rel:le", true, root); continue; }
          if (txt === ">") { addAtom(el, "rel:gt", true, root); continue; }
          if (txt === "<") { addAtom(el, "rel:lt", true, root); continue; }
          if (txt === "≠") { addAtom(el, "rel:neq", true, root); continue; }
          continue;
        }

        // 6. Accented bars/hats/tildes (\bar d, \bar x, \bar h, \bar o, \bar D_k, \hat y, \tilde h, ...)
        if (el.classList.contains("accent") && el.classList.contains("mord")) {
          const txt = katexText(el);
          if (txt.includes("h")) { addAtom(el, ["bar:h", "var:h"], true, root); continue; }
          if (txt.includes("d")) { addAtom(el, ["bar:d", "var:d"], true, root); continue; }
          if (txt.includes("x")) { addAtom(el, ["bar:x", "var:x"], true, root); continue; }
          if (txt.includes("o")) { addAtom(el, ["bar:o", "var:o"], true, root); continue; }
          if (txt.includes("D")) { addAtom(el, ["bar:D_k", "var:D"], true, root); continue; }
          const baseCh = txt.replace(/[^A-Za-zα-ωΑ-Ω]/g, "")[0];
          if (baseCh) {
            addAtom(el, [`bar:${baseCh}`, `var:${baseCh}`], true, root);
            continue;
          }
        }

        // 7. Subscript/Superscript .mord
        if (el.classList.contains("mord") && !el.closest(".msupsub")) {
          const hasSubSup = Boolean(el.querySelector(":scope > .msupsub"));
          const txt = katexText(el);

          if (hasSubSup) {
            const supOnly = isMsupsubSuperscriptOnly(el);
            let added = null;
            if (txt === "22n") added = addAtom(el, "pow:2^2^n", true, root);
            else if (txt === "24") added = addAtom(el, "pow:2^4", true, root);
            else if (txt === "216") added = addAtom(el, "pow:2^16", true, root);
            else if (txt === "29") added = addAtom(el, "pow:2^9", true, root);
            else if (txt === "2m") added = addAtom(el, "pow:2^m", true, root);
            else if (txt === "23" && supOnly) added = addAtom(el, "pow:2^3", true, root);
            else if (txt === "3n") added = addAtom(el, "pow:3^n", true, root);
            else if (txt === "32" && supOnly) added = addAtom(el, ["pow:3^2", "num:9"], true, root);
            else if (txt === "α2" && supOnly) added = addAtom(el, ["pow:alpha^2", "sym:alpha"], true, root);
            else if (txt === "L1") added = addAtom(el, "norm:L1", true, root);
            else if (txt === "L2") added = addAtom(el, "norm:L2", true, root);
            else if (txt === "Rn") added = addAtom(el, ["set:R^n", "set:R"], true, root);
            else if (txt === "RK") added = addAtom(el, ["set:R^K", "set:R"], true, root);
            else if (txt === "Rl×n") added = addAtom(el, ["dim:lxn", "set:R"], true, root);
            else if (txt === "R2" && supOnly) added = addAtom(el, "var:R_sq", true, root);
            else if (txt === "S2" && supOnly) added = addAtom(el, "var:S_sq", true, root);
            else if (/^S(?:2d|d2)$/.test(txt)) added = addAtom(el, ["var:S_d_sq", "var:S_sq"], true, root);
            // Primes
            else if (txt === "h′") added = addAtom(el, "var:h_prime", true, root);
            else if (txt === "E′") added = addAtom(el, "var:E_prime", true, root);
            else if (txt === "R′") added = addAtom(el, "var:R_prime", true, root);
            else if (txt === "x′") added = addAtom(el, "var:x_prime", true, root);
            else if (txt === "d′") added = addAtom(el, "var:d_prime", true, root);
            else if (txt === "f′") added = addAtom(el, "var:f_prime", true, root);
            else if (/^f(?:′σ|σ′)$/.test(txt)) added = addAtom(el, ["var:f_sigma_prime", "var:f_prime"], true, root);
            else if (/^f(?:′([jkt])|([jkt])′)$/.test(txt)) {
              const idx = txt.replace(/[f′]/g, "");
              added = addAtom(el, [`var:f_${idx}_prime`, "var:f_prime"], true, root);
            }
            else if (/^w(?:′i|i′)$/.test(txt)) added = addAtom(el, ["var:w_i_prime", "var:w_i"], true, root);
            else if (/^x(?:′i|i′)$/.test(txt)) added = addAtom(el, ["var:x_i_prime", "var:x_prime"], true, root);
            // Stars (handle both ASCII * and KaTeX Unicode ∗ \u2217!)
            else if (/^w(?:[\*∗](\d)|(\d)[\*∗])$/.test(txt)) {
              const d = txt.replace(/\D/g, "");
              added = addAtom(el, [`var:w_${d}`, "var:w_star"], true, root);
            } else if (/^w[\*∗]$/.test(txt)) added = addAtom(el, "var:w_star", true, root);
            else if (/^h[\*∗]/.test(txt)) added = addAtom(el, ["var:h_star", "var:h"], true, root);
            else if (/^θ(?:[\*∗]m|m[\*∗])$/.test(txt)) added = addAtom(el, ["var:theta_m_star", "var:theta_m", "sym:theta"], true, root);
            // Dual sub+sup
            else if (/^x(?:2p|p2)$/i.test(txt)) added = addAtom(el, ["var:x_p_sq", "var:x_p"], true, root);
            else if (/^x(?:Tp|pT)$/.test(txt)) added = addAtom(el, ["var:x_p_T", "var:x_p"], true, root);
            else if (/^w(?:2j|j2)$/i.test(txt)) added = addAtom(el, ["var:w_j_sq", "var:w_j"], true, root);
            else if (/^e(?:2i|i2)$/.test(txt)) added = addAtom(el, ["var:e_i_sq", "var:e_i"], true, root);
            // Transposes & pseudoinverses
            else if (txt === "XT") added = addAtom(el, "var:X_T", true, root);
            else if (txt === "X+") added = addAtom(el, "var:X_plus", true, root);
            else if (txt === "Σ+") added = addAtom(el, "var:Sigma_plus", true, root);
            else if (txt === "VT") added = addAtom(el, "var:V_T", true, root);
            else if (txt === "UT") added = addAtom(el, "var:U_T", true, root);
            else if (txt === "vT") added = addAtom(el, "var:v_T", true, root);
            else if (txt === "wT") added = addAtom(el, "var:w_T", true, root);
            else if (txt === "xT") added = addAtom(el, "var:x_T", true, root);
            // Powers of x and w
            else if (txt === "x2" && supOnly) added = addAtom(el, ["pow:x^2", "var:x"], true, root);
            else if (txt === "xj" && supOnly) added = addAtom(el, ["pow:x^j", "var:x"], true, root);
            else if (txt === "xM" && supOnly) added = addAtom(el, ["pow:x^M", "var:x"], true, root);
            else if (txt === "w2" && supOnly) added = addAtom(el, ["var:w_sq", "var:w"], true, root);
            // Expectation \E_P, \E_z, \E_i
            else if (/^E/.test(txt) && el.querySelector(".mathbb")) added = addAtom(el, ["op:E", "var:E"], true, root);
            // Subscripted weights (incl. double-indexed neural weights!)
            else if (/^w(kj|ji|ij|tu|t0|ts|hj|i0)$/.test(txt)) added = addAtom(el, `var:w_${txt.slice(1)}`, true, root);
            else if (/^w(\d)$/.test(txt)) added = addAtom(el, `var:w_${txt[1]}`, true, root);
            else if (txt === "wnew") added = addAtom(el, "var:w_new", true, root);
            else if (txt === "wold") added = addAtom(el, "var:w_old", true, root);
            else if (/^w([ijkm])$/.test(txt)) added = addAtom(el, `var:w_${txt[1]}`, true, root);
            // Subscripted inputs, targets, outputs, errors, hidden states, datasets
            else if (txt === "xp,i") added = addAtom(el, ["var:x_pi", "var:x_p"], true, root);
            else if (txt === "xp,j") added = addAtom(el, ["var:x_pj", "var:x_p"], true, root);
            else if (txt === "xp") added = addAtom(el, "var:x_p", true, root);
            else if (/^x([0-9abijkqt])$/.test(txt)) added = addAtom(el, `var:x_${txt[1]}`, true, root);
            else if (/^d([pikr])$/.test(txt)) added = addAtom(el, `var:d_${txt[1]}`, true, root);
            else if (/^D(TR|VL|TS|[lrki12K])$/.test(txt)) added = addAtom(el, [`var:D_${txt.slice(1)}`, "var:D"], true, root);
            else if (/^o([kjiturp0])$/.test(txt)) added = addAtom(el, `var:o_${txt[1]}`, true, root);
            else if (txt === "ei") added = addAtom(el, "var:e_i", true, root);
            else if (/^y([it])$/.test(txt)) added = addAtom(el, `var:y_${txt[1]}`, true, root);
            else if (/^z([1lir])$/.test(txt)) added = addAtom(el, `var:z_${txt[1]}`, true, root);
            else if (txt === "ht") added = addAtom(el, "var:h_t", true, root);
            else if (txt === "ct") added = addAtom(el, "var:c_t", true, root);
            else if (/^h([12])$/.test(txt)) added = addAtom(el, `var:h_${txt[1]}`, true, root);
            else if (/^H([12n])$/.test(txt)) added = addAtom(el, [`var:H_${txt[1]}`, "var:H"], true, root);
            else if (/^N([k0])$/.test(txt)) added = addAtom(el, `var:N_${txt[1]}`, true, root);
            else if (txt === "fσ") added = addAtom(el, "var:f_sigma", true, root);
            else if (/^f([jkt])$/.test(txt)) added = addAtom(el, `var:f_${txt[1]}`, true, root);
            else if (/^net([ijkt])$/.test(txt)) added = addAtom(el, [`var:net_${txt.slice(3)}`, "var:net"], true, root);
            else if (/^hw[\*∗]?$/.test(txt)) added = addAtom(el, ["var:h_w", "var:h"], true, root);
            else if (txt === "ERMS") added = addAtom(el, "var:E_RMS", true, root);
            else if (txt === "ETR") added = addAtom(el, "var:E_TR", true, root);
            else if (txt === "Etot") added = addAtom(el, ["var:E_tot", "var:E"], true, root);
            else if (txt === "Ep") added = addAtom(el, ["var:E_p", "var:E"], true, root);
            else if (txt === "Ep,k") added = addAtom(el, ["var:E_pk", "var:E"], true, root);
            else if (txt === "Remp") added = addAtom(el, "var:R_emp", true, root);
            else if (txt.startsWith("VS")) added = addAtom(el, "var:VS", true, root);
            else if (/^δ([pkjth])$/.test(txt)) added = addAtom(el, [`var:delta_${txt[1]}`, "var:delta"], true, root);
            else if (txt === "αi") added = addAtom(el, ["var:alpha_i", "sym:alpha"], true, root);
            else if (txt === "ξi") added = addAtom(el, ["var:xi_i", "sym:xi"], true, root);
            else if (txt === "η0") added = addAtom(el, ["var:eta_0", "sym:eta"], true, root);
            else if (txt === "ητ") added = addAtom(el, ["var:eta_tau", "sym:eta"], true, root);
            else if (txt === "σ2") added = addAtom(el, ["sym:sigma_sq", "sym:sigma"], true, root);
            else if (/^[φϕ]([kj])$/.test(txt)) added = addAtom(el, [`var:phi_${txt[1]}`, "sym:phi"], true, root);
            else if (txt === "θm") added = addAtom(el, ["var:theta_m", "sym:theta"], true, root);
            else if (/^θ/.test(txt)) added = addAtom(el, "sym:theta", true, root);
            // Specific high-frequency Cap 13-19 & Cap 01-12 symbols
            else if (/^w(?:oT|To)$/.test(txt)) added = addAtom(el, ["var:w_o_T", "var:w_o", "var:w_T", "var:w"], true, root);
            else if (txt === "wo") added = addAtom(el, ["var:w_o", "var:w_0", "var:w"], true, root);
            else if (/^x(?:iT|Ti)$/.test(txt)) added = addAtom(el, ["var:x_i_T", "var:x_i", "var:x_T", "var:x"], true, root);
            else if (txt === "bo") added = addAtom(el, ["var:b_o", "var:b_0", "var:b"], true, root);
            else if (txt === "aT") added = addAtom(el, ["var:a_T", "var:a"], true, root);
            else if (/^x(?:12|21)$/.test(txt)) added = addAtom(el, ["var:x_1_sq", "var:x_1", "var:x"], true, root);
            else if (txt === "x22") added = addAtom(el, ["var:x_2_sq", "var:x_2", "var:x"], true, root);
            else if (txt === "y2" && supOnly) added = addAtom(el, ["var:y_sq", "var:y"], true, root);
            else if (txt === "R2" && !supOnly) added = addAtom(el, ["set:R^2", "set:R"], true, root);
            else if (txt === "R3") added = addAtom(el, ["set:R^3", "set:R"], true, root);
            else if (/^w(?:i[\*∗]|[\*∗]i)/.test(txt)) added = addAtom(el, ["var:w_i_star", "var:w_star", "var:w_i", "var:w"], true, root);
            else if (/^i[\*∗]$/.test(txt)) added = addAtom(el, ["var:i_star", "var:i"], true, root);
            else if (/^α(?:i′|′i)$/.test(txt)) added = addAtom(el, ["var:alpha_i_prime", "var:alpha_i", "sym:alpha"], true, root);
            else if (txt === "αj") added = addAtom(el, ["var:alpha_j", "sym:alpha"], true, root);
            else if (txt === "αo,i") added = addAtom(el, ["var:alpha_oi", "var:alpha_i", "sym:alpha"], true, root);
            else if (/^ξ(?:i′|′i)$/.test(txt)) added = addAtom(el, ["var:xi_i_prime", "var:xi_i", "sym:xi"], true, root);
            else if (txt === "γi") added = addAtom(el, ["var:gamma_i", "sym:gamma"], true, root);
            else if (txt === "dj") added = addAtom(el, ["var:d_j", "var:d"], true, root);
            else if (/^h([ivu])$/.test(txt)) added = addAtom(el, [`var:h_${txt[1]}`, "var:h"], true, root);
            else if (/^k([12])$/.test(txt)) added = addAtom(el, [`var:k_${txt[1]}`, "var:k"], true, root);
            else if (txt === "Δp") added = addAtom(el, ["var:Delta_p", "var:delta_p", "var:delta"], true, root);
            else if (/^hθ/.test(txt)) added = addAtom(el, ["var:theta_m_star", "var:theta_m", "var:h"], true, root);
            else if (txt.includes("D") && txt.includes("ˉ")) added = addAtom(el, ["bar:D_k", "var:D"], true, root);
            else if (!el.querySelector(".mfrac, .sqrt")) {
              // Universal .msupsub catch-all: ALWAYS keep base + subscript/superscript together as ONE atom
              // so a composite symbol NEVER highlights only 1 of its 2-4 characters!
              const baseNode = Array.from(el.children).find((c) => !c.classList.contains("msupsub"));
              const bTxt = katexText(baseNode || el);
              const subNode = el.querySelector(":scope > .msupsub");
              const sTxt = katexText(subNode);
              const greekMap = {
                "α": "sym:alpha", "β": "sym:beta", "γ": "sym:gamma", "δ": "var:delta", "Δ": "var:delta",
                "ε": "sym:eps", "ϵ": "sym:eps", "η": "sym:eta", "θ": "sym:theta", "λ": "sym:lambda",
                "μ": "sym:mu", "ξ": "sym:xi", "π": "sym:pi", "ρ": "sym:rho", "σ": "sym:sigma",
                "Σ": "sym:Sigma", "τ": "sym:tau", "φ": "sym:phi", "ϕ": "sym:phi", "Φ": "sym:phi",
                "Ψ": "sym:psi", "ψ": "sym:psi", "Ω": "sym:omega", "ω": "sym:omega"
              };
              const fbKeys = [];
              if (bTxt && bTxt in greekMap) {
                fbKeys.push(`${greekMap[bTxt]}_${sTxt}`, greekMap[bTxt]);
              } else if (/^[A-Za-z]$/.test(bTxt)) {
                const cleanSub = sTxt.replace(/[^A-Za-z0-9]/g, "");
                if (cleanSub) fbKeys.push(`var:${bTxt}_${cleanSub}`);
                if (sTxt.includes("T")) fbKeys.push(`var:${bTxt}_T`);
                if (sTxt.includes("∗") || sTxt.includes("*")) fbKeys.push(`var:${bTxt}_star`);
                if (sTxt.includes("′")) fbKeys.push(`var:${bTxt}_prime`);
                fbKeys.push(`var:${bTxt}`);
              } else if (/^[A-Za-z]{2,8}$/.test(bTxt)) {
                const low = bTxt.toLowerCase();
                if (low === "bias") fbKeys.push("op:Bias", "var:bias");
                else if (low === "net") fbKeys.push("var:net");
                else fbKeys.push(`var:${low}`);
              } else if (bTxt && (bTxt.includes("ˉ") || bTxt.includes("^"))) {
                const ch = bTxt.replace(/[^A-Za-z]/g, "")[0];
                if (ch) fbKeys.push(`bar:${ch}`, `var:${ch}`);
              }
              if (fbKeys.length > 0) {
                added = addAtom(el, fbKeys, true, root);
              }
            }
            if (added) continue;
          }

          // 8. Leaf single-token symbols, variables, and integers
          if (!el.querySelector(".mord")) {
            if (/^\d+$/.test(txt)) { addAtom(el, canonicalNumKey(txt), true, root); continue; }
            if (txt === "α") { addAtom(el, "sym:alpha", true, root); continue; }
            if (txt === "β") { addAtom(el, "sym:beta", true, root); continue; }
            if (txt === "γ") { addAtom(el, "sym:gamma", true, root); continue; }
            if (txt === "τ") { addAtom(el, "sym:tau", true, root); continue; }
            if (txt === "ρ") { addAtom(el, "sym:rho", true, root); continue; }
            if (txt === "ξ") { addAtom(el, "sym:xi", true, root); continue; }
            if (txt === "∞") { addAtom(el, "sym:infty", true, root); continue; }
            if (txt === "±") { addAtom(el, "op:pm", true, root); continue; }
            if (txt === "λ") { addAtom(el, "sym:lambda", true, root); continue; }
            if (txt === "η") { addAtom(el, "sym:eta", true, root); continue; }
            if (txt === "δ" || txt === "Δ") { addAtom(el, "var:delta", true, root); continue; }
            if (txt === "σ") { addAtom(el, "sym:sigma", true, root); continue; }
            if (txt === "Σ") { addAtom(el, "sym:Sigma", true, root); continue; }
            if (txt === "θ") { addAtom(el, "sym:theta", true, root); continue; }
            if (txt === "ε" || txt === "ϵ") { addAtom(el, "sym:eps", true, root); continue; }
            if (txt === "π") { addAtom(el, "sym:pi", true, root); continue; }
            if (txt === "ϕ" || txt === "φ" || txt === "Φ") { addAtom(el, "sym:phi", true, root); continue; }
            if (txt === "Ψ" || txt === "ψ") { addAtom(el, "sym:psi", true, root); continue; }
            if (txt === "Ω" || txt === "ω") { addAtom(el, "sym:omega", true, root); continue; }
            if (txt === "μ") { addAtom(el, "sym:mu", true, root); continue; }
            if (txt === "∇") { addAtom(el, "op:nabla", true, root); continue; }
            if (txt === "net") { addAtom(el, "var:net", true, root); continue; }
            if (txt === "VC") { addAtom(el, "var:VC", true, root); continue; }
            if (txt === "TR") { addAtom(el, "var:TR", true, root); continue; }
            if (txt === "VS") { addAtom(el, "var:VS", true, root); continue; }
            if (txt === "false") { addAtom(el, "var:false", true, root); continue; }
            if (txt === "E" && el.classList.contains("mathbb")) { addAtom(el, ["op:E", "var:E"], true, root); continue; }
            if (txt === "P" && el.classList.contains("mathcal")) { addAtom(el, ["var:P_X", "var:P"], true, root); continue; }
            if (txt === "R" && el.classList.contains("mathbb")) { addAtom(el, ["set:R", "var:R"], true, root); continue; }
            if (/^[A-Za-z]$/.test(txt)) { addAtom(el, `var:${txt}`, true, root); continue; }
          }
        }

        // Recurse into non-leaf structural containers (.base, .mord, .enclosing, .sizing, .vlist, [id^="f-"], etc.)
        if (el.children.length > 0 && !el.classList.contains("msupsub")) {
          visitChildren(el);
        }
      }
    };

    visitChildren(root);

    root.querySelectorAll("[id^='f-']").forEach((el) => {
      el.classList.add("katex-atom");
    });
  });

  return atoms;
}

// ---------- Viterbi Monotonic Sequence Aligner ----------

function atomMatchScore(atom, ev) {
  let base = -1;
  for (let idx = 0; idx < ev.keys.length; idx++) {
    if (atom.keys.has(ev.keys[idx])) {
      // Primary key scores higher than fallback alias
      base = (ev.specificity || 8) - idx * 2.0;
      break;
    }
  }
  if (base < 0) return -1;
  // Prefer body equations over step-tag/box-label/slide-title when both match
  return base + (atom.isHeader ? 0 : 1.8);
}

// Align block events to block atoms via Viterbi DP maximizing left-to-right contiguity
function alignEventsToAtomsViterbi(bEvents, bAtoms) {
  const N = bEvents.length;
  const M = bAtoms.length;
  if (N === 0 || M === 0) return [];

  // Sparse candidate list per event
  const cands = bEvents.map((ev) => {
    const list = [];
    for (let j = 0; j < M; j++) {
      const sc = atomMatchScore(bAtoms[j], ev);
      if (sc > 0) list.push({ j, emit: sc });
    }
    return list;
  });

  // dp[i][c] = best cumulative score ending with event i matched to cands[i][c]
  const dp = [];
  const prev = [];

  for (let i = 0; i < N; i++) {
    const row = new Float64Array(cands[i].length);
    const pRow = new Int32Array(cands[i].length);
    pRow.fill(-1);

    // Find most recent previous event that had at least 1 candidate
    let prevEvIdx = i - 1;
    while (prevEvIdx >= 0 && cands[prevEvIdx].length === 0) prevEvIdx--;

    for (let c = 0; c < cands[i].length; c++) {
      const { j, emit } = cands[i][c];
      if (prevEvIdx < 0) {
        // Slight preference for starting earlier in the block
        row[c] = emit - j * 0.04;
      } else {
        const dt = bEvents[i].start - bEvents[prevEvIdx].end;
        let bestScore = -Infinity;
        let bestPrev = -1;
        for (let pc = 0; pc < cands[prevEvIdx].length; pc++) {
          const pj = cands[prevEvIdx][pc].j;
          const step = j - pj;
          let trans = 0;
          if (step === 1) trans = 6.5;
          else if (step === 2) trans = 4.8;
          else if (step >= 3 && step <= 5) trans = 2.6;
          else if (step > 5) trans = 0.6;
          else if (step === 0) trans = dt > 0.65 ? 0.5 : -2.5;
          else trans = dt >= 1.25 ? 0.0 : -4.5; // allow revisit after pause, penalize mid-formula jump back

          // Same KaTeX expression continuity bonus
          if (dt < 1.8 && bAtoms[j].katexRoot === bAtoms[pj].katexRoot && step > 0) {
            trans += 1.5;
          }

          const score = dp[prevEvIdx][pc] + emit + trans;
          if (score > bestScore) {
            bestScore = score;
            bestPrev = pc;
          }
        }
        row[c] = bestScore;
        pRow[c] = bestPrev;
      }
    }
    dp.push(row);
    prev.push(pRow);
  }

  // Backtrack from last non-empty event row
  const assigned = new Array(N).fill(-1);
  let lastEv = N - 1;
  while (lastEv >= 0 && cands[lastEv].length === 0) lastEv--;
  if (lastEv < 0) return assigned;

  let bestC = 0;
  for (let c = 1; c < cands[lastEv].length; c++) {
    if (dp[lastEv][c] > dp[lastEv][bestC]) bestC = c;
  }

  let curEv = lastEv;
  let curC = bestC;
  while (curEv >= 0 && curC >= 0) {
    assigned[curEv] = cands[curEv][curC].j;
    curC = prev[curEv][curC];
    let pEv = curEv - 1;
    while (pEv >= 0 && cands[pEv].length === 0) pEv--;
    curEv = pEv;
  }
  return assigned;
}

// ---------- LiveSyncEngine v4 ----------

export class LiveSyncEngine {
  constructor(stageEl, onSeek) {
    this.stage = stageEl;
    this.onSeek = onSeek;
    this.enabled = true;
    this.clauses = [];
    this.blocks = [];
    this.atoms = [];
    this.words = [];
    this.activeAtom = null;
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
    this.activeAtom = null;
  }

  prepareScene(scene, subtitles) {
    this.clearVisuals();
    this.clauses = [];
    this.blocks = [];
    this.atoms = [];
    this.words = [];

    const slideCard = this.stage.querySelector(".slide-card");
    if (!slideCard) return;

    // 1. Collect reveal & highlight timestamps per element from cues
    const showAtMap = new Map();
    const untilMap = new Map();
    const hlAtMap = new Map();
    for (const cue of scene.cues || []) {
      if (cue.action === "show") {
        this.stage.querySelectorAll(cue.target).forEach((el) => {
          const prev = showAtMap.get(el);
          if (prev === undefined || cue.at < prev) showAtMap.set(el, cue.at);
          if (typeof cue.until === "number") untilMap.set(el, cue.until);
        });
      } else if (cue.action === "highlight") {
        this.stage.querySelectorAll(cue.target).forEach((el) => {
          const prev = hlAtMap.get(el);
          if (prev === undefined || cue.at < prev) hlAtMap.set(el, cue.at);
        });
      }
    }

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

    // 3. Build Spotlight blocks (outermost content cards) + Math-owner blocks (includes title & highlighted table rows & li items)
    const blockSelectors = ".box, .math-card, .proof-step, .svg-panel, .acad-table, .pill-strip, .props-grid, .metrics-row, .gate-card, .plot-card";
    const rawBlocks = Array.from(slideCard.querySelectorAll(blockSelectors)).filter(
      (el) => !el.parentElement?.closest(".box, .math-card, .proof-step, .svg-panel")
    );

    // Non-SVG content show timestamps (so a side SVG never truncates an active formula card or table!)
    const contentShowTimes = rawBlocks
      .filter((el) => !el.classList.contains("svg-panel"))
      .map((el) => getShowAt(el))
      .filter((t) => t > 0)
      .sort((a, b) => a - b);

    const firstShowAt = contentShowTimes.length > 0 ? contentShowTimes[0] : totalDur;

    for (const bEl of rawBlocks) {
      const showAt = getShowAt(bEl);
      const explicitUntil = getUntilAt(bEl);
      const untilAt = explicitUntil !== null ? explicitUntil : totalDur;
      let activeEnd = untilAt;
      if (explicitUntil === null && !bEl.classList.contains("svg-panel")) {
        for (const t of contentShowTimes) {
          if (t > showAt + 0.4) {
            activeEnd = t;
            break;
          }
        }
      }
      this.blocks.push({ el: bEl, showAt, untilAt, activeStart: showAt, activeEnd, isSpotlight: true });
    }

    // Also create fine-grained math-owner sub-blocks for:
    //  - .slide-title containing KaTeX math
    //  - table rows (tr) targeted by highlight cues (e.g. 02-problema/scene-07 4 loss rows)
    //  - list items (li) targeted by show cues (e.g. closing recap slides)
    const mathBlocks = [...this.blocks];
    const titleEl = slideCard.querySelector(".slide-title");
    if (titleEl && titleEl.querySelector(".katex")) {
      mathBlocks.push({
        el: titleEl,
        showAt: 0,
        untilAt: totalDur,
        activeStart: 0,
        activeEnd: firstShowAt,
        isSpotlight: false
      });
    }

    const hlRows = Array.from(slideCard.querySelectorAll("tr")).filter((tr) => hlAtMap.has(tr));
    if (hlRows.length > 0) {
      hlRows.sort((a, b) => hlAtMap.get(a) - hlAtMap.get(b));
      for (let r = 0; r < hlRows.length; r++) {
        const tr = hlRows[r];
        const parentTable = tr.closest("table");
        const tableMeta = this.blocks.find((b) => b.el === parentTable);
        const tableEnd = tableMeta ? tableMeta.activeEnd : totalDur;
        const parentShow = getShowAt(tr);
        const startHl = r === 0 ? Math.min(parentShow, hlAtMap.get(tr) - 8) : hlAtMap.get(tr);
        const nextHl = r + 1 < hlRows.length ? hlAtMap.get(hlRows[r + 1]) : tableEnd;
        mathBlocks.push({
          el: tr,
          showAt: parentShow,
          untilAt: totalDur,
          activeStart: Math.max(parentShow, startHl - 0.5),
          activeEnd: Math.min(nextHl, tableEnd),
          isSpotlight: false
        });
      }
    }

    const showLis = Array.from(slideCard.querySelectorAll("li")).filter((li) => showAtMap.has(li));
    if (showLis.length > 0) {
      showLis.sort((a, b) => showAtMap.get(a) - showAtMap.get(b));
      for (let k = 0; k < showLis.length; k++) {
        const li = showLis[k];
        const sAt = showAtMap.get(li);
        const nextAt = k + 1 < showLis.length ? showAtMap.get(showLis[k + 1]) : totalDur;
        mathBlocks.push({
          el: li,
          showAt: sAt,
          untilAt: totalDur,
          activeStart: sAt,
          activeEnd: nextAt,
          isSpotlight: false
        });
      }
    }

    // 4. Wrap prose clauses word-by-word & align inside each block's active cue window (prevents cursor poisoning!)
    const blockMetaMap = new Map();
    for (const b of this.blocks) blockMetaMap.set(b.el, b);
    for (const mb of mathBlocks) {
      if (!blockMetaMap.has(mb.el)) blockMetaMap.set(mb.el, mb);
    }

    const clauseCandidates = [];
    for (const b of this.blocks) {
      const bEl = b.el;
      if (bEl.classList.contains("svg-panel")) continue;
      const textTargets = bEl.querySelectorAll("p, li, td");
      textTargets.forEach((tEl) => {
        if (tEl.closest(".katex")) return;
        const wrapped = wrapClausesWordByWord(tEl);
        const ownerLi = tEl.tagName === "LI" ? blockMetaMap.get(tEl) : null;
        const ownerTr = tEl.closest("tr") ? blockMetaMap.get(tEl.closest("tr")) : null;
        const ownerMeta = ownerLi || ownerTr || b;
        for (const wObj of wrapped) {
          const toks = extractTokens(wObj.el.textContent || "");
          if (toks.length >= 2) {
            clauseCandidates.push({
              el: wObj.el,
              wordEls: wObj.wordEls,
              block: bEl,
              parentTarget: tEl,
              tokens: toks,
              showAt: getShowAt(tEl),
              winStart: ownerMeta.activeStart ?? getShowAt(tEl),
              winEnd: ownerMeta.activeEnd ?? totalDur,
              isVerify: Boolean(tEl.closest(".verify-list")),
              start: -1,
              end: -1
            });
          }
        }
      });
    }

    if (this.words.length > 0 && clauseCandidates.length > 0) {
      // Group clauses by owning block so one noisy match in block A can NEVER poison block B!
      const clausesByBlock = new Map();
      for (const c of clauseCandidates) {
        if (!clausesByBlock.has(c.block)) clausesByBlock.set(c.block, []);
        clausesByBlock.get(c.block).push(c);
      }

      const alignClauseInRange = (item, startIdx, endIdx, strict) => {
        const cSet = new Set(item.tokens);
        const minHits = strict ? (item.tokens.length >= 4 ? 3 : 2) : (item.tokens.length >= 5 ? 2 : 2);
        const minRecall = strict ? 0.45 : 0.34;
        const minScore = strict ? 0.50 : 0.38;
        const winSize = Math.min(32, Math.max(10, item.tokens.length * 3 + 6));

        let bestScore = 0;
        let bestRange = null;
        for (let i = startIdx; i < endIdx; i++) {
          const wTok = this.words[i].tok;
          if (!wTok || !cSet.has(wTok)) continue;
          const matched = new Set();
          let firstMatch = i;
          let lastMatch = i;
          const endLim = Math.min(endIdx, i + winSize);
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
            const timeDist = Math.abs(this.words[firstMatch].start - item.winStart);
            const proxBonus = timeDist < 18 ? 0.14 : 0;
            const score = recall * 0.68 + Math.min(1, density * 1.4) * 0.24 + proxBonus;
            if (score > bestScore) {
              bestScore = score;
              bestRange = [firstMatch, lastMatch];
            }
          }
        }
        return bestRange && bestScore >= minScore ? bestRange : null;
      };

      const bindClauseTiming = (item, t0, t1) => {
        item.start = Math.max(0, t0);
        item.end = Math.min(totalDur, Math.max(item.start + 0.45, t1));
        item.el.classList.add("voice-syncable");
        item.el.title = `Vai a ${this._fmt(item.start)}`;
        item.el.addEventListener("click", (e) => {
          e.stopPropagation();
          if (typeof this.onSeek === "function") this.onSeek(item.start);
        });
      };

      for (const [bEl, bClauses] of clausesByBlock.entries()) {
        const bMeta = blockMetaMap.get(bEl) || { activeStart: 0, activeEnd: totalDur };
        let bCursor = 0;

        for (const item of bClauses) {
          const searchStartTime = Math.max(0, item.winStart - 1.5);
          const searchEndTime = Math.min(totalDur, item.winEnd + 3.0);

          let wStart = bCursor;
          while (wStart < this.words.length && this.words[wStart].end < searchStartTime) wStart++;
          if (wStart > 0 && this.words[Math.min(bCursor, this.words.length - 1)].start > searchEndTime) {
            // Reset cursor if an earlier clause landed outside this item's own window
            wStart = 0;
            while (wStart < this.words.length && this.words[wStart].end < searchStartTime) wStart++;
          }
          let wEnd = wStart;
          while (wEnd < this.words.length && this.words[wEnd].start <= searchEndTime) wEnd++;

          // Pass 1: search inside the block's exact cue window (high precision, gentle recall!)
          let bestRange = wEnd > wStart ? alignClauseInRange(item, wStart, wEnd, false) : null;

          // Pass 2: wider fallback across remaining scene (stricter threshold to avoid false jumps)
          if (!bestRange && !item.isVerify) {
            let fullStart = 0;
            while (fullStart < this.words.length && this.words[fullStart].end < Math.max(0, item.showAt - 1.0)) fullStart++;
            bestRange = alignClauseInRange(item, fullStart, this.words.length, true);
          }

          if (bestRange) {
            const [i0, i1] = bestRange;
            bindClauseTiming(item, this.words[i0].start - 0.08, this.words[i1].end + 0.18);
            // Advance block cursor only when match lies inside the block's own window
            if (this.words[i0].start <= searchEndTime) {
              bCursor = Math.min(this.words.length - 1, i0 + 1);
            }
          }
        }

        // Pass 3: Clean sequential fallback for paraphrased clauses inside a cue-timed block
        // (keeps paraphrased summary boxes & cue-revealed items softly illuminated in sync with their block!)
        const unaligned = bClauses.filter((c) => c.start < 0 && !c.isVerify && (c.winEnd - c.winStart) >= 1.2);
        if (unaligned.length > 0 && unaligned.length <= 6) {
          // Group unaligned items by their exact [winStart, winEnd] window
          const byWin = new Map();
          for (const u of unaligned) {
            const wk = `${u.winStart.toFixed(2)}:${u.winEnd.toFixed(2)}`;
            if (!byWin.has(wk)) byWin.set(wk, []);
            byWin.get(wk).push(u);
          }
          for (const group of byWin.values()) {
            const w0 = group[0].winStart;
            const w1 = group[0].winEnd;
            // Only synthesize sequential slices if no already-matched clause already covers >60% of this window
            const coveredDur = bClauses
              .filter((c) => c.start >= 0 && c.end > w0 && c.start < w1)
              .reduce((acc, c) => acc + Math.max(0, Math.min(w1, c.end) - Math.max(w0, c.start)), 0);
            if (coveredDur < (w1 - w0) * 0.55) {
              const totalWords = group.reduce((acc, c) => acc + Math.max(1, c.wordEls.length), 0);
              let curT = w0;
              for (const u of group) {
                const frac = Math.max(1, u.wordEls.length) / totalWords;
                const dur = Math.max(0.6, (w1 - w0) * frac);
                bindClauseTiming(u, curT, Math.min(w1, curT + dur));
                curT += dur;
              }
            }
          }
        }
      }
    }

    this.clauses = clauseCandidates.filter((c) => c.start >= 0);

    // 5. Index ALL KaTeX atoms and align with Viterbi DP + strict global non-overlapping windows!
    this.atoms = indexFormulaAtoms(slideCard, mathBlocks);
    if (this.atoms.length > 0 && this.words.length > 0) {
      const mathEvents = extractSpokenMathEvents(this.words);

      // Map each mathBlock element -> block metadata & atom list
      const blockMetaByEl = new Map();
      for (const b of mathBlocks) blockMetaByEl.set(b.el, b);

      const atomsByBlock = new Map();
      const keySetByBlock = new Map();
      for (const a of this.atoms) {
        if (!atomsByBlock.has(a.blockEl)) {
          atomsByBlock.set(a.blockEl, []);
          keySetByBlock.set(a.blockEl, new Set());
        }
        atomsByBlock.get(a.blockEl).push(a);
        const ks = keySetByBlock.get(a.blockEl);
        for (const k of a.keys) ks.add(k);
      }

      const blockHasEventKey = (bEl, ev) => {
        const ks = keySetByBlock.get(bEl);
        if (!ks) return false;
        return ev.keys.some((k) => ks.has(k));
      };

      // Route each spoken math event ONLY to a block active at ev.start (never bleed into past rows/steps!)
      const eventsByBlock = new Map();
      for (const ev of mathEvents) {
        let bestBlock = null;
        let bestRank = -Infinity;

        for (const [bEl, bAtoms] of atomsByBlock.entries()) {
          if (bAtoms.length === 0 || !blockHasEventKey(bEl, ev)) continue;
          const meta = blockMetaByEl.get(bEl) || { showAt: 0, untilAt: totalDur, activeStart: 0, activeEnd: totalDur };
          if (ev.end < meta.showAt - 0.35 || ev.start > meta.untilAt + 0.15) continue;

          const inPrimary = ev.start >= meta.activeStart - 0.35 && ev.start <= meta.activeEnd + 0.35;
          // Strictly require inPrimary so past table rows / proof steps / boxes never flash retroactively!
          if (!inPrimary) continue;

          const isFineRow = bEl.tagName === "TR" || bEl.tagName === "LI";
          const isTitle = bEl.classList.contains("slide-title");
          const isSvg = bEl.classList.contains("svg-panel");

          let rank = 100;
          if (isFineRow) rank += 35;
          if (isTitle) rank -= 15;
          if (isSvg) rank -= 10;
          rank += meta.showAt * 0.05;

          if (rank > bestRank) {
            bestRank = rank;
            bestBlock = bEl;
          }
        }

        if (bestBlock) {
          if (!eventsByBlock.has(bestBlock)) eventsByBlock.set(bestBlock, []);
          eventsByBlock.get(bestBlock).push(ev);
        }
      }

      // Run Viterbi DP inside each block and collect all global matches
      const globalMatches = []; // { atom, ev, showAt }
      for (const [bEl, bEvents] of eventsByBlock.entries()) {
        const bAtoms = atomsByBlock.get(bEl) || [];
        const meta = blockMetaByEl.get(bEl) || { showAt: 0 };
        const assigned = alignEventsToAtomsViterbi(bEvents, bAtoms);
        for (let i = 0; i < bEvents.length; i++) {
          const atomIdx = assigned[i];
          if (atomIdx >= 0 && bAtoms[atomIdx]) {
            globalMatches.push({
              atom: bAtoms[atomIdx],
              ev: bEvents[i],
              showAt: meta.showAt
            });
          }
        }
      }

      // Sort ALL matched events chronologically and clamp windows so ZERO overlaps can occur!
      globalMatches.sort((a, b) => a.ev.start - b.ev.start);
      for (let i = 0; i < globalMatches.length; i++) {
        const cur = globalMatches[i];
        const next = i + 1 < globalMatches.length ? globalMatches[i + 1] : null;

        const start = Math.max(cur.showAt, cur.ev.start - 0.05);
        // Ensure quick 40ms MMS_FA single-letter tokens stay readable (~0.34s) unless next math event arrives sooner
        const desiredEnd = Math.max(cur.ev.end + 0.16, start + 0.34);
        const nextStart = next ? Math.max(next.showAt, next.ev.start - 0.05) : Infinity;
        const end = Math.max(start + 0.06, Math.min(desiredEnd, nextStart - 0.015));

        cur.atom.windows.push({ start, end });
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

    // 3. STRICT SINGLE-ATOM FORMULA GLOW (computed BEFORE Spotlight so active formula lights its card!)
    let winnerAtom = null;
    let winnerStart = -Infinity;
    for (const atom of this.atoms) {
      if (atom.windows.length === 0) continue;
      if (atom.els[0].closest(".cue-hidden")) continue;
      for (const w of atom.windows) {
        if (t >= w.start && t <= w.end && w.start >= winnerStart) {
          winnerAtom = atom;
          winnerStart = w.start;
        }
      }
    }

    if (winnerAtom !== this.activeAtom) {
      if (this.activeAtom) {
        for (const el of this.activeAtom.els) el.classList.remove("math-live-glow");
      }
      if (winnerAtom) {
        for (const el of winnerAtom.els) el.classList.add("math-live-glow");
      }
      this.activeAtom = winnerAtom;
    }

    // 4. Determine SINGLE active Spotlight block (explicit cue -> active clause -> active formula -> latest non-SVG content)
    const spotlightSel = ".box, .math-card, .proof-step, .svg-panel, .acad-table, .pill-strip, .props-grid, .metrics-row, .gate-card, .plot-card";
    let activeBlock = null;
    const explicitHl = this.stage.querySelector(".cue-highlight");
    if (explicitHl) {
      activeBlock = explicitHl.closest(spotlightSel);
    }
    if (!activeBlock && bestClause) {
      activeBlock = bestClause.block;
    }
    if (!activeBlock && winnerAtom && winnerAtom.els[0]) {
      activeBlock = winnerAtom.els[0].closest(spotlightSel);
    }
    if (!activeBlock) {
      let latestShow = -1;
      for (const b of this.blocks) {
        if (b.el.classList.contains("svg-panel")) continue;
        if (!b.el.classList.contains("cue-hidden") && t >= b.showAt && b.showAt >= latestShow) {
          latestShow = b.showAt;
          activeBlock = b.el;
        }
      }
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
