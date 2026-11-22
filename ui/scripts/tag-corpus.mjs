#!/usr/bin/env node
// Backfill: tag every corpus problem that has no Wu DAG nodes (content or methods), e.g. ones saved from a set
// before Save & finish tagged them.   node ui/scripts/tag-corpus.mjs [--all] [--dry]
// --all re-tags every problem (not rejected) from scratch: run it after editing wu_dag.json or wu_methods_dag.json,
// since old tags may point at nodes that moved, merged or no longer exist. The corpus is backed up first.
// Respects HW_ROOT / HW_DATA (try it on a sandbox first). Only wuNodes, tags and empty units are changed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA, loadCorpus, saveCorpus, patchProblem } from "../lib/corpus.mjs";
import { tagProblems, needsTags, TAG_MODEL } from "../lib/tagger.mjs";

const ROOT = process.env.HW_ROOT ? path.resolve(process.env.HW_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ALL = process.argv.includes("--all");
const FILE = path.join(DATA, "corpus", "problems.jsonl");
const todo = loadCorpus().filter(ALL ? (p) => p.status !== "rejected" : needsTags).map((p) => structuredClone(p));
if (ALL) for (const p of todo) { p.wuNodes = []; p.tags = []; }
console.log(`${todo.length} ${ALL ? "problems to re-tag" : "untagged problems"} in ${FILE}`);
if (process.argv.includes("--dry")) { for (const p of todo) console.log(p.id, p.source?.file || p.source?.kind, "|", p.tex.replace(/\s+/g, " ").slice(0, 90)); process.exit(0); }
if (!todo.length) process.exit(0);
if (ALL) { const bak = `${FILE}.bak-${Date.now()}`; fs.copyFileSync(FILE, bak); console.log(`backed up to ${bak}`); }
console.log(`tagging with ${TAG_MODEL}…`);
const r = await tagProblems(todo, { root: ROOT, data: DATA, onBatch: (b) => console.log(`  ${b.done}/${b.total}  $${b.cost.toFixed(3)}`) });
const items = loadCorpus();
for (const p of todo) patchProblem(items, p.id, { units: p.units, wuNodes: p.wuNodes, tags: p.tags }, { file: false });
saveCorpus(items);
const withM = todo.filter((p) => p.wuNodes.some((n) => n.startsWith("m:"))).length;
console.log(`tagged ${r.tagged}/${todo.length} (${withM} with a methods node), API-equivalent cost $${r.cost.toFixed(3)}`);
for (const p of todo.slice(0, 5)) console.log(" ", p.id, p.wuNodes.join(","), "|", p.tags.join("; "));
