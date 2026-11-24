// Deterministic preflight: everything the app can settle from its own data before any LLM call.
// Builds the week's "brief": every input with defaults filled in, unit statuses (with automatic promotions
// instead of questions), the standing conventions, review priority and recent history, a section plan, and
// per-section corpus coverage (which sections need research). Claude gets the brief, never the status file.
// No dependencies; shared by the server and the tests.
import { searchCorpus, coverage, tokenize, queryUnits } from "./corpus.mjs";
import { parseTopics } from "../public/topics.js";
import { sectionItems, statusLine } from "../public/statusmd.js";

const UNIT_ID = /\b(U\d\d|M\d|F\d)\b/g;

export function ladderUnits(ladder) {
  return [...ladder.matchAll(/^-\s+(U\d\d|M\d|F\d)\s+([^.]+)\.(.*)$/gm)].map((m) => ({
    id: m[1], name: m[2].trim(), needs: (m[3].match(/Needs ([^.]*)\./)?.[1].match(UNIT_ID)) || [],
  }));
}
export function statusSection(md, heading) {
  const i = md.toLowerCase().indexOf(heading.toLowerCase());
  if (i < 0) return "";
  const rest = md.slice(i + heading.length);
  const j = rest.search(/\n##\s/);
  return j < 0 ? rest : rest.slice(0, j);
}
// keepLines: multi-line values (a pasted fact sheet) keep their line breaks instead of being joined.
export function weekInput(status, { keepLines = false } = {}) {
  const sec = statusSection(status, "## This week's input");
  const out = {};
  for (const m of sec.matchAll(/^([A-Z][^:\n]{1,60}):[ \t]*(.*(?:\n {2,}.*)*)$/gm)) out[m[1].trim()] = m[2].replace(/\n {2}/g, keepLines ? "\n" : " ").replace(/\s+/g, (w) => (keepLines && w.includes("\n") ? w : " ")).trim();
  return out;
}
// "TAUGHT: U01, U02 (note)" -> { U01: "TAUGHT", ... }. Phrases like "rest of U11" mark that unit partial.
export function unitStatuses(status) {
  const st = {}, partial = new Set();
  for (const s of ["TAUGHT", "CURRENT", "NEXT"]) {
    const line = status.match(new RegExp(`^${s}:(.*)$`, "m"))?.[1] || "";
    for (const id of line.match(UNIT_ID) || []) { if (!st[id]) st[id] = s; }
    for (const m of line.matchAll(/rest of (U\d\d|M\d|F\d)/g)) partial.add(m[1]);
  }
  return { st, partial: [...partial] };
}
const reviewItems = (status) => statusSection(status, "## Review priority").split("\n").filter((l) => /^\s*(\d+[.)]|[-*])\s/.test(l))
  .map((l) => l.replace(/^\s*(\d+[.)]|[-*])\s+/, "").replace(/\(.*$/, "").trim()).filter(Boolean);

// The section plan's default sizes (project_instructions.md: routine ~15, idea-building 4-8).
const ROUTINE = /arithmetic|drill|practice|simplify|expand|factor|solve|exponent law|basic/i;

// The teacher's Progress-map comments that bear on this week: those on a unit in play (allowed, or in a section),
// and those on a block one of those units covers. focus: the unit is in a section (this week's topics or review).
export function briefComments(comments = [], { allowed, sections, byId = {} }) {
  const inSec = new Set(sections.flatMap((s) => s.units));
  const inPlay = (u) => allowed.has(u) || inSec.has(u);
  const out = [];
  for (const c of comments) {
    if (!c.texts?.length) continue;
    const units = c.layer === "unit" ? (inPlay(c.key) ? [c.key] : []) : c.via.filter(inPlay);
    if (!units.length) continue;
    out.push({ key: c.key, layer: c.layer, title: c.layer === "unit" ? byId[c.key]?.name || c.title : c.title, units, texts: c.texts, focus: units.some((u) => inSec.has(u)) });
  }
  const ord = (k) => { const i = Object.keys(byId).indexOf(k); return i < 0 ? 1e9 : i; };
  return out.sort((a, b) => b.focus - a.focus || ord(a.units[0]) - ord(b.units[0]) || (a.layer === "unit" ? 0 : 1) - (b.layer === "unit" ? 0 : 1));
}

