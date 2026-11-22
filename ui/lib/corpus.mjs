// Problem corpus: ui/data/corpus/problems.jsonl, one problem per line.
// Shared by the server, the MCP tool server, the seed script and the tests. No dependencies.
//
//   {id, tex, answer, units:[U14], wuNodes:[e57, m:e5], tags:[], context,
//    source:{kind: gold|final|web|teacher, file?, url?, date?, note?},
//    status: candidate|used|favorite|rejected, usedOn:[YYYY-MM-DD], casVerified, addedAt}
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const DATA = process.env.HW_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
export const CORPUS_FILE = () => path.join(DATA, "corpus", "problems.jsonl");

// ---------- storage ----------

export function loadCorpus(file = CORPUS_FILE()) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}
export function saveCorpus(items, file = CORPUS_FILE()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, items.map((p) => JSON.stringify(p)).join("\n") + (items.length ? "\n" : ""));
  fs.renameSync(tmp, file);
}

// Same problem = same TeX after whitespace and spacing-command normalization.
export const normTex = (t) => String(t || "").replace(/\\(probskip|vspace\{[^}]*\}|\\|,|;|quad|qquad)/g, " ").replace(/\s+/g, "").toLowerCase();
export const problemId = (tex) => "p" + createHash("sha256").update(normTex(tex)).digest("hex").slice(0, 10);

const asList = (x) => (Array.isArray(x) ? x : x ? String(x).split(/[,;]\s*/) : []).map((s) => String(s).trim()).filter(Boolean);

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
    const old = byId.get(id);
    if (old) {
      // merge: never downgrade status, union tags, keep the earliest source
      old.units = [...new Set([...old.units, ...units])];
      old.wuNodes = [...new Set([...(old.wuNodes || []), ...wuNodes])];
      old.tags = [...new Set([...old.tags, ...tags])];
      if (!old.answer && raw.answer) old.answer = String(raw.answer);
      if (raw.casVerified) old.casVerified = true;
      if (raw.status === "used" && old.status === "candidate") old.status = "used";
      if (raw.usedOn) old.usedOn = [...new Set([...(old.usedOn || []), ...asList(raw.usedOn)])].sort();
      merged.push(id);
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

export function searchCorpus(items, { units = [], query = "", wuNodes = [], limit = 10, now = Date.now(), recentDays = 42, includeUsed = true } = {}) {
  units = asList(units).map((u) => u.toUpperCase());
  wuNodes = asList(wuNodes);
  const pool = items.filter((p) => p.status !== "rejected" && (includeUsed || p.status !== "used"));
  const docs = pool.map((p) => tokenize([p.tex, p.tags.join(" "), p.context, p.answer].join(" ")));
  const N = docs.length || 1, avg = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  const df = new Map();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) || 0) + 1);
  const q = [...new Set(tokenize(query))];
  const k1 = 1.2, b = 0.75;
  const scored = pool.map((p, i) => {
    const d = docs[i]; const tf = new Map();
    for (const w of d) tf.set(w, (tf.get(w) || 0) + 1);
    let bm = 0;
    for (const w of q) {
      const f = tf.get(w); if (!f) continue;
      const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5));
      bm += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / avg));
    }
    const unitHits = units.filter((u) => p.units.includes(u)).length;
    const nodeHits = wuNodes.filter((n) => (p.wuNodes || []).includes(n)).length;
    const lastUsed = (p.usedOn || []).at(-1);
    const recent = lastUsed && daysAgo(lastUsed, now) < recentDays;
    let score = bm + 2.5 * unitHits + 1.5 * nodeHits + (STATUS_BOOST[p.status] || 0);
    if (recent) score -= 4; // used in the last ~6 weeks: avoid repeating; older uses are fine as review
    return { p, score, why: { bm: +bm.toFixed(2), unitHits, nodeHits, recent: !!recent } };
  }).filter((x) => (q.length || units.length || wuNodes.length) ? x.why.bm > 0 || x.why.unitHits || x.why.nodeHits : true);
  scored.sort((a, b) => b.score - a.score || a.p.id.localeCompare(b.p.id));
  return scored.slice(0, limit);
}

// Compact text for Claude (tool results and the start-prompt preload).
export function formatHits(hits) {
  if (!hits.length) return "(no matching problems in the corpus)";
  return hits.map(({ p, why }) => {
    const used = p.usedOn?.length ? `used ${p.usedOn.join(", ")}${why.recent ? " (recent: adapt, don't reuse)" : ""}` : "unused";
    const src = p.source?.file || p.source?.url || p.source?.kind;
    return `- [${p.id}] ${p.units.join(",") || "no unit"} · ${p.status}${p.status === "favorite" ? " ★" : ""} · ${used} · ${src}${p.context ? ` · ${p.context}` : ""}\n  ${p.tex.replace(/\s*\n\s*/g, " ").slice(0, 400)}${p.answer ? `\n  answer: ${p.answer.slice(0, 200)}` : ""}`;
  }).join("\n");
}

export function patchProblem(items, id, patch, { file } = {}) {
  const p = items.find((x) => x.id === id);
  if (!p) return null;
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
  U12: ["inequality", "compound"], U13: ["half-plane", "halfplane", "graph the inequality", "shade"], U14: ["system of inequalities", "solution set of the system", "region"],
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
