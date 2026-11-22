#!/usr/bin/env node
// One-time seed of ui/data/corpus/problems.jsonl from the homework .tex files in the project folder.
//   node ui/scripts/seed-corpus.mjs              split every hw_*.tex, tag units + Wu nodes with one cheap claude pass
//   node ui/scripts/seed-corpus.mjs --no-claude  keyword tagging only
//   node ui/scripts/seed-corpus.mjs --dry        print what would be added
// Safe to re-run: problems are keyed by a hash of their TeX and merged.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA, loadCorpus, addProblems, splitTex, keywordUnits, dateFromName } from "../lib/corpus.mjs";
import { tagProblems, TAG_MODEL } from "../lib/tagger.mjs";

const ROOT = process.env.HW_ROOT ? path.resolve(process.env.HW_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const useClaude = !args.includes("--no-claude"), dry = args.includes("--dry");

const files = fs.readdirSync(ROOT).filter((n) => /^hw_.*\.tex$/i.test(n));
const probs = [];
for (const f of files) {
  const date = dateFromName(f);
  for (const { tex, context } of splitTex(fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\r\n/g, "\n"))) {
    probs.push({ tex, context, units: keywordUnits(tex + " " + context), source: { kind: "gold", file: f, date }, status: "used", usedOn: date ? [date] : [] });
  }
}
console.log(`${files.length} files, ${probs.length} problems`);

if (useClaude && probs.length) {
  console.log(`tagging with ${TAG_MODEL}…`);
  try { const r = await tagProblems(probs, { root: ROOT, data: DATA }); console.log(`tagged ${r.tagged}/${probs.length} with Claude (API-equivalent cost $${r.cost.toFixed(3)})`); }
  catch (e) { console.warn("Claude tagging failed, keeping keyword tags:", e.message); }
}

if (dry) { for (const p of probs) console.log(p.source.file, p.units.join(","), (p.wuNodes || []).join(","), "|", p.tex.replace(/\s+/g, " ").slice(0, 90)); process.exit(0); }
const items = loadCorpus();
const r = addProblems(items, probs);
console.log(`corpus: ${r.added.length} added, ${r.merged.length} merged → ${items.length} total in ${path.join(DATA, "corpus", "problems.jsonl")}`);
