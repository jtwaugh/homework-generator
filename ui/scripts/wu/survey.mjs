#!/usr/bin/env node
// Stage 3: decide which curricula the drafts become, and which chapters (doc + PDF page range) feed each one.
//
//   node --env-file=.env ui/scripts/wu/survey.mjs [--dry] [--force]
//
// One Opus call. Input: each doc's first pages in full (title page, table of contents) and the first lines of
// every other page (enough to see where chapters and sections start). Output: split.json, which you review and
// may edit before extract.mjs runs.
import fs from "node:fs";
import { BOOKS, DOCS, p } from "./sources.mjs";
import { ask, estimate, readPage, pagesText, words, readJson, writeJson } from "./claude.mjs";

const dry = process.argv.includes("--dry"), force = process.argv.includes("--force");
const out = p("split.json");
if (fs.existsSync(out) && !force && !dry) { console.log(`${out} exists (use --force to redo it)`); process.exit(0); }
const manifest = readJson(p("manifest.json"));
if (!manifest) throw new Error("run fetch.mjs first");

const heads = Object.entries(manifest.docs).map(([doc, d]) => {
  const lines = [];
  for (let i = 5; i <= d.pages; i++) {
    const first = readPage(doc, i).split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 2).join(" | ");
    const cut = [...first].slice(0, 120).join("");
    lines.push(`p.${i}: ${cut}`);
  }
  return `### ${doc} — ${d.title} — drafts the book "${BOOKS[d.book]}" — ${d.pages} PDF pages\n\nFirst pages in full:\n${pagesText(doc, 1, Math.min(4, d.pages))}\n\nFirst lines of each later page:\n${lines.join("\n")}`;
}).join("\n\n");

const system = `You are planning how to turn H. Wu's books on school mathematics into curricula for a teaching app.
Each curriculum gets two dependency graphs: a content DAG (definitions, theorems, assumed facts, in Wu's logical order)
and a methods DAG (solution methods and word-problem types a student learns). You are given free drafts Wu posted,
standing in for his six published books. Decide the curricula and which page ranges feed each.`;

const prompt = `Here are the drafts:\n\n${heads}

Plan the curricula.
- A curriculum is a course a student would take: a grade band and a coherent body of mathematics (e.g. whole numbers K-5,
  fractions 3-6, rational numbers and pre-algebra 6-7, middle-school geometry, Algebra 1, high-school geometry,
  pre-calculus). One book may become several curricula; several drafts may feed one curriculum when they cover the
  same ground (their overlapping nodes are merged later).
- "Introduction to School Algebra" (doc Algebrasummary) must be curriculum id "wu-algebra-1" titled "Wu Algebra 1".
  Other ids are "wu-" plus a short slug.
- Every chapter is a doc plus an inclusive PDF page range (the p.N numbers above, not printed page numbers). Skip
  front matter, prefaces about policy, bibliographies, indexes and solutions. Keep chapters at most ~35 pages: split a
  longer chapter into consecutive parts at section boundaries.
- Each page range should belong to exactly one curriculum.
- assumes: ids of the other curricula a curriculum builds on.
- thin: true when the source is too short or too partial for a full course (say why in summary).
Order curricula from earliest grade to latest.`;

const schema = {
  type: "object",
  properties: {
    curricula: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" }, title: { type: "string" }, grades: { type: "string" }, books: { type: "array", items: { type: "string", enum: Object.keys(BOOKS) } },
          summary: { type: "string" }, thin: { type: "boolean" }, assumes: { type: "array", items: { type: "string" } },
          chapters: { type: "array", items: { type: "object", properties: { doc: { type: "string", enum: Object.keys(DOCS) }, title: { type: "string" }, from: { type: "integer" }, to: { type: "integer" } }, required: ["doc", "title", "from", "to"] } },
        },
        required: ["id", "title", "grades", "books", "summary", "thin", "assumes", "chapters"],
      },
    },
    notes: { type: "string" },
  },
  required: ["curricula", "notes"],
};

const est = estimate("opus", words(system + prompt), 6000);
console.log(`survey: ~${est.inTok} tokens in, ~$${est.usd.toFixed(2)} on Opus`);
if (dry) process.exit(0);
const { data, cost } = await ask({ model: "opus", system, prompt, schema, effort: "high", label: "survey" });
writeJson(out, { at: new Date().toISOString(), ...data });
console.log(`wrote ${out} ($${cost.toFixed(2)})\n`);
for (const c of data.curricula) {
  const pages = c.chapters.reduce((s, ch) => s + ch.to - ch.from + 1, 0);
  console.log(`${c.id} — ${c.title} (${c.grades})${c.thin ? " [thin]" : ""}: ${c.chapters.length} chapters, ${pages} pages; assumes ${c.assumes.join(", ") || "—"}\n  ${c.summary}`);
  for (const ch of c.chapters) console.log(`    ${ch.doc} p.${ch.from}-${ch.to}  ${ch.title}`);
}
console.log(`\n${data.notes}`);
