#!/usr/bin/env node
// Stage 5: merge each curriculum's chapter files into its content and methods graphs, link cross-course
// prerequisites, drop cycle-closing edges, lay the boards out, and write <cur>/content.json + methods.json.
//
//   node ui/scripts/wu/merge.mjs [curriculum ...]
//
// <cur>/merges.json (optional, [[ref, ref, ...]]) names refs that are the same node, <cur>/drops.json arrows to cut; <cur>/nodes.txt lists the merged
// nodes so a reviewer or a dedupe pass can write it. <cur>/report.json has the counts and every warning.
import fs from "node:fs";
import path from "node:path";
import { mergeChapters, resolveExternals, breakCycles, danglingEdges } from "../../lib/dagbuild.mjs";
import { layoutGraph } from "../../lib/layout.mjs";
import { DOCS, p } from "./sources.mjs";
import { readJson, writeJson } from "./claude.mjs";

const split = readJson(p("split.json"));
if (!split) throw new Error("run survey.mjs first");
const only = process.argv.slice(2);
const built = {}, meta = {};

for (const c of split.curricula) {
  const dir = p("chapters", c.id);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
  if (!files.length) { console.log(`${c.id}: no chapters extracted yet`); continue; }
  const chapters = files.map((f) => ({ file: f, ...readJson(path.join(dir, f)) }));
  const merges = readJson(p(c.id, "merges.json"), []);
  const r = mergeChapters(chapters, { curriculum: c.id, merges });
  // <cur>/drops.json (optional, [[fromRef, toRef], ...]): arrows a reviewer cut, e.g. to settle a cycle between two drafts.
  for (const [from, to] of readJson(p(c.id, "drops.json"), [])) {
    const g = [r.content, r.methods].find((g) => g.nodes.some((n) => n.refs.includes(from)) && g.nodes.some((n) => n.refs.includes(to)));
    const id = (ref) => g?.nodes.find((n) => n.refs.includes(ref)).id;
    const before = g?.edges.length;
    if (g) g.edges = g.edges.filter((e) => !(e.from === id(from) && e.to === id(to)));
    if (!g || g.edges.length === before) r.warnings.push(`drops.json: no arrow ${from} -> ${to}`);
  }
  built[c.id] = r;
  meta[c.id] = { c, files, chapters: chapters.length, of: c.chapters.length, warnings: r.warnings };
}
const xrefs = resolveExternals(built, readJson(p("xrefs.json"), {})); // xrefs.json: {"<cur>:<slug>": "<ref or title>"}

for (const [id, r] of Object.entries(built)) {
  if (only.length && !only.includes(id)) continue;
  const { c, warnings } = meta[id];
  const cut = { content: breakCycles(r.content), methods: breakCycles(r.methods) };
  for (const [layer, es] of Object.entries(cut)) for (const e of es) warnings.push(`${layer}: cycle broken by dropping ${e.from} -> ${e.to}`);
  const ids = new Set(r.content.nodes.map((n) => n.id));
  for (const n of [...r.content.nodes, ...r.methods.nodes]) if (n.title.length > 60) warnings.push(`${n.refs[0]}: title over 60 characters: ${n.title}`);
  for (const m of r.methods.nodes) m.restsOn = m.restsOn.filter((x) => ids.has(x));
  const bare = r.methods.nodes.filter((m) => !m.restsOn.length).map((m) => m.title);
  const docs = [...new Set(c.chapters.map((ch) => ch.doc))].map((d) => DOCS[d]?.title || d);
  const caption = (what) => [
    { text: `${c.title}: ${what}`, size: "title", x: 0, y: 0 },
    { text: "Each block needs every block that points to it.", size: "large", x: 0, y: 84 },
    { text: `Extracted by Claude from H. Wu's free drafts: ${docs.join("; ")}. The arrows are Claude's reading of the text, to be checked.${c.thin ? " The source is thin: this is a partial course." : ""}`, size: "body", x: 0, y: 140 },
  ];
  const header = { source: "wu-library", importedAt: new Date().toISOString(), curriculum: id, title: c.title, grades: c.grades, assumes: c.assumes };
  const content = layoutGraph({ ...header, ...r.content, texts: caption("content") });
  const methods = layoutGraph({ ...header, ...r.methods, texts: caption("methods") });
  for (const [name, g] of [["content", content], ["methods", methods]]) {
    const bad = danglingEdges(g);
    if (bad.length) throw new Error(`${id} ${name}: dangling edges ${bad.map((e) => `${e.from}->${e.to}`).join(", ")}`);
  }
  fs.mkdirSync(p(id), { recursive: true });
  writeJson(p(id, "content.json"), content);
  writeJson(p(id, "methods.json"), methods);
  const line = (n) => `${n.id}\t${n.kind}\t${n.title}${n.aliases ? ` (aka ${n.aliases.join("; ")})` : ""}\t[${n.refs.join(" ")}]\t${n.detail}`;
  fs.writeFileSync(p(id, "nodes.txt"), `# content\n${content.nodes.map(line).join("\n")}\n\n# methods\n${methods.nodes.map(line).join("\n")}\n`);
  const kinds = (g) => Object.entries(g.nodes.reduce((m, n) => ((m[n.kind] = (m[n.kind] || 0) + 1), m), {})).map(([k, v]) => `${v} ${k}`).join(", ");
  const report = {
    curriculum: id, chapters: `${meta[id].chapters}/${meta[id].of}`, content: { nodes: content.nodes.length, edges: content.edges.length, kinds: kinds(content) },
    methods: { nodes: methods.nodes.length, edges: methods.edges.length, kinds: kinds(methods) }, methodsWithoutGrounds: bare,
    externals: xrefs.filter((x) => x.curriculum === id), warnings,
  };
  writeJson(p(id, "report.json"), report);
  console.log(`${id}: ${report.chapters} chapters · content ${content.nodes.length} nodes/${content.edges.length} edges (${report.content.kinds}) · methods ${methods.nodes.length}/${methods.edges.length} · ${report.externals.filter((x) => x.resolved).length}/${report.externals.length} cross-course links resolved · ${warnings.length} warnings`);
}
