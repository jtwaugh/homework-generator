#!/usr/bin/env node
// Unit tests for the logic the basic workflows depend on: corpus search/save, the .tex splitter, topic chips,
// the two DAG data files and the map's state logic.   node ui/scripts/test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchCorpus, splitTex, problemId, addProblems, attachTex, shapeSim, coverage, patchProblem, formatHits } from "../lib/corpus.mjs";
import { buildBrief, briefText } from "../lib/preflight.mjs";
import { decideAuth } from "../lib/auth.mjs";
import { hashPassword, verifyPassword, validHash, rateLimiter, parseCookies } from "../lib/login.mjs";
import { stageFor, modelFor, STAGES, appChecks } from "../server.mjs";
import { checksFrom, stripChecks, formatChecks, normChecks } from "../lib/check.mjs";
import { applyWeekUpdate, statusUpdateFrom, weekUpdateInputs, checkStatusUpload, promoteUnits } from "../public/statusmd.js";
import { parseTopics, serializeTopics, historyTopics } from "../public/topics.js";
import { computeStates, statusText, lessonPlan, planGraph, curvePath } from "../public/dag.js";
import { S, lintTex, nextSetDate } from "../public/lib.js";
import { parseTags } from "../lib/tagger.mjs";
import { openDb } from "../lib/db.mjs";
import * as Cur from "../lib/curriculum.mjs";
import * as Prog from "../lib/progress.mjs";
import { loadCorpusDb, recordAssignment } from "../lib/store.mjs";
import { parseLadder, renderLadder } from "../lib/lessonplan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "..", "data");
let pass = 0, fail = 0;
const test = (name, fn) => { try { fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.log("  ✗", name, "\n    ", e.message.split("\n").join("\n     ")); } };

const P = (tex, units, extra = {}) => ({ id: problemId(tex), tex, units, tags: [], status: "candidate", source: { kind: "gold" }, usedOn: [], ...extra });
const items = [
  P("Solve the system $x+y=5$, $x-y=1$.", ["U14"]),
  P("Graph $y \\ge 2x-1$.", ["U14"], { status: "favorite" }),
  P("Factor $x^2-5x+6$.", ["U14"], { status: "rejected" }),
];
test("corpus search: favorites first, rejected never returned", () => {
  const hits = searchCorpus(items, { units: ["U14"], limit: 10 });
  assert.equal(hits[0].p.status, "favorite");
  assert.ok(!hits.some((h) => h.p.status === "rejected"));
});
test("corpus save merges duplicates", () => {
  const a = addProblems(structuredClone(items), [{ tex: "Solve the system $x + y = 5$, $x - y = 1$.", units: ["U14"] }, { tex: "Brand new $y=3$", units: ["U01"] }], { file: false });
  assert.equal(a.added.length, 1); assert.equal(a.merged.length, 1);
});
test("CAS verification is cached per problem and answer", () => {
  const list = [];
  addProblems(list, [{ tex: "Solve $2x = 6$.", answer: "x = 3" }], { file: false });
  addProblems(list, [{ tex: "Solve $2x = 6$.", answer: "x=3", casVerified: true }], { file: false });
  assert.equal(list[0].casVerified, true, "same problem, same answer (modulo spaces) picks up the check");
  assert.match(formatHits([{ p: { ...list[0], units: [] }, why: {} }]), /cas ✓/);
  addProblems(list, [{ tex: "Solve $2x = 8$.", answer: "x = 4" }], { file: false });
  addProblems(list, [{ tex: "Solve $2x = 8$.", answer: "x = 5", casVerified: true }], { file: false });
  assert.equal(list[1].casVerified, false, "a check of a different answer doesn't carry over");
  patchProblem(list, list[0].id, { answer: "x = 4" }, { file: false });
  assert.equal(list[0].casVerified, false, "editing the answer drops the cached check");
});
test("splitTex finds the problems in a homework file", () => {
  const items = splitTex(fs.readFileSync(path.join(HERE, "fixtures", "hw_12_5_2026.tex"), "utf8"));
  assert.equal(items.length, 4);
  assert.match(items[2].context, /^Part 2: Expansion/);
});
test("manifest without problem text gets it from the .tex, in order", () => {
  const tex = "\\section*{A}\\begin{enumerate}\\item One $x$.\\item Two $y$.\\end{enumerate}\\section*{B}\\begin{enumerate}\\item Three.\\end{enumerate}";
  const out = attachTex([{ part: 1, n: 1, answer: "a" }, { part: 1, n: 2 }, { part: 2, n: 1 }], tex);
  assert.deepEqual(out.map((p) => p.tex.trim()), ["One $x$.", "Two $y$.", "Three."]);
  assert.equal(attachTex([{ part: 2, n: 1 }], tex)[0].tex.trim(), "Three.", "by part/n when counts differ");
});
test("tagger reply: content and methods ids stay apart (they reuse numbers), made-up ones dropped", () => {
  const ctx = { content: "e26 Square roots\ne41 Key Lemma", methods: "e41 Graph several inequalities\ne46 Complete the square" };
  const [t] = parseTags('Here: [{"i":0,"units":["U05"],"content":["e26","e99"],"methods":["e41","m:e46"],"tags":["Graphing"]}]', ctx);
  assert.deepEqual(t.wuNodes, ["e26", "m:e41", "m:e46"]); assert.deepEqual(t.tags, ["graphing"]);
});
test("quick set: next date is a week after the last saved set, never in the past", () => {
  const files = ["hw_11_21_2026.tex", "hw_11_28_2026.tex"];
  assert.equal(nextSetDate(files, "11/23/2026", new Date(2026, 10, 22)), "12/5/2026");
  assert.equal(nextSetDate(files, "12/9/2026", new Date(2026, 10, 22)), "12/9/2026", "a later typed date wins");
  assert.equal(nextSetDate(files, "", new Date(2026, 11, 20)), "12/26/2026");
});