// The progress-map blocks of the units in play, with the student's state on each, for the brief.
//   covers {U14: [keys]}, nodes Map key -> {layer, title}, progress {key: {state, confidence, source}} (teacher wins),
//   units: the units in play, in ladder order.
export function mapBlocks({ covers = {}, nodes, progress = {}, units = [] }) {
  const out = [], seen = new Set();
  for (const u of units) for (const k of covers[u] || []) {
    const n = nodes.get(k);
    if (!n || n.layer === "unit" || seen.has(k)) continue;
    seen.add(k);
    const p = progress[k];
    out.push({ key: k, layer: n.layer, title: n.title, unit: u, state: p?.state || null, confidence: p?.confidence ?? null, teacher: p?.source === "teacher" });
  }
  return out;
}
const STATE_WORD = { done: "done", partial: "partial", "not-yet": "NOT YET" };
export function mapLines(blocks = []) {
  if (!blocks.length) return [];
  const st = (b) => !b.state ? "no evidence" : `${STATE_WORD[b.state]}${b.teacher ? " (teacher)" : b.confidence != null ? ` (guess, ${Math.round(b.confidence * 100)}%)` : ""}`;
  return ["", "## Progress map: the blocks of the units in play, and where the student is on each (key · block · state)",
    ...blocks.map((b) => `- ${b.key} · ${b.layer === "methods" ? "method" : "fact"}: ${b.title} [${b.unit}] · ${st(b)}`)];
}

