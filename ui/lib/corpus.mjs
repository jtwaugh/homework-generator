// Problem corpus (stored in ui/data/hw.db; v0 kept it in ui/data/corpus/problems.jsonl, one problem per line).
// Shared by the server, the MCP tool server, the seed script and the tests. No dependencies.
//
//   {id, tex, answer, units:[U14], wuNodes:[e57, m:e5], tags:[], context,
//    source:{kind: gold|final|web|teacher, file?, url?, date?, note?},
//    status: candidate|used|favorite|rejected, usedOn:[YYYY-MM-DD], casVerified, addedAt}
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadCorpusDb, saveCorpusDb } from "./store.mjs";

export const DATA = process.env.HW_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

// ---------- storage ----------
// The corpus lives in hw.db (lib/store.mjs); items keep the jsonl shape above, with units/wuNodes resolved to
// the active enrollment's curriculum version and usedOn from that student's assignments. Passing a file
// reads or writes a jsonl file instead (v0 data, exports, tests).

export function loadCorpus(file = null) {
  if (!file) return loadCorpusDb();
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}
export function saveCorpus(items, file = null, opts = {}) {
  if (!file) return saveCorpusDb(items, undefined, opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, items.map((p) => JSON.stringify(p)).join("\n") + (items.length ? "\n" : ""));
  fs.renameSync(tmp, file);
}

// Same problem = same TeX after whitespace and spacing-command normalization.
export const normTex = (t) => String(t || "").replace(/\\(probskip|vspace\{[^}]*\}|\\|,|;|quad|qquad)/g, " ").replace(/\s+/g, "").toLowerCase();
export const problemId = (tex) => "p" + createHash("sha256").update(normTex(tex)).digest("hex").slice(0, 10);

const asList = (x) => (Array.isArray(x) ? x : x ? String(x).split(/[,;]\s*/) : []).map((s) => String(s).trim()).filter(Boolean);

export const sameAnswer = (a, b) => String(a ?? "").replace(/\s+/g, "") === String(b ?? "").replace(/\s+/g, "");

// Add or merge problems. Returns { added: [ids], merged: [ids] }.
export function addProblems(items, incoming, { file } = {}) {
  const byId = new Map(items.map((p) => [p.id, p]));
  const added = [], merged = [];
  for (const raw of incoming) {
    if (!raw?.tex || !String(raw.tex).trim()) continue;
    const id = problemId(raw.tex);
    const units = asList(raw.units).map((u) => u.toUpperCase()).filter((u) => /^(U\d\d|M\d|F\d)$/.test(u));
    const wuNodes = asList(raw.wuNodes);
    const tags = asList(raw.tags).map((t) => t.toLowerCase());
    // Exact match by id, else a cosmetic near-copy (renamed variable, reworded directions).
    const old = byId.get(id) || nearDuplicates(items, raw.tex)[0];
    if (old) {
      if (old.id !== id) old.aliases = [...new Set([...(old.aliases || []), id])];
      // merge: never downgrade status, union tags, keep the earliest source
      old.units = [...new Set([...old.units, ...units])];
      old.wuNodes = [...new Set([...(old.wuNodes || []), ...wuNodes])];
      old.tags = [...new Set([...old.tags, ...tags])];
      if (!old.answer && raw.answer) old.answer = String(raw.answer);
      // A verification only carries over to the same problem with the same answer (not to a near-copy).
      if (raw.casVerified && old.id === id && (!old.answer || sameAnswer(old.answer, raw.answer))) old.casVerified = true;
      if (raw.status === "used" && old.status === "candidate") old.status = "used";
      if (raw.usedOn) old.usedOn = [...new Set([...(old.usedOn || []), ...asList(raw.usedOn)])].sort();
      merged.push(old.id);
    } else {
      const p = {
        id, tex: String(raw.tex).trim(), answer: raw.answer ? String(raw.answer) : "",
        units, wuNodes, tags, context: raw.context ? String(raw.context) : "",
        source: { kind: raw.source?.kind || "web", ...(raw.source || {}) },
        status: ["candidate", "used", "favorite", "rejected"].includes(raw.status) ? raw.status : "candidate",
        usedOn: asList(raw.usedOn).sort(), casVerified: !!raw.casVerified, addedAt: raw.addedAt || new Date().toISOString(),
      };
      items.push(p); byId.set(id, p); added.push(id);
    }
  }
  if (file !== false) saveCorpus(items, file);
  return { added, merged };
}

