#!/usr/bin/env node
// Unit tests for the logic the basic workflows depend on: corpus search/save, the .tex splitter, topic chips,
// the two DAG data files and the map's state logic.   node ui/scripts/test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchCorpus, splitTex, problemId, addProblems, attachTex, shapeSim, coverage } from "../lib/corpus.mjs";
import { buildBrief, briefText } from "../lib/preflight.mjs";
import { decideAuth } from "../lib/auth.mjs";
import { hashPassword, verifyPassword, validHash, rateLimiter, parseCookies } from "../lib/login.mjs";
import { stageFor, modelFor, assumptionsOf, STAGES } from "../server.mjs";
import { parseTopics, serializeTopics, historyTopics } from "../public/topics.js";
import { computeStates, statusText, lessonPlan } from "../public/dag.js";
import { S, lintTex, nextSetDate } from "../public/lib.js";
import { parseTags } from "../lib/tagger.mjs";

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
  const b = buildBrief({ status, ladder, corpus: fz, dataDir: path.join(HERE, "no-such-dir") });
  assert.deepEqual(b.promotions.map((p) => p.id).sort(), ["U15", "U19", "U21"]);
  assert.equal(b.disclaimer, "no");
  assert.deepEqual(b.required, []);
  assert.ok(b.sections.length >= 3 && b.sections.length <= 4);
  assert.ok(b.allowedUnits.includes("U19"));
  assert.match(briefText(b), /do not ask/);
  const off = buildBrief({ status, ladder, corpus: fz, dataDir: path.join(HERE, "no-such-dir"), overrides: { "promote:U21": false } });
  assert.ok(!off.allowedUnits.includes("U21"));
});
test("routing: checkpoint on the main model, final on Sonnet, fixes on Haiku then up a tier", () => {
  const w = { model: "claude-opus-5-5", messages: [] };
  assert.equal(stageFor("start", w), "outline");
  assert.equal(modelFor("outline", w), "claude-opus-5-5");
  assert.equal(stageFor("approve", w), "final");
  assert.equal(modelFor("final", w), STAGES.final.model);
  assert.equal(modelFor("fix", { messages: [{ role: "user", kind: "fix" }] }), STAGES.fix.model);
  assert.notEqual(modelFor("fix", { messages: [{ role: "user", kind: "fix" }, { role: "user", kind: "fix" }] }), STAGES.fix.model);
  assert.equal(stageFor("chat", { messages: [{ role: "assistant", text: "```latex\n\\begin{document}\n```" }] }), "final");
});
test("approval: the checkpoint's Assumptions become rulings", () => {
  const cp = "**Judgment calls:** none\n**Assumptions:**\n- U19 treated as CURRENT: positive integer exponents only.\n- Domain means all real inputs that give a real output.\n**Removed in audit:** none";
  assert.deepEqual(assumptionsOf(cp), ["U19 treated as CURRENT: positive integer exponents only.", "Domain means all real inputs that give a real output."]);
});

test("auth: subscription wins; API key only when none is found and HW_ALLOW_API_KEY=1", () => {
  const sub = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }, none = { loggedIn: false, authMethod: "none" };
  const key = { ANTHROPIC_API_KEY: "sk-x" }, optIn = { ...key, HW_ALLOW_API_KEY: "1" };
  assert.equal(decideAuth(sub, optIn).mode, "subscription");
  assert.equal(decideAuth(none, optIn).mode, "api-key");
  assert.equal(decideAuth(null, optIn).mode, "api-key");
  assert.equal(decideAuth(none, key).mode, "none");
  assert.match(decideAuth(none, key).note, /HW_ALLOW_API_KEY=1/);
  assert.equal(decideAuth(none, { HW_ALLOW_API_KEY: "1" }).mode, "none");
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
