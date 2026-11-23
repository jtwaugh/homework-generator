// "Ask about the corpus": a short, read-only conversation with Claude over the problem corpus. The whole corpus
// goes into the system prompt (cached, so later questions read it cheaply); once that would be too big, only a
// one-line index goes in and Claude reads problems through corpus_search. The browser keeps the history (text only).

export const CHAT_MODEL = process.env.HW_CORPUS_CHAT_MODEL || "claude-sonnet-5-5";
const FULL_LIMIT = 180000; // chars of listing before falling back to the index

const oneLine = (s, n) => { const t = String(s || "").replace(/\s*\n\s*/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
const host = (u) => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return u; } };

function head(p) {
  const src = p.source || {};
  const used = p.usedOn?.length ? `used ${p.usedOn.join(",")}` : "unused";
  return `[${p.id}] ${(p.units || []).join(",") || "no unit"} · ${p.status || "candidate"} · ${used} · ${src.kind || "?"}${src.file ? ` ${src.file}` : src.url ? ` ${host(src.url)}` : ""}${src.date ? ` ${src.date}` : ""}${p.casVerified ? " · cas ✓" : ""} · added ${String(p.addedAt || "").slice(0, 10)}`;
}

export function corpusListing(items, limit = FULL_LIMIT) {
  const full = items.map((p) => `${head(p)}${p.tags?.length ? ` · tags: ${p.tags.join(", ")}` : ""}${p.context ? `\n  context: ${oneLine(p.context, 160)}` : ""}\n  ${oneLine(p.tex, 600)}${p.answer ? `\n  answer: ${oneLine(p.answer, 200)}` : ""}`).join("\n");
  if (full.length <= limit) return { text: full, full: true };
  return { text: items.map((p) => `${head(p)} · ${oneLine(p.tex, 80)}`).join("\n"), full: false };
}

export function corpusStats(items) {
  const count = (f) => { const o = {}; for (const p of items) for (const k of [].concat(f(p))) o[k] = (o[k] || 0) + 1; return o; };
  const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
  return [
    `${items.length} problems.`,
    `By status: ${fmt(count((p) => p.status || "candidate"))}.`,
    `By source: ${fmt(count((p) => p.source?.kind || "?"))}.`,
    `By unit: ${fmt(count((p) => (p.units?.length ? p.units : ["none"])))}.`,
  ].join("\n");
}

export function unitNames(ladderMd = "") {
  return [...ladderMd.matchAll(/^-\s+(U\d\d|M\d|F\d)\s+([^.]+)\./gm)].map((m) => `${m[1]} ${m[2].trim()}`).join("; ");
}

export function corpusChatSystem(items, ladderMd = "", today = new Date().toISOString().slice(0, 10)) {
  const L = corpusListing(items);
  return [
    "You answer a math teacher's questions about their problem corpus: the problems an app reuses when it writes weekly algebra homework for one student. You can read the corpus; you can't change it. The teacher stars (★ favorite) or rejects (✕) problems in the table next to this chat.",
    "",
    "Fields: id; units (the course's unit ids); status (candidate: never assigned; used: assigned in a past set; favorite: offered first; rejected: never offered); used dates; source (gold: the teacher's own sets; final: sets the app wrote; web: found online; claude/teacher: added by Claude or the teacher); cas ✓ means the answer was checked with sympy; tags; context (the section heading it came from).",
    "",
    "How to answer:",
    "- Be brief and concrete. Count exactly from the listing; don't estimate.",
    "- Cite problems by id in square brackets, e.g. [p2f7ada3a36]. The app turns each id into a link that shows the problem in the table, and offers to show every cited problem at once, so cite every problem you mean (all of them, when the teacher asks for a list) and don't copy their text unless asked.",
    "- Math in $...$, plain Markdown otherwise. No tables.",
    L.full ? "- The full corpus is below. Use corpus_search only to find problems of the same type as one the teacher pastes (similarTo)." : "- Only an index is below (the corpus is large): use corpus_search to read problems' text and answers.",
    "",
    `Today is ${today}.`,
    unitNames(ladderMd) ? `Units: ${unitNames(ladderMd)}` : "",
    "",
    "## Summary",
    corpusStats(items),
    "",
    `## The corpus${L.full ? "" : " (index)"}`,
    L.text,
  ].join("\n");
}

// Ids Claude cited that exist (aliases resolve to the problem they merged into), in order of first mention.
export function citedIds(text, items) {
  const byId = new Map();
  for (const p of items) { byId.set(p.id, p.id); for (const a of p.aliases || []) byId.set(a, p.id); }
  return [...new Set([...String(text).matchAll(/\bp[0-9a-f]{10}\b/g)].map((m) => byId.get(m[0])).filter(Boolean))];
}