test("lesson plan: every U unit in ladder order, grouped by section, with status and unmet needs", () => {
  const ladder = "## Ordered units\n- U01 Fractions. Patterns. Formal.\n- U02 Lines. Slope. Needs U01. Formal.\n## Middle block\n- M1 Absolute value. Needs U01. Formal.\n## Later units\n- U19 Polynomials. Needs U03. Informal for proofs.\n";
  const status = "TAUGHT: U01\nCURRENT: U19 (positive exponents only)\nNEXT: U02\nFUTURE: everything else";
  const g = lessonPlan(ladder, status);
  assert.deepEqual(g.map((x) => x.title), ["Ordered units", "Later units"], "sections without U units are dropped");
  assert.deepEqual(g.flatMap((x) => x.units.map((u) => [u.id, u.status])), [["U01", "TAUGHT"], ["U02", "NEXT"], ["U19", "CURRENT"]]);
  const u19 = g[1].units[0];
  assert.equal(u19.note, "positive exponents only"); assert.equal(u19.stance, "Informal for proofs"); assert.deepEqual(u19.missing, ["U03"]);
  assert.deepEqual(g[0].units[1].missing, [], "a unit not yet started flags nothing");
  assert.equal(g[0].units[0].about, "Patterns. Formal.");
});
test("lesson plan from the course's structured plan: sections in layout order, M units included, unplaced units last", () => {
  const plan = {
    layout: [{ heading: "Ordered units", items: [{ unit: "U01" }, { unit: "U02" }, { raw: "" }] }, { heading: "Middle block", items: [{ unit: "M1" }] }],
    units: [
      { key: "U01", name: "Fractions", about: "Patterns.", needs: [], stance: "Formal", notes: "" },
      { key: "U02", name: "Lines", about: "Slope.", needs: ["U01"], stance: "Formal", notes: "Say 'rate of change'." },
      { key: "M1", name: "Absolute value", about: "", needs: ["U02"], stance: "Formal", notes: "" },
      { key: "U03", name: "New unit", about: "", needs: [], stance: "", notes: "" },
    ],
  };
  const g = lessonPlan(plan, "TAUGHT: U01\nCURRENT: M1\nFUTURE: everything else");
  assert.deepEqual(g.map((x) => x.title), ["Ordered units", "Middle block", "Other units"]);
  assert.deepEqual(g.flatMap((x) => x.units.map((u) => [u.id, u.status])), [["U01", "TAUGHT"], ["U02", "FUTURE"], ["M1", "CURRENT"], ["U03", "FUTURE"]]);
  assert.deepEqual(g[1].units[0].missing, ["U02"]); assert.equal(g[0].units[1].guide, "Say 'rate of change'.");
});
test("lesson plan DAG: layers by longest chain of needs, implied needs flagged, long edges routed, ready units", () => {
  const mk = (key, needs) => ({ key, name: key, about: "", needs, stance: "", notes: "" });
  const plan = { layout: [{ heading: "Units", items: ["U01", "U02", "U03", "U04", "M1", "U05"].map((unit) => ({ unit })) }],
    units: [mk("U01", []), mk("U02", ["U01"]), mk("U03", ["U02"]), mk("U04", ["U01", "U03", "U99"]), mk("M1", ["U01"]), mk("U05", ["U04", "U05"])] };
  const g = planGraph(lessonPlan(plan, "TAUGHT: U01\nCURRENT: U02\nFUTURE: everything else"));
  const n = Object.fromEntries(g.nodes.map((x) => [x.id, x]));
  assert.deepEqual(["U01", "U02", "U03", "U04", "M1", "U05"].map((k) => n[k].layer), [0, 1, 2, 3, 1, 4], "unknown and self needs ignored");
  const e = (a, b) => g.edges.find((x) => x.from === a && x.to === b);
  assert.ok(e("U01", "U04").implied, "U01 is reached through U03"); assert.ok(!e("U03", "U04").implied);
  assert.equal(e("U01", "U04").pts, undefined, "implied edges are not routed");
  assert.equal(e("U01", "M1").pts.length, 2); assert.equal(e("U03", "U04").pts.length, 2);
  assert.ok(n.U03.ready, "needs only U02, which is current"); assert.ok(!n.U04.ready); assert.ok(!n.U01.ready, "taught units are not 'ready'");
  for (const x of g.nodes) for (const y of g.nodes) if (x !== y && x.layer === y.layer) assert.ok(x.x + x.w <= y.x || y.x + y.w <= x.x, `${x.id} overlaps ${y.id}`);
  assert.match(curvePath(e("U01", "M1").pts), /^M[\d.,-]+ C/);
  const cyc = planGraph(lessonPlan({ layout: [], units: [mk("U01", ["U02"]), mk("U02", ["U01"])] }, ""));
  assert.equal(cyc.nodes.length, 2, "a cycle does not hang the layout");
});
test("lesson plan DAG: a long edge passes through a dummy slot per skipped layer", () => {
  const mk = (key, needs) => ({ key, name: key, about: "", needs, stance: "", notes: "" });
  const g = planGraph(lessonPlan({ layout: [], units: [mk("U01", []), mk("U02", ["U01"]), mk("U03", ["U02"]), mk("U04", ["U03", "U02"]), mk("M1", ["U01", "U02"]), mk("M2", ["U01", "U03"])] }, ""));
  const e = g.edges.find((x) => x.from === "U01" && x.to === "M2");
  assert.ok(e.implied);
  const long = planGraph(lessonPlan({ layout: [], units: [mk("U01", []), mk("U02", ["U01"]), mk("U03", ["U02"]), mk("M1", ["U03"]), mk("M2", ["U01", "M1"]), mk("M3", ["U02"])] }, ""));
  const m3 = long.edges.find((x) => x.from === "U02" && x.to === "M3");
  assert.equal(m3.pts.length, 2, "adjacent layers: straight route");
  const u2m1 = planGraph(lessonPlan({ layout: [], units: [mk("U01", []), mk("U02", ["U01"]), mk("U03", ["U02"]), mk("M1", ["U03", "U09"]), mk("F1", ["U01"]), mk("M4", ["M1", "F1"])] }, ""));
  const f = u2m1.edges.find((x) => x.from === "F1" && x.to === "M4");
  assert.equal(f.pts.length, 2 + 2 * 2, "F1 (layer 1) to M4 (layer 4) passes two dummy slots");
});
test("topic chips round-trip through weekly_status text", () => {
  const chips = [{ text: "Systems of linear inequalities", id: "U14" }, { text: "harder line questions", id: null }, { text: "Substitution", id: "m:e12" }];
  assert.deepEqual(parseTopics(serializeTopics(chips)), chips);
});
test("recent-history topic suggestions keep no stray parentheses", () => {
  assert.deepEqual(historyTopics("- 11/14: line questions, mixed review (completing the square, linear inequalities)"),
    ["line questions", "mixed review", "completing the square", "linear inequalities"]);
});