// ---------- search: BM25 over tex+tags+context, unit overlap, status, recency ----------

const STOP = new Set("the a an of and or to in on for is are be by with as at that this it its from find each which what solve write show".split(" "));
export function tokenize(s) {
  return String(s || "").toLowerCase()
    .replace(/\\(frac|dfrac|sqrt|begin|end|cases|text|left|right|cdot|le|ge|leq|geq|item|probskip|quad|emph|textbf)\b/g, (m, w) => ({ frac: " fraction ", dfrac: " fraction ", sqrt: " root radical ", le: " inequality ", ge: " inequality ", leq: " inequality ", geq: " inequality ", cases: " system " }[w] || " "))
    .replace(/[<>]/g, " inequality ")
    .split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w))
    .map((w) => w.replace(/(ies)$/, "y").replace(/([^s])s$/, "$1"));
}

const daysAgo = (d, now) => (now - new Date(d).getTime()) / 864e5;
const STATUS_BOOST = { favorite: 1.5, candidate: 0.6, used: 0.2 };

// ---------- fuzzy matching helpers ----------

// Topic words the teacher uses -> words that appear in problems. Each expansion counts at 0.6 of an exact hit.
export const SYNONYMS = {
  exponent: ["power", "exponent", "law", "product", "quotient"], power: ["exponent"], polynomial: ["monomial", "binomial", "trinomial", "degree", "coefficient", "expand", "term"],
  arithmetic: ["expand", "simplify", "add", "subtract", "multiply"], parabola: ["focu", "directrix", "equidistant", "distance", "vertex"],
  function: ["domain", "input", "output", "value"], domain: ["function", "defined", "denominator"],
  inequality: ["halfplane", "inequality", "region", "shade"], halfplane: ["inequality", "region", "shade", "boundary"],
  system: ["system", "simultaneou", "intersection"], line: ["slope", "intercept", "point", "perpendicular", "parallel"],
  perpendicular: ["bisector", "slope", "altitude"], bisector: ["perpendicular", "midpoint", "circumcenter"],
  triangle: ["vertice", "median", "altitude", "centroid", "orthocenter", "circumcenter"], center: ["centroid", "orthocenter", "circumcenter"],
  square: ["completing", "root", "radical"], completing: ["square", "canonical"], quadratic: ["square", "factor", "root", "completing"],
  rational: ["fraction", "extraneou", "denominator"], extraneou: ["rational", "check"], radical: ["root", "sqrt"], root: ["radical", "solution"],
  factor: ["factoring", "difference", "trinomial"], distance: ["pythagorean", "midpoint", "length"], midpoint: ["distance", "bisector"],
};

const trigramsOf = (w) => { const s = ` ${w} `; const out = new Set(); for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3)); return out; };
const dice = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return (2 * n) / (a.size + b.size || 1); };
const jaccard = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n || 1); };

// Index tokens plus joined neighbours, so "half plane" also matches "halfplane".
const withCompounds = (toks) => { const out = [...toks]; for (let i = 0; i + 1 < toks.length; i++) out.push(toks[i] + toks[i + 1]); return out; };

