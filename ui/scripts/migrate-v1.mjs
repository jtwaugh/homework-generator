#!/usr/bin/env node
// Migrate the v0 files (corpus jsonl, dag_state.json, weeks, status backups) into data/hw.db.
// The server does this by itself on first start; run it by hand to see the report first.
//   node ui/scripts/migrate-v1.mjs [--data DIR] [--root DIR] [--keep]   (--keep: don't move old files to legacy-v0/)
import { openDb, dataDir } from "../lib/db.mjs";
import { migrateV1, repoRoot } from "../lib/migrate.mjs";

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const data = arg("--data") || dataDir(), root = arg("--root") || repoRoot();
const r = migrateV1(openDb(data), { data, root, move: !process.argv.includes("--keep"), log: console.log });
if (r.skipped) console.log(`${data}/hw.db already has a curriculum; nothing to do`);
else {
  console.log(JSON.stringify({ ...r.report, ladderDiff: r.report.ladderDiff.length }, null, 1));
  for (const d of r.report.ladderDiff) console.log(`ladder line ${d.line}:\n  file: ${d.want}\n  db:   ${d.got}`);
}