export function buildBrief({ status, ladder, corpus, comments = [], overrides = {}, now = Date.now() }) {
  const units = ladderUnits(ladder);
  const byId = Object.fromEntries(units.map((u) => [u.id, u]));
  const input = weekInput(status);
  const { st, partial } = unitStatuses(status);
  const decisions = []; // each: {key, text, default, accepted}

  // Inputs, with defaults instead of questions.
  const date = input["Date (for title)"] || "";
  const disclaimer = /^y/i.test(input["Disclaimer"] || "") ? "yes" : "no";
  if (!input["Disclaimer"]) decisions.push({ key: "disclaimer", text: "Disclaimer is blank: no disclaimer line.", default: "no" });
  const graphPaper = /^y/i.test(input["Graph paper"] || "");
  const graphPaperMode = graphPaper ? "yes" : /^n/i.test(input["Graph paper"] || "") ? "no" : "auto";
  const on = (v) => !!v && !/^(no|none|auto)$/i.test(v.trim());
  const answerKey = on(input["Answer key"]);
  const unitCircle = on(input["Unit circle sheet"]);
  const we = (input["Worked examples"] || "").trim();
  const workedExamples = !on(we) ? 0 : Number(we.match(/^\d+$/)?.[0]) || "auto";
  // Topics -> units. Unit ids in chips win; else the ladder name / keywords.
  const topicChips = parseTopics(input["Topics"] || "").map((c) => {
    const ids = [...new Set([...(c.id && /^(U|M|F)/.test(c.id) ? [c.id] : []), ...((c.text.match(UNIT_ID)) || [])])];
    if (!ids.length) {
      const toks = new Set(tokenize(c.text));
      const byName = units.filter((u) => { const w = tokenize(u.name); return w.length && w.filter((x) => toks.has(x)).length >= Math.min(2, w.length); }).map((u) => u.id);
      ids.push(...(byName.length ? byName : queryUnits(c.text)));
    }
    return { text: c.text.replace(/\s*\((U\d\d|M\d|F\d)\)\s*$/, "").trim(), units: ids };
  });

  // Units this week needs that aren't TAUGHT/CURRENT: promote them by default (the teacher put them in Topics).
  const allowed = new Set(Object.entries(st).filter(([, s]) => s === "TAUGHT" || s === "CURRENT").map(([id]) => id));
  const promotions = [];
  for (const c of topicChips) for (const id of c.units) {
    if (allowed.has(id) || promotions.some((p) => p.id === id)) continue;
    const from = st[id] || "FUTURE";
    const missing = (byId[id]?.needs || []).filter((n) => !allowed.has(n) && !promotions.some((p) => p.id === n));
    const key = `promote:${id}`;
    const accept = overrides[key] !== false;
    promotions.push({ id, from, missingNeeds: missing, accepted: accept });
    decisions.push({ key, text: `${id} ${byId[id]?.name || ""} is ${from}; treat it as CURRENT this week${missing.length ? ` (its prerequisites ${missing.join(", ")} are not marked taught; stay within what the topic needs)` : ""}.`, default: true, accepted: accept });
    if (accept) allowed.add(id);
  }
  for (const id of partial) if (topicChips.some((c) => c.units.includes(id))) decisions.push({ key: `partial:${id}`, text: `${id} is only partly taught; use only the parts already covered.`, default: true });

  // Section plan.
  const nSections = Number((input["Number of sections (default 3-4)"] || input["Number of sections"] || "").match(/\d+/)?.[0]) || null;
  const review = reviewItems(status);
  const topicSecs = topicChips.filter((c) => !c.units.length || c.units.some((u) => allowed.has(u)));
  const dropped = topicChips.filter((c) => !topicSecs.includes(c));
  for (const c of dropped) decisions.push({ key: `drop:${c.text}`, text: `Skipping topic "${c.text}" (its unit is not promoted).`, default: true });
  const sections = topicSecs.map((c, i) => ({ key: `t${i + 1}`, title: c.text, query: c.text, units: c.units, kind: ROUTINE.test(c.text) && i === 0 ? "routine" : "idea", target: ROUTINE.test(c.text) && i === 0 ? 15 : 6 }));
  const maxSecs = nSections || 4;
  if (sections.length < maxSecs && review.length) sections.push({ key: "review", title: "Mixed review", query: review.join(" "), units: [...new Set(review.flatMap((r) => queryUnits(r)))].filter((u) => st[u] === "TAUGHT" || (st[u] === "CURRENT" && !promotions.some((p) => p.id === u))), kind: "review", target: Math.min(6, review.length * 2), review });
  if (sections.length > maxSecs) decisions.push({ key: "sections", text: `${sections.length} topics for ${maxSecs} sections: the lowest-priority topics merge or move to optional review.`, default: true });

  // Coverage: which sections the corpus can fill without research.
  const cov = coverage(corpus, sections, { allowed: [...allowed], now });
  sections.forEach((s, i) => Object.assign(s, { coverage: cov[i].verdict, usable: cov[i].usable, corpusIds: cov[i].ids }));

  const required = date ? [] : ["date"];
  const raw = weekInput(status, { keepLines: true });
  const items = (h) => sectionItems(status, h).filter((l) => !/^\(?\s*none( yet)?\s*\)?$/i.test(l));
  return {
    date, disclaimer, graphPaper, graphPaperMode, answerKey, unitCircle, workedExamples, nSections, required,
    topics: topicChips.map((c) => c.text),
    ideas: raw["Example problem ideas (optional)"] || raw["Example problem ideas"] || "",
    emphasis: raw["Emphasize or avoid"] || "",
    aux: raw["Fact sheet or other auxiliary file"] || "",
    statusLines: Object.fromEntries(["TAUGHT", "CURRENT", "NEXT"].map((s) => [s, statusLine(status, s)])),
    allowedUnits: [...allowed].sort(), promotions, decisions,
    review: items("## Review priority"),
    softDefaults: items("## Defaults for this week"),
    extraBans: items("## Extra bans this week"),
    conventions: items("## Standing conventions"),
    history: items("## Recent history").slice(-HISTORY_LINES),
    sections, needsResearch: sections.filter((s) => s.coverage !== "covered").map((s) => s.key),
    comments: briefComments(comments, { allowed, sections, byId }),
  };
}
const HISTORY_LINES = 6;