// Structural signature of a problem's math: numbers -> #, single-letter variables -> v, commands and operators kept.
// Two problems with the same shape are the same exercise type with different data.
const MATH_RE = /\$\$([\s\S]*?)\$\$|\$([^$]*)\$|\\\[([\s\S]*?)\\\]|\\begin\{(cases|align\*?|aligned)\}([\s\S]*?)\\end\{\4\}/g;
export function shapeTokens(tex) {
  const math = [...String(tex || "").matchAll(MATH_RE)].map((m) => m[1] ?? m[2] ?? m[3] ?? `\\${m[4]} ${m[5]}`).join(" ; ");
  return math.replace(/\\(left|right|,|;|!|quad|qquad|displaystyle)\b/g, " ")
    .match(/\\[a-zA-Z]+|\d+(?:\.\d+)?|[A-Za-z]|[=<>+\-*/^_(){}\[\],;|]/g)?.map((t) => /^\d/.test(t) ? "#" : /^[A-Za-z]$/.test(t) ? "v" : t.replace(/^\\(dfrac|tfrac)$/, "\\frac").replace(/^\\(leq|le)$/, "≤").replace(/^\\(geq|ge)$/, "≥")) || [];
}
export function shapeOf(tex) {
  const t = shapeTokens(tex), out = new Set();
  for (let i = 0; i + 2 < t.length; i++) out.add(t.slice(i, i + 3).join(""));
  if (t.length && t.length < 3) out.add(t.join(""));
  return out;
}
export const shapeSim = (a, b) => jaccard(a instanceof Set ? a : shapeOf(a), b instanceof Set ? b : shapeOf(b));
const numbersOf = (tex) => (String(tex).match(/\d+(?:\.\d+)?/g) || []).sort().join(",");

// Same exercise, cosmetically different (renamed variable, reworded directions): same numbers, same shape, similar words.
export function isNearDuplicate(a, b) {
  if (numbersOf(a) !== numbersOf(b)) return false;
  if (shapeSim(a, b) < 0.9) return false;
  return jaccard(new Set(tokenize(a.replace(MATH_RE, " "))), new Set(tokenize(b.replace(MATH_RE, " ")))) >= 0.5;
}
export function nearDuplicates(items, tex) {
  const s = shapeOf(tex);
  return items.filter((p) => p.tex && shapeSim(s, shapeOf(p.tex)) >= 0.9 && isNearDuplicate(p.tex, tex));
}

export function searchCorpus(items, { units = [], query = "", wuNodes = [], similarTo = "", limit = 10, now = Date.now(), recentDays = 42, includeUsed = true } = {}) {
  units = asList(units).map((u) => u.toUpperCase());
  wuNodes = asList(wuNodes);
  const pool = items.filter((p) => p.status !== "rejected" && (includeUsed || p.status !== "used"));
  const docs = pool.map((p) => withCompounds(tokenize([p.tex, (p.tags || []).join(" "), p.context, p.answer].join(" "))));
  const N = docs.length || 1, avg = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  const df = new Map();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) || 0) + 1);

  // Query terms with weights: exact (1), keyword units' words, synonyms (0.6), and fuzzy vocabulary matches (dice x 0.8).
  const qWeights = new Map();
  const bump = (w, x) => { if (x > (qWeights.get(w) || 0)) qWeights.set(w, x); };
  const qToks = withCompounds(tokenize(query));
  const vocab = [...df.keys()].map((w) => [w, trigramsOf(w)]);
  for (const w of qToks) {
    bump(w, 1);
    for (const s of SYNONYMS[w] || []) bump(s, 0.6);
    if (!df.has(w) && w.length >= 5) {
      const g = trigramsOf(w);
      for (const [v, vg] of vocab) { const d = dice(g, vg); if (d >= 0.7 && v !== w) bump(v, 0.8 * d); }
    }
  }
  const unitsFromQuery = queryUnits(query);
  const shape = similarTo ? shapeOf(similarTo) : null;
  const k1 = 1.2, b = 0.75;
  const scored = pool.map((p, i) => {
    const d = docs[i]; const tf = new Map();
    for (const w of d) tf.set(w, (tf.get(w) || 0) + 1);
    let bm = 0, exact = 0;
    for (const [w, wt] of qWeights) {
      const f = tf.get(w); if (!f) continue;
      const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5));
      bm += wt * idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / avg));
      if (wt === 1) exact++;
    }
    const unitHits = units.filter((u) => p.units.includes(u)).length;
    const inferredHits = unitsFromQuery.filter((u) => !units.includes(u) && p.units.includes(u)).length;
    const nodeHits = wuNodes.filter((n) => (p.wuNodes || []).includes(n)).length;
    const sim = shape ? shapeSim(shape, shapeOf(p.tex)) : 0;
    const lastUsed = (p.usedOn || []).at(-1);
    const recent = lastUsed && daysAgo(lastUsed, now) < recentDays;
    let score = bm + 2.5 * unitHits + 1.0 * inferredHits + 1.5 * nodeHits + 6 * sim + (STATUS_BOOST[p.status] || 0);
    if (recent) score -= 4; // used in the last ~6 weeks: avoid repeating; older uses are fine as review
    return { p, score, why: { bm: +bm.toFixed(2), exact, unitHits: unitHits + inferredHits, nodeHits, shape: +sim.toFixed(2), recent: !!recent } };
  }).filter((x) => (qWeights.size || units.length || wuNodes.length || shape) ? x.why.bm > 0 || x.why.unitHits || x.why.nodeHits || x.why.shape >= 0.3 : true);
  scored.sort((a, b) => b.score - a.score || a.p.id.localeCompare(b.p.id));
  return scored.slice(0, limit);
}

