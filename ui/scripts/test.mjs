#!/usr/bin/env node
// Unit tests for the logic the basic workflows depend on: corpus search/save, the .tex splitter, topic chips,
// the two DAG data files and the map's state logic.   node ui/scripts/test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchCorpus, splitTex, problemId, addProblems, attachTex } from "../lib/corpus.mjs";
import { parseTopics, serializeTopics, historyTopics } from "../public/topics.js";
import { computeStates } from "../public/dag.js";
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
