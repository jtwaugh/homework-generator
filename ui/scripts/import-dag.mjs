// One-time import of a Wu algebra whiteboard snapshot (elements/*.json) into ui/data/.
//   node ui/scripts/import-dag.mjs content <elements-dir>   -> data/wu_dag.json          (content DAG)
//   node ui/scripts/import-dag.mjs methods <elements-dir>   -> data/wu_methods_dag.json  (methods DAG)
// The methods board links each method to the content-DAG node it rests on ("§3 · rests on Linear equations"),
// so import the content board first.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [which, dir] = process.argv.slice(2);
const BOARDS = {
  content: { out: "wu_dag.json", source: "https://claude.ai/artifact/Wc277jvQy91AJxjW5mKriz",
    kind: { white: "assumed", blue: "definition", green: "theorem", yellow: "method" }, fallback: "theorem" },
  methods: { out: "wu_methods_dag.json", source: "https://claude.ai/artifact/VXoFQ7VKBpfGDtzu8Lgu68",
    kind: { yellow: "method", white: "word-problem" }, fallback: "method" },
};
const B = BOARDS[which];
if (!B || !dir) { console.error("usage: import-dag.mjs content|methods <elements-dir>"); process.exit(1); }
const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

const els = fs.readdirSync(dir).filter((f) => /^e\d+\.json$/.test(f)).map((f) => ({ id: f.slice(0, -5), ...JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) }));
const nodes = els.filter((e) => e.type === "shape").map((e) => {
  const [first, ...rest] = (e.text || "").split("\n");
  return { id: e.id, title: first.replace(/\*\*/g, "").trim(), detail: rest.join("\n").replace(/\*\*/g, "").trim(), kind: B.kind[e.color] || B.fallback, x: e.x, y: e.y, w: e.w, h: e.h };
}).sort((a, b) => a.y - b.y || a.x - b.x);

if (which === "methods") {
  // "§6, §12 · equal polynomials" / "§3 · rests on Linear equations" -> sections + restsOn (content node ids)
  const content = JSON.parse(fs.readFileSync(path.join(DATA, "wu_dag.json"), "utf8")).nodes;
  const norm = (s) => s.toLowerCase().replace(/^§\d+\s*/, "").replace(/[^a-z0-9]+/g, " ").trim();
  for (const n of nodes) {
    const [secs, basis = ""] = n.detail.split("·").map((s) => s.trim());
    n.sections = [...secs.matchAll(/§(\d+)/g)].map((m) => +m[1]);
    const want = norm(basis.replace(/^rests on\s*/i, ""));
    const hit = want && content.find((c) => norm(c.title) === want || norm(c.title).startsWith(want));
    n.restsOn = hit ? [hit.id] : [];
    if (!hit && /rests on/i.test(basis)) console.warn(`  ${n.id} "${n.title}": no content node for "${basis}"`);
  }
}

const ids = new Set(nodes.map((n) => n.id));
const edges = els.filter((e) => e.type === "arrow").map((e) => ({ from: e.from, to: e.to, prove: !!e.dash, bends: e.bends || null }));
const bad = edges.filter((e) => !ids.has(e.from) || !ids.has(e.to));
if (bad.length) { console.error("edges with missing endpoints:", bad); process.exit(1); }
const texts = els.filter((e) => e.type === "text").map((e) => ({ text: e.text, size: e.size, x: e.x, y: e.y, wrap: e.wrap }));
const out = path.join(DATA, B.out);
fs.writeFileSync(out, JSON.stringify({ source: B.source, board: which, importedAt: new Date().toISOString().slice(0, 10), nodes, edges, texts }, null, 1));
console.log(`wrote ${out}: ${nodes.length} nodes, ${edges.length} edges (${edges.filter((e) => e.prove).length} prove)`);