// Units a free-text topic points at, from the ladder keywords ("systems of inequalities" -> U14).
export function queryUnits(query) {
  const t = String(query || "").toLowerCase();
  return Object.entries(UNIT_KEYWORDS).filter(([, ks]) => ks.some((k) => k.length > 3 && !k.startsWith("\\") && t.includes(k))).map(([u]) => u);
}

// For each planned section, does the corpus already hold enough usable problems?
//   sections: [{key, title, query, units, target}]   allowed: unit ids that are TAUGHT or CURRENT
//   -> [{key, verdict: covered|thin|empty, usable, target, ids}]
export function coverage(items, sections, { allowed = null, now = Date.now(), recentDays = 42 } = {}) {
  const ok = allowed && new Set(allowed);
  return sections.map((s) => {
    const hits = searchCorpus(items, { units: s.units, query: s.query || s.title, limit: Math.max(30, (s.target || 6) * 4), now, recentDays });
    const usable = hits.filter((h) => !h.why.recent && h.why.unitHits > 0 && (!ok || h.p.units.every((u) => ok.has(u))) && (h.why.exact > 0 || h.why.unitHits > 0));
    const target = s.target || 6;
    const verdict = usable.length >= target ? "covered" : usable.length >= Math.ceil(target / 2) ? "thin" : "empty";
    return { key: s.key, title: s.title, units: s.units, verdict, usable: usable.length, target, ids: usable.slice(0, target * 2).map((h) => h.p.id) };
  });
}

// Compact text for Claude (tool results and the start-prompt preload).
export function formatHits(hits) {
  if (!hits.length) return "(no matching problems in the corpus)";
  return hits.map(({ p, why }) => {
    const used = p.usedOn?.length ? `used ${p.usedOn.join(", ")}${why.recent ? " (recent: adapt, don't reuse)" : ""}` : "unused";
    const src = p.source?.file || p.source?.url || p.source?.kind;
    return `- [${p.id}] ${p.units.join(",") || "no unit"} · ${p.status}${p.status === "favorite" ? " ★" : ""}${p.casVerified ? " · cas ✓" : ""} · ${used} · ${src}${p.context ? ` · ${p.context}` : ""}\n  ${p.tex.replace(/\s*\n\s*/g, " ").slice(0, 400)}${p.answer ? `\n  answer: ${p.answer.slice(0, 200)}` : ""}`;
  }).join("\n");
}

export function patchProblem(items, id, patch, { file } = {}) {
  const p = items.find((x) => x.id === id);
  if (!p) return null;
  if ("answer" in patch && !sameAnswer(p.answer, patch.answer)) p.casVerified = false; // the check was for the old answer
  for (const k of ["status", "units", "tags", "wuNodes", "answer"]) if (k in patch) p[k] = patch[k];
  if (file !== false) saveCorpus(items, file);
  return p;
}

// ---------- gold-file splitter ----------