// The brief as the text Claude gets (start of the outline stage). It is the whole of the week's input: the app's
// own record of the student's status, rendered, so nothing here needs to be reconciled with anything else.
export function briefText(b) {
  const yn = (v) => (v ? "yes" : "no");
  const none = (s) => (s && !/^none$/i.test(s.trim()) ? s : "");
  const list = (xs, numbered = false) => xs.map((x, i) => `${numbered ? `${i + 1}.` : "-"} ${x}`);
  const lines = [
    "## This week's input",
    `- Date for the title: ${b.date || "(missing)"}`,
    `- Topics: ${b.topics.length ? b.topics.join("; ") : "(none given: choose from the CURRENT units)"}`,
    `- Number of sections: ${b.nSections || "3 to 4 (default)"}`,
    `- Disclaimer: ${b.disclaimer} · Graph paper: ${b.graphPaperMode}${b.graphPaperMode === "auto" ? " (only if the set is graphing-adjacent)" : ""} · Answer key: ${yn(b.answerKey)} · Unit circle sheet: ${yn(b.unitCircle)} · Worked examples: ${!b.workedExamples ? "no" : b.workedExamples === "auto" ? "yes (you choose how many)" : b.workedExamples}`,
    b.ideas ? `- Example problem ideas: ${b.ideas}` : "",
    b.emphasis ? `- Emphasize or avoid: ${b.emphasis}` : "",
    none(b.aux) ? `- Fact sheet or other auxiliary file:\n\n${b.aux}\n` : "- Fact sheet or other auxiliary file: none",
    "", "## Unit statuses",
    ...["TAUGHT", "CURRENT", "NEXT"].map((s) => `${s}: ${b.statusLines?.[s] || "(none)"}`),
    "FUTURE: everything else in curriculum_ladder.md",
    `Allowed units this week (TAUGHT or CURRENT, after promotions): ${b.allowedUnits.join(", ")}`,
    ...(b.review.length ? ["", "## Review priority (the mixed-review section draws from these first, in order)", ...list(b.review, true)] : []),
    ...(b.softDefaults.length ? ["", "## Soft defaults for this week", ...list(b.softDefaults)] : []),
    ...(b.extraBans.length ? ["", "## Extra bans this week", ...list(b.extraBans)] : []),
    ...commentLines(b.comments),
    ...mapLines(b.map),
    ...(b.conventions.length ? ["", "## Standing conventions (the teacher's rulings from earlier weeks; follow them)", ...list(b.conventions)] : []),
    ...(b.history.length ? ["", "## Recent sets (oldest first)", ...list(b.history)] : []),
    "", "## Decisions already made (do not ask about these; list them under Assumptions)",
    ...b.decisions.filter((d) => d.accepted !== false).map((d) => `- ${d.text}`),
    "", "## Section plan (corpus coverage decides where research is needed)",
    ...b.sections.map((s, i) => `${i + 1}. ${s.title} [${s.units.join(", ") || "no unit"}] ${s.kind}, about ${s.target} problems. Corpus: ${s.coverage} (${s.usable} usable${s.corpusIds.length ? ": " + s.corpusIds.slice(0, 12).join(", ") : ""})`),
  ];
  return lines.filter((l) => l !== "").join("\n").replace(/\n## /g, "\n\n## ");
}

// One line per comment, the unit (or block) first. A comment's own line breaks are kept, indented.
export function commentItem(c) {
  const where = c.layer === "unit" ? `${c.key} ${c.title}` : `${c.layer === "methods" ? "methods" : "content"} block "${c.title}" (covered by ${c.units.join(", ")})`;
  return c.texts.map((t) => `- ${where}${c.focus ? " [this week]" : ""}: ${t.replace(/\n+/g, "\n  ")}`);
}
export function commentLines(cs = []) {
  if (!cs.length) return [];
  return ["", "## The teacher's comments on units and blocks in play (from the progress map; instructions, follow every one)", ...cs.flatMap(commentItem)];
}

// The student's status for prompts other than the week's (the progress-map guess): statuses, review, history.
export function statusDigest(status) {
  const items = (h) => sectionItems(status, h).filter((l) => !/^\(?\s*none( yet)?\s*\)?$/i.test(l));
  return [
    ...["TAUGHT", "CURRENT", "NEXT"].map((s) => `${s}: ${statusLine(status, s) || "(none)"}`),
    ...(items("## Review priority").length ? ["", "Review priority:", ...items("## Review priority").map((x, i) => `${i + 1}. ${x}`)] : []),
    ...(items("## Recent history").length ? ["", "Recent sets:", ...items("## Recent history").map((x) => `- ${x}`)] : []),
  ].join("\n");
}