test("final check: a unit's words are allowed once this week's status starts it", () => {
  Object.assign(S, { savedStatus: "TAUGHT: U07\nFUTURE: U21\n", gated: [{ term: "domain", unit: "U21" }] });
  const tex = "\\begin{document} Find the domain of $f$. \\end{document}";
  assert.ok(lintTex(tex).some(([, m]) => /gated term "domain"/.test(m)), "blocked before");
  assert.ok(!lintTex(tex, "TAUGHT: U07\nCURRENT: U21\n").some(([, m]) => /gated/.test(m)), "allowed after");
});

for (const file of ["wu_dag.json", "wu_methods_dag.json"]) {
  test(`${file}: edges join real nodes and there are no cycles`, () => {
    const dag = JSON.parse(fs.readFileSync(path.join(DATA, file), "utf8"));
    const ids = new Set(dag.nodes.map((n) => n.id)), out = {};
    assert.equal(ids.size, dag.nodes.length, "unique ids");
    for (const e of dag.edges) { assert.ok(ids.has(e.from) && ids.has(e.to), `${e.from}→${e.to}`); (out[e.from] ||= []).push(e.to); }
    const mark = {};
    const visit = (n) => { if (mark[n] === 2) return; assert.notEqual(mark[n], 1, "cycle through " + n); mark[n] = 1; (out[n] || []).forEach(visit); mark[n] = 2; };
    ids.forEach(visit);
  });
}
test("progress map: Claude's guess shows, your override wins", () => {
  const dag = { nodes: [{ id: "a", kind: "assumed" }, { id: "b", kind: "definition" }, { id: "c", kind: "theorem" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }] };
  const guess = { nodes: { a: { state: "done" }, b: { state: "partial" } } };
  const s = computeStates(dag, "content", guess, {});
  assert.equal(s.a.display, "done"); assert.equal(s.b.display, "partial"); assert.equal(s.c.display, "locked");
  const o = computeStates(dag, "content", guess, { b: { state: "done", at: "x" } });
  assert.equal(o.b.by, "you"); assert.equal(o.c.display, "ready");
});
test("progress map: node status explains what blocks a locked node", () => {
  const content = { nodes: [{ id: "a", kind: "definition", title: "A" }, { id: "b", kind: "theorem", title: "B" }], edges: [{ from: "a", to: "b" }] };
  const methods = { nodes: [{ id: "x", kind: "method", title: "X", restsOn: ["b"] }], edges: [] };
  const guess = { nodes: { a: { state: "partial" } } };
  const b = statusText(content, "content", "b", guess, {}, content);
  assert.equal(b.display, "locked"); assert.deepEqual(b.missing, [{ key: "a", title: "A" }]);
  const x = statusText(methods, "methods", "x", guess, {}, content);
  assert.equal(x.display, "locked"); assert.deepEqual(x.missing, [{ key: "b", title: "B" }]);
  const r = statusText(content, "content", "b", guess, { a: { state: "done", at: "2026-11-01" } }, content);
  assert.equal(r.display, "ready"); assert.equal(r.missing.length, 0);
  assert.match(statusText(content, "content", "a", guess, {}, content).note, /Claude's guess/);
});

// ---------- fuzzy retrieval, preflight, stage routing ----------
const fz = [
  P("Find the slope of the line through $(5,-2)$ and $(3,\\frac{1}{2})$.", ["U12"]),
  P("Shade the half-plane $y < 3x + 2$ and say whether $(0,0)$ is in it.", ["U13"]),
  P("Expand $(x+3)^2$ and simplify.", ["U19"]),
  P("Solve $|x-4| = 7$.", ["M1"]),
];
test("fuzzy search: a numeric/variable variant of a problem ranks first", () => {
  const hits = searchCorpus(fz, { similarTo: "Find the slope of the line through $(7,1)$ and $(-2,\\frac{3}{4})$.", limit: 3 });
  assert.equal(hits[0].p.units[0], "U12");
  assert.ok(shapeSim("Solve $2x+3=7$.", "Solve $5t+1=9$.") > 0.9);
});
test("fuzzy search: spelling and synonym variants match (halfplane, perp)", () => {
  assert.equal(searchCorpus(fz, { query: "halfplane", limit: 2 })[0]?.p.units[0], "U13");
  assert.equal(searchCorpus(fz, { query: "absolute value equation", limit: 2 })[0]?.p.units[0], "M1");
});
test("corpus save merges near-duplicates (same numbers, different spacing/wording)", () => {
  const list = fz.map((x) => ({ ...x, aliases: [] }));
  const r = addProblems(list, [{ tex: "Find the slope of the line through $(5, -2)$ and $(3, \\dfrac{1}{2})$." }], { file: false });
  assert.equal(r.added.length, 0);
  assert.equal(r.merged[0], fz[0].id);
});
test("coverage: a section with enough usable corpus problems needs no research", () => {
  const many = Array.from({ length: 8 }, (_, i) => P(`Expand $(x+${i + 1})^2$.`, ["U19"]));
  const c = coverage([...fz, ...many], [{ key: "a", title: "expand squares", query: "expand", units: ["U19"], target: 6 }, { key: "b", title: "parabola focus", query: "parabola focus directrix", units: ["U15"], target: 6 }], { allowed: ["U19", "U15"] });
  assert.equal(c[0].verdict, "covered");
  assert.equal(c[1].verdict, "empty");
});
test("preflight: topics in NEXT/FUTURE units are promoted instead of asked; blank disclaimer means no", () => {
  const ladder = fs.readFileSync(path.join(HERE, "..", "..", "curriculum_ladder.md"), "utf8");
  const status = ["# Weekly status", "", "TAUGHT: U01, U02, U03, U04, U05, U06, U07, U08, U09, U10, U12, U13, U14", "CURRENT: U11", "NEXT: U15", "",
    "## This week's input", "Date (for title): 11/23/2026", "Topics: Polynomial arithmetic and exponent laws (U19); Functions and domain, introduced only as needed (U21); Parabolas geometrically (U15)", "Disclaimer: ", ""].join("\n");
  const b = buildBrief({ status, ladder, corpus: fz });
  assert.deepEqual(b.promotions.map((p) => p.id).sort(), ["U15", "U19", "U21"]);
  assert.equal(b.disclaimer, "no");
  assert.deepEqual(b.required, []);
  assert.ok(b.sections.length >= 3 && b.sections.length <= 4);
  assert.ok(b.allowedUnits.includes("U19"));
  assert.match(briefText(b), /do not ask/);
  const off = buildBrief({ status, ladder, corpus: fz, overrides: { "promote:U21": false } });
  assert.ok(!off.allowedUnits.includes("U21"));
});
test("preflight: answer key, worked examples and unit circle sheet reach the brief", () => {
  const ladder = fs.readFileSync(path.join(HERE, "..", "..", "curriculum_ladder.md"), "utf8");
  const base = ["## This week's input", "Date (for title): 11/23/2026", "Topics: Linear equations"];
  const brief = (extra) => buildBrief({ status: [...base, ...extra, ""].join("\n"), ladder, corpus: fz });
  const none = brief([]);
  assert.equal(none.answerKey, false); assert.equal(none.unitCircle, false); assert.equal(none.workedExamples, 0); assert.equal(none.graphPaperMode, "auto");
  assert.match(briefText(none), /Graph paper: auto \(only if the set is graphing-adjacent\) · Answer key: no · Unit circle sheet: no · Worked examples: no/);
  const all = brief(["Answer key: yes", "Worked examples: 2", "Unit circle sheet: yes", "Graph paper: yes"]);
  assert.equal(all.answerKey, true); assert.equal(all.unitCircle, true); assert.equal(all.workedExamples, 2);
  // The brief is Claude's whole input, so literal inputs are stated too.
  assert.match(briefText(all), /Graph paper: yes · Answer key: yes · Unit circle sheet: yes · Worked examples: 2/);
  const auto = brief(["Worked examples: yes"]);
  assert.equal(auto.workedExamples, "auto");
  assert.match(briefText(auto), /Worked examples: yes \(you choose how many\)/);
});
test("routing: checkpoint and final on the week's model, fixes on Haiku then up a tier", () => {
  const w = { model: "claude-opus-5-5", messages: [] };
  assert.equal(stageFor("start", w), "outline");
  assert.equal(modelFor("outline", w), "claude-opus-5-5");
  assert.equal(stageFor("approve", w), "final");
  assert.equal(modelFor("final", w), STAGES.final.model || "claude-opus-5-5");
  assert.equal(modelFor("fix", { messages: [{ role: "user", kind: "fix" }] }), STAGES.fix.model);
  assert.notEqual(modelFor("fix", { messages: [{ role: "user", kind: "fix" }, { role: "user", kind: "fix" }] }), STAGES.fix.model);
  assert.equal(stageFor("chat", { messages: [{ role: "assistant", text: "```latex\n\\begin{document}\n```" }] }), "final");
});
test("brief: rendered from the status record, with conventions, review and history; no rulings", () => {
  const ladder = fs.readFileSync(path.join(HERE, "..", "..", "curriculum_ladder.md"), "utf8");
  const status = ["TAUGHT: U01, U02", "CURRENT: U03 (just started)", "NEXT: U04", "", "## Review priority", "1. completing the square", "2. slopes", "",
    "## Extra bans this week", "- (none)", "", "## Standing conventions", "- (12/5) Show a right angle by slopes.", "", "## Recent history", "- 12/5: lines",
    "", "## This week's input", "Date (for title): 12/12/2026", "Topics: Linear equations", "Disclaimer: no", "Fact sheet or other auxiliary file:", "  Facts", "  more facts", ""].join("\n");
  const t = briefText(buildBrief({ status, ladder, corpus: fz }));
  assert.match(t, /CURRENT: U03 \(just started\)/);
  assert.match(t, /1\. completing the square\n2\. slopes/);
  assert.match(t, /Show a right angle by slopes/);
  assert.match(t, /12\/5: lines/);
  assert.match(t, /Facts\nmore facts/);
  assert.doesNotMatch(t, /Extra bans|ruling from the teacher|weekly_status/i);
});
test("status record: the app applies a finished week itself", () => {
  const md = ["# Weekly status", "", "## Unit statuses", "TAUGHT: U01", "CURRENT: U02 (rest of U02)", "NEXT: U03, U04", "FUTURE: everything else", "",
    "## Review priority", "1. old item", "", "## Standing conventions", "- (11/1) Keep it short.", "", "## Recent history", "- 11/1: start", "",
    "## This week's input", "Date (for title): 12/12/2026", "Topics: Lines (U03)", "Fact sheet or other auxiliary file:", "  line one", "Disclaimer: no", ""].join("\n");
  const final = 'Done.\n```latex\n\\begin{document}x\\end{document}\n```\n```json\n[{"part":1,"n":1}]\n```\n```json\n{"history": "lines and slopes", "review": ["slopes", "old item"], "conventions": ["Keep it short.", "Use exact values."]}\n```';
  const week = { title: "HW 12/12/2026", messages: [{ role: "user", kind: "start", brief: { date: "12/12/2026", promotions: [{ id: "U03", accepted: true }, { id: "U04", accepted: false }] } }] };
  const inputs = weekUpdateInputs(week, { text: final }, md);
  assert.deepEqual(inputs.promote, ["U03"]);
  const out = applyWeekUpdate(md, inputs);
  assert.match(out, /^CURRENT: U02 \(rest of U02\), U03 \(set CURRENT 12\/12\)$/m);
  assert.match(out, /^NEXT: U04$/m);
  assert.match(out, /## Review priority\n1\. slopes\n2\. old item\n\n## Standing/);
  assert.match(out, /- \(11\/1\) Keep it short\.\n- \(12\/12\) Use exact values\.\n/, "a convention already there is not added twice");
  assert.match(out, /- 11\/1: start\n- 12\/12: lines and slopes/);
  assert.match(out, /^Date \(for title\): $/m);
  assert.match(out, /^Topics: $/m);
  assert.doesNotMatch(out, /line one/);
  assert.equal(applyWeekUpdate(md, { promote: [], update: null }).split("## This week's input")[0], md.split("## This week's input")[0], "no update: only the input is cleared");
  assert.equal(promoteUnits("TAUGHT: U01\nCURRENT: (none)\nNEXT: U02", ["U02"]), "TAUGHT: U01\nCURRENT: U02\nNEXT: (none)");
});
test("status record: an older final's whole weekly_status.md is read as an update", () => {
  const base = "## Review priority\n1. a\n\n## Recent history\n- 11/1: x\n";
  const final = "```markdown\n## Unit statuses\nTAUGHT: U01\n\n## Review priority\n1. b\n2. a\n\n## Recent history\n- 11/1: x\n- 11/8: y\n```";
  assert.deepEqual(statusUpdateFrom(final, base), { history: "11/8: y", review: ["b", "a"], conventions: [], legacy: true });
  assert.equal(statusUpdateFrom("no blocks"), null);
});
test("status upload: must look like a status file", () => {
  assert.equal(checkStatusUpload("TAUGHT: U01\nCURRENT: U02\n"), null);
  assert.match(checkStatusUpload("# notes\nhello"), /TAUGHT/);
  assert.match(checkStatusUpload("  "), /empty/);
});

test("auth: the API key is the only way in", () => {
  assert.equal(decideAuth({ ANTHROPIC_API_KEY: "sk-test" }).mode, "api-key");
  assert.equal(decideAuth({}).mode, "none");
  assert.match(decideAuth({}).note, /ANTHROPIC_API_KEY/);
});

test("login: scrypt hash verifies only the right password; rate limit blocks and resets", () => {
  const h = hashPassword("correct horse battery");
  assert.ok(validHash(h));
  assert.ok(verifyPassword("correct horse battery", h));
  assert.ok(!verifyPassword("correct horse batter", h));
  assert.ok(!verifyPassword("anything", "not-a-hash"));
  assert.notEqual(hashPassword("x".repeat(10)), hashPassword("x".repeat(10)));
  const rl = rateLimiter({ perClient: 3, overall: 5, windowMs: 1000 });
  for (let i = 0; i < 3; i++) rl.fail("a", 0);
  assert.ok(rl.blocked("a", 10)); assert.ok(!rl.blocked("b", 10));
  assert.ok(!rl.blocked("a", 2000));
  rl.fail("b", 3000); rl.fail("c", 3000); rl.fail("d", 3000); rl.fail("e", 3000); rl.fail("f", 3000);
  assert.ok(rl.blocked("g", 3001));
  assert.deepEqual(parseCookies("a=1; hw_session=x%2By"), { a: "1", hw_session: "x+y" });
});

// ---------- hw.db: versioned curricula, lineage, progress (in-memory) ----------
const LADDER_MD = (() => { const f = path.join(HERE, "..", "..", "curriculum_ladder.md"); return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null; })();
const TINY = {
  content: { nodes: ["A", "B", "C", "F"].map((t, i) => ({ id: `e${i + 1}`, title: `Node ${t}`, detail: "", kind: "theorem", x: i * 10, y: 0, w: 230, h: 88 })), edges: [{ from: "e1", to: "e2", prove: false, bends: null }] },
  methods: { nodes: [{ id: "e9", title: "Method", detail: "", kind: "method", x: 0, y: 0, w: 230, h: 88, sections: [3], restsOn: ["e1"] }], edges: [] },
};
const TINY_PLAN = "# Ladder\n\n## Ordered\n- U01 First unit. needs: none\n- U02 Second unit. needs: U01\n";
function freshCurriculum() {
  const db = openDb(null, { memory: true });
  Cur.ensureCurriculum(db, "t", "Test");
  const v1 = Cur.createDraft(db, "t", { origin: "migration" });
  Cur.writeGraph(db, v1, "content", TINY.content); Cur.writeGraph(db, v1, "methods", TINY.methods);
  Cur.writePlan(db, v1, parseLadder(TINY_PLAN), { covers: { U01: ["e1"] } });
  Cur.publish(db, v1);
  const s1 = Prog.addStudent(db, "One"), s2 = Prog.addStudent(db, "Two");
  return { db, v1, e1: Prog.enroll(db, s1, "t", v1), e2: Prog.enroll(db, s2, "t", v1) };
}
const tagProblem = (db, id, keys, v) => {
  db.prepare("INSERT OR IGNORE INTO problem(id, tex, answer, context, source_json, status, cas_verified, aliases_json, added_at, ord) VALUES (?, ?, '', '', '{}', 'candidate', 0, '[]', ?, 0)").run(id, `tex ${id}`, new Date().toISOString());
  keys.forEach((k, i) => db.prepare("INSERT INTO problem_tag(problem_id, node_key, version_id, pos, source, at) VALUES (?,?,?,?, 'teacher', ?)").run(id, k, v, i, new Date().toISOString()));
};

test("hw.db: the real DAGs and lesson plan round-trip through a version", () => {
  const db = openDb(null, { memory: true });
  Cur.ensureCurriculum(db, "w", "W");
  const v = Cur.createDraft(db, "w", { origin: "migration" });
  const content = JSON.parse(fs.readFileSync(path.join(DATA, "wu_dag.json"), "utf8")), methods = JSON.parse(fs.readFileSync(path.join(DATA, "wu_methods_dag.json"), "utf8"));
  Cur.writeGraph(db, v, "content", content); Cur.writeGraph(db, v, "methods", methods);
  const g = Cur.graphFor(db, v, "content");
  assert.deepEqual(g.nodes, content.nodes); assert.deepEqual(g.edges, content.edges);
  assert.deepEqual(Cur.graphFor(db, v, "methods").nodes, methods.nodes);
  if (LADDER_MD) { Cur.writePlan(db, v, parseLadder(LADDER_MD)); assert.equal(Cur.ladderFor(db, v), LADDER_MD); }
  assert.equal(renderLadder(parseLadder(TINY_PLAN)), TINY_PLAN);
});
test("hw.db: lineage resolves merge, split and retire, composed across versions", () => {
  const { db, v1 } = freshCurriculum();
  const v2 = Cur.createDraft(db, "t");
  const { keys: [d, e] } = Cur.editDraft(db, v2, [{ op: "upsertNode", layer: "content", fields: { title: "D" } }, { op: "upsertNode", layer: "content", fields: { title: "E" } }]);
  assert.throws(() => Cur.editDraft(db, v2, [{ op: "removeNode", key: "e1", relation: "merged", into: ["nope"] }]));
  Cur.editDraft(db, v2, [{ op: "removeNode", key: "e1", relation: "merged", into: ["e2"] }, { op: "removeNode", key: "e3", relation: "split", into: [d, e] }]);
  Cur.editDraft(db, v2, [{ op: "removeNode", key: "e4", relation: "retired" }]);
  Cur.publish(db, v2);
  const v3 = Cur.createDraft(db, "t");
  Cur.editDraft(db, v3, [{ op: "removeNode", key: "e2", relation: "merged", into: [d] }]);
  Cur.publish(db, v3);
  const idx = Cur.lineageIndex(db, "t");
  assert.deepEqual(idx.resolve("e1", v1, v2), { status: "migrated", keys: ["e2"] });
  assert.deepEqual(idx.resolve("e1", v1, v3), { status: "migrated", keys: [d] }); // merge then merge
  assert.equal(idx.resolve("e3", v1, v3).status, "ambiguous");
  assert.equal(idx.resolve("e4", v1, v3).status, "retired");
  assert.equal(idx.resolve("m:e9", v1, v3).status, "current");
  assert.throws(() => Cur.editDraft(db, v1, [{ op: "setNote", note: "x" }]), /published/);
});
test("hw.db: publish refuses unexplained removals, then migrates tags and queues the ambiguous ones", () => {
  const { db, v1 } = freshCurriculum();
  tagProblem(db, "p1", ["e1", "U01"], v1); tagProblem(db, "p2", ["e3"], v1); tagProblem(db, "p3", ["e2"], v1);
  const v2 = Cur.createDraft(db, "t");
  const { keys: [d, e] } = Cur.editDraft(db, v2, [{ op: "upsertNode", layer: "content", fields: { title: "D" } }, { op: "upsertNode", layer: "content", fields: { title: "E" } }]);
  db.prepare("DELETE FROM node_revision WHERE version_id = ? AND node_key IN ('e1','e3')").run(v2); // as an import would
  assert.throws(() => Cur.publish(db, v2), (err) => assert.deepEqual(err.missing.sort(), ["e1", "e3"]) || true);
  Cur.editDraft(db, v2, [{ op: "lineage", key: "e1", relation: "merged", into: ["e2"] }, { op: "lineage", key: "e3", relation: "split", into: [d, e] }]);
  const r = Cur.publish(db, v2);
  assert.equal(r.lineageTags, 1); assert.equal(r.queued, 1);
  assert.deepEqual(db.prepare("SELECT problem_id, reason FROM retag_queue").all().map((x) => ({ ...x })), [{ problem_id: "p2", reason: "split" }]);
  const c = { db, curriculumId: "t", versionId: v2, enrollmentId: 1 };
  const byId = Object.fromEntries(loadCorpusDb(c).map((p) => [p.id, p]));
  assert.deepEqual(byId.p1.wuNodes, ["e2"]); assert.deepEqual(byId.p1.units, ["U01"]); assert.equal(byId.p1.taggedIn, 1);
  assert.ok(byId.p2.needsRetag); assert.deepEqual(byId.p2.wuNodes, []);
  assert.equal(byId.p3.taggedIn, undefined); // its only tag (e2) still exists: not stale
});
test("hw.db: a unit split sends units:[U02] tags to the retag queue; a unit merge moves them", () => {
  const { db, v1 } = freshCurriculum();
  tagProblem(db, "p1", ["U02"], v1); tagProblem(db, "p2", ["U01"], v1);
  const v2 = Cur.createDraft(db, "t");
  const { keys: [a, b] } = Cur.editDraft(db, v2, [{ op: "upsertNode", layer: "unit", fields: { name: "Second, part a", needs: ["U01"] } }, { op: "upsertNode", layer: "unit", fields: { name: "Second, part b", needs: ["U01"] } }]);
  assert.deepEqual([a, b], ["U03", "U04"]); // next unused U numbers, so the ladder can still read them
  Cur.editDraft(db, v2, [{ op: "removeNode", key: "U02", relation: "split", into: [a, b] }]);
  assert.equal(Cur.publish(db, v2).queued, 1);
  const v3 = Cur.createDraft(db, "t");
  Cur.editDraft(db, v3, [{ op: "removeNode", key: "U01", relation: "merged", into: [a] }]);
  assert.deepEqual(Cur.coversFor(db, v3)[a], ["e1"]); // covers follow the merge
  assert.equal(Cur.publish(db, v3).lineageTags, 1);
  const p2 = loadCorpusDb({ db, curriculumId: "t", versionId: v3, enrollmentId: 1 }).find((p) => p.id === "p2");
  assert.deepEqual(p2.units, [a]);
});
test("lesson plan editor: add, edit and remove units in the draft; the ladder reads them back", () => {
  const { db } = freshCurriculum();
  const v2 = Cur.createDraft(db, "t");
  const add = (fields) => Cur.editDraft(db, v2, [{ op: "upsertNode", layer: "unit", check: true, fields: { section: 0, ...fields } }]).keys[0];
  const k = add({ name: "Third unit", about: "Lines.", needs: ["U02"], stance: "Formal" });
  assert.equal(k, "U03");
  assert.throws(() => add({ name: "Bad. Name" }), /full stop/);
  assert.throws(() => add({ name: "X", needs: ["U99"] }), /U99/);
  assert.throws(() => add({ name: "X", about: "Covers. Needs U01." }), /description/);
  assert.throws(() => add({ name: "" }), /name/);
  Cur.editDraft(db, v2, [{ op: "upsertNode", layer: "unit", key: "U01", check: true, fields: { name: "First unit, renamed" } }]);
  Cur.editDraft(db, v2, [{ op: "removeNode", key: "U02", relation: "merged", into: ["U03"] }]);
  const md = Cur.ladderFor(db, v2), back = parseLadder(md);
  assert.deepEqual(back.units.map((u) => u.key), ["U01", "U03"]);
  assert.deepEqual(back.units[1].needs, []); // U03 needed U02, which merged into U03 itself
  assert.equal(back.units[0].name, "First unit, renamed");
  assert.deepEqual(Cur.planFor(db, v2).layout[0].items.filter((i) => i.unit), [{ unit: "U01" }, { unit: "U03" }]);
  Cur.publish(db, v2);
  const v3 = Cur.createDraft(db, "t");
  Cur.editDraft(db, v3, [{ op: "removeNode", key: "U03", relation: "retired" }]);
  assert.equal(Cur.editDraft(db, v3, [{ op: "upsertNode", layer: "unit", check: true, fields: { name: "Fresh", section: 0 } }]).keys[0], "U04"); // U03 is never reused
});
test("lesson plan editor: reordering a section's units moves their ladder lines and shows in the diff", () => {
  const { db, v1 } = freshCurriculum();
  const v2 = Cur.createDraft(db, "t");
  Cur.editDraft(db, v2, [{ op: "upsertNode", layer: "unit", check: true, fields: { name: "Third unit", section: 0 } }]);
  assert.throws(() => Cur.editDraft(db, v2, [{ op: "orderUnits", section: 0, keys: ["U01", "U02"] }]), /section's units/);
  Cur.editDraft(db, v2, [{ op: "orderUnits", section: 0, keys: ["U03", "U01", "U02"] }]);
  assert.deepEqual(parseLadder(Cur.ladderFor(db, v2)).units.map((u) => u.key), ["U03", "U01", "U02"]);
  assert.equal(Cur.diffVersions(db, v1, v2).unitOrderChanged, false); // only the new unit moved
  Cur.editDraft(db, v2, [{ op: "orderUnits", section: 0, keys: ["U02", "U03", "U01"] }]);
  assert.deepEqual(parseLadder(Cur.ladderFor(db, v2)).units.map((u) => u.key), ["U02", "U03", "U01"]);
  assert.deepEqual(Cur.planFor(db, v2).units.map((u) => u.key), ["U02", "U03", "U01"]); // ord follows
  assert.equal(Cur.diffVersions(db, v1, v2).unitOrderChanged, true);
});
test("hw.db: re-import matches by whiteboard id, then title; the rest are new or gone", () => {
  const old = [{ key: "e1", external_ref: "e1", title: "Linear equations" }, { key: "c:abc", external_ref: "e7", title: "Old title" }, { key: "e3", external_ref: "e3", title: "Gone" }];
  const { map, unmatchedOld } = Cur.matchImport(old, [{ id: "e1", title: "Renamed" }, { id: "e50", title: "Old  Title!" }, { id: "e51", title: "Brand new" }]);
  assert.deepEqual(map, { e1: "e1", e50: "c:abc", e51: null });
  assert.deepEqual(unmatchedOld, ["e3"]);
});
test("hw.db: upgrading an enrollment carries progress (merge = least advanced, split = partial + flagged)", () => {
  const { db, v1, e1 } = freshCurriculum();
  Prog.saveGuessRun(db, e1, { id: "r1", at: "2026-01-01T00:00:00.000Z", ok: true, nodes: { e1: { state: "done" }, e2: { state: "partial" }, e3: { state: "done" } } });
  Prog.setOverride(db, e1, "e4", "done", "taught");
  const v2 = Cur.createDraft(db, "t");
  const { keys: [d, e] } = Cur.editDraft(db, v2, [{ op: "upsertNode", layer: "content", fields: { title: "D" } }, { op: "upsertNode", layer: "content", fields: { title: "E" } }]);
  Cur.editDraft(db, v2, [{ op: "removeNode", key: "e1", relation: "merged", into: ["e2"] }, { op: "removeNode", key: "e3", relation: "split", into: [d, e] }, { op: "removeNode", key: "e4", relation: "retired" }]);
  Cur.publish(db, v2);
  assert.throws(() => Prog.upgradeEnrollment(db, e1, 999));
  assert.equal(Prog.upgradeEnrollment(db, e1, v2).written, 3);
  const st = Prog.dagState(db, e1);
  assert.equal(st.guess.nodes.e2.state, "partial");
  assert.equal(st.guess.nodes[d].state, "partial"); assert.ok(st.guess.nodes[d].flagged);
  assert.ok(!("e4" in st.overrides) && !("e4" in st.guess.nodes));
  Prog.setOverride(db, e1, "e2", "done"); assert.equal(Prog.dagState(db, e1).overrides.e2.state, "done");
  Prog.setOverride(db, e1, "e2", null); assert.ok(!("e2" in Prog.dagState(db, e1).overrides));
  assert.equal(Prog.dagState(db, e1, v1).guess.nodes.e1.state, "done"); // the old version still reads as it was
});
test("hw.db: a split into a node that already exists leaves that node's own state alone", () => {
  const { db, e1 } = freshCurriculum();
  Prog.saveGuessRun(db, e1, { id: "r1", at: "2026-01-01T00:00:00.000Z", ok: true, nodes: { e2: { state: "done" }, e3: { state: "not-yet" } } });
  const v2 = Cur.createDraft(db, "t");
  const { keys: [d] } = Cur.editDraft(db, v2, [{ op: "upsertNode", layer: "content", fields: { title: "D" } }]);
  Cur.editDraft(db, v2, [{ op: "removeNode", key: "e3", relation: "split", into: ["e2", d] }]);
  Cur.publish(db, v2);
  assert.equal(Prog.upgradeEnrollment(db, e1, v2).written, 1);
  const n = Prog.dagState(db, e1).guess.nodes;
  assert.equal(n.e2.state, "done"); assert.ok(!n.e2.flagged);
  assert.equal(n[d].state, "partial"); assert.ok(n[d].flagged);
});
test("hw.db: usedOn and recency are per student", () => {
  const { db, v1, e1, e2 } = freshCurriculum();
  tagProblem(db, "p1", ["U01"], v1);
  const c1 = { db, curriculumId: "t", versionId: v1, enrollmentId: e1 }, c2 = { ...c1, enrollmentId: e2 };
  const today = new Date().toISOString().slice(0, 10);
  recordAssignment(c1, { id: "w1", title: "Week 1", date: today, items: [{ problemId: "p1" }] });
  assert.deepEqual(loadCorpusDb(c1)[0].usedOn, [today]);
  assert.deepEqual(loadCorpusDb(c2)[0].usedOn, []);
  const rank = (c) => searchCorpus(loadCorpusDb(c), { units: ["U01"], limit: 5 })[0];
  assert.ok(rank(c1).score < rank(c2).score, "recently used for student 1 ranks lower for student 1 only");
});

test("answer checks: the reply's checks block is found, stripped for the teacher, and left apart from the other blocks", () => {
  const block = (o) => "```json\n" + JSON.stringify(o, null, 1) + "\n```";
  const text = ["Checkpoint.", block([{ part: 1, n: 1, answer: "2" }]), block({ history: "h" }), block({ checks: [{ id: "P1.1", expr: "x=2", claimed: "2" }] })].join("\n\n");
  assert.deepEqual(checksFrom(text), [{ id: "P1.1", expr: "x=2", claimed: "2" }]);
  assert.equal(checksFrom("no blocks"), null);
  const shown = stripChecks(text);
  assert.doesNotMatch(shown, /checks/);
  assert.match(shown, /"part": 1/); assert.equal(statusUpdateFrom(shown).history, "h");
  assert.deepEqual(normChecks([{ id: 3, expr: "x", vars: ["x", "y"], claimed: "" }, "junk"]), [{ id: "3", kind: "solve", expr: "x", vars: "x, y", claimed: null, form: "" }]);
});
test("answer checks: one count line, then only the items that need attention", () => {
  assert.equal(formatChecks([{ id: "a", status: "ok" }, { id: "b", status: "ok" }]), "all 2 ok");
  assert.equal(formatChecks([{ id: "a", status: "ok" }, { id: "b", status: "wrong", msg: "m" }, { id: "c", status: "error", msg: "e" }, { id: "d", status: "info", msg: "x: {1}" }]),
    "1 ok, 1 wrong, 1 not checked\nd: x: {1}\nb WRONG: m\nc NOT CHECKED: e");
});
test("answer checks: the app's latest verdict per id, from the last .tex reply on", () => {
  const A = (text, checks) => ({ role: "assistant", text, checks });
  const week = { messages: [A("```latex\nold\n```", { ok: ["P9.9"], wrong: [], unchecked: [] }), { role: "user", text: "fix" },
    A("```latex\nnew\n```", { ok: ["P1.1"], wrong: ["P1.2"], unchecked: ["P1.3"] }), { role: "user", text: "verify" }, A("", { ok: ["P1.2"], wrong: [], unchecked: [] })] };
  const ck = appChecks(week);
  assert.deepEqual([...ck.ok].sort(), ["P1.1", "P1.2"]); assert.deepEqual([...ck.wrong], []); assert.deepEqual([...ck.unchecked], ["P1.3"]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