// Split a homework .tex into top-level problems: each \item of the outermost enumerate,
// with nested enumerates kept inside their parent. Context = the section heading.
export function splitTex(tex) {
  const body = (tex.split("\\begin{document}")[1] || tex).split("\\end{document}")[0].replace(/(^|[^\\])%.*$/gm, "$1");
  const out = [];
  const re = /\\(?:sub)*section\*?\{([^}]*)\}|\\textbf\{Directions:?\}:?([^\n]*)|\\begin\{enumerate\}(?:\[[^\]]*\])?|\\end\{enumerate\}|\\item\b(?:\[[^\]]*\])?/g;
  let m, depth = 0, heading = "", cur = null;
  const flush = (end) => {
    if (cur) {
      const t = body.slice(cur.start, end).replace(/\\probskip|\\vspace\*?\{[^}]*\}|\\newpage|\\columnbreak/g, "").trim();
      if (t) out.push({ tex: t, context: cur.heading });
    }
    cur = null;
  };
  while ((m = re.exec(body))) {
    const s = m[0];
    if (s.startsWith("\\begin{enumerate")) depth++;
    else if (s.startsWith("\\end{enumerate")) { if (depth === 1) flush(m.index); depth = Math.max(0, depth - 1); }
    else if (s.startsWith("\\item")) { if (depth === 1) { flush(m.index); cur = { start: m.index + s.length, heading }; } }
    else if (depth === 0 && m[1] !== undefined) heading = m[1].trim();
    else if (depth === 0 && m[2] !== undefined) heading = heading.split(" — ")[0] + " — " + m[2].replace(/\\[a-z]+\{([^}]*)\}/g, "$1").replace(/[{}\\]/g, "").trim().split(/(?<=\.)\s/)[0];
  }
  flush(body.length);
  return out;
}

// Keyword unit tagging from the ladder names (fallback when the Claude tagging pass is unavailable).
const UNIT_KEYWORDS = {
  U01: ["complex fraction", "pattern", "expand", "true or false", "true/false"], U02: ["linear equation", "solve for", "indicated variable"],
  U03: ["factor", "difference of squares", "canonical form"], U04: ["square root", "\\sqrt", "simplify"], U05: ["completing the square", "complete the square", "quadratic", "x^2"],
  U06: ["rational equation", "extraneous"], U07: ["ordered pair", "plot", "coordinate"], U08: ["slope", "point-slope", "y-intercept", "line"],
  U09: ["system", "\\begin{cases}", "number of solutions"], U10: ["x-intercept", "standard form", "perpendicular", "parallel", "elimination"],
  U11: ["midpoint", "distance", "pythagorean", "orthocenter", "centroid", "circumcenter", "median", "altitude", "bisector"],
  U12: ["inequality", "compound"], U13: ["half-plane", "halfplane", "graph the inequality", "shade"], U14: ["system of inequalities", "systems of linear inequalities", "solution set of the system", "region"],
  U15: ["parabola", "focus", "directrix", "equidistant"], U16: ["vertex form", "transformation"], U17: ["quadratic formula", "discriminant", "vieta"],
  U18: ["complex number", "imaginary"], U19: ["exponent", "polynomial", "monomial", "degree of", "power"], U20: ["synthetic", "remainder theorem", "factor theorem", "polynomial division"],
  U21: ["function", "domain", "f(x)", "f(", "g("], M1: ["absolute value", "|x"], M2: ["quadratic inequalit"], M3: ["radical equation"], M4: ["line and parabola", "line-parabola"],
};
export function keywordUnits(tex) {
  const t = String(tex).toLowerCase();
  const hits = new Set(Object.entries(UNIT_KEYWORDS).filter(([, ks]) => ks.some((k) => t.includes(k))).map(([u]) => u));
  const ineq = /\\(le|ge|leq|geq)\b|[<>]/.test(t);
  if (ineq) hits.add("U12");
  if (ineq && t.includes("\\begin{cases}")) { hits.add("U14"); hits.delete("U09"); }
  return [...hits].sort();
}

// "hw_10_21_2026.tex" -> "2026-10-21"
export function dateFromName(name) {
  const m = String(name).match(/(\d{1,2})_(\d{1,2})_(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

// The manifest carries metadata only; each problem's LaTeX comes from the saved .tex, matched in \item order
// (or by part/n when the counts differ). Older manifests that still include "tex" keep it.
export function attachTex(list, tex) {
  const items = splitTex(tex || "");
  const parts = [...new Set(items.map((x) => x.context.split(" — ")[0]))];
  const byPartN = (p) => items.filter((x) => parts.indexOf(x.context.split(" — ")[0]) + 1 === Number(p.part))[Number(p.n) - 1];
  return list.map((p, i) => p.tex ? p : { ...p, tex: (items.length === list.length ? items[i] : byPartN(p))?.tex }).filter((p) => p.tex);
}
