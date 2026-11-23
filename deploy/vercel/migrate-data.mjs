// One-off: copy this machine's homework files and app data into the Vercel Blob store the hosted app mirrors.
//   vercel env pull --environment=development <file>   (gives BLOB_READ_WRITE_TOKEN)
//   node --env-file=<file> deploy/vercel/migrate-data.mjs [--prefix hw] [--yes]
// Without --yes it only lists what it would upload. It refuses if the prefix already holds data.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { blobStore, createMirror } from "../../ui/lib/mirror.mjs";

const REPO = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const base = args.includes("--prefix") ? args[args.indexOf("--prefix") + 1] : "hw";
const go = args.includes("--yes");
const SRC_ROOT = process.env.HW_ROOT || REPO;
const SRC_DATA = process.env.HW_DATA || path.join(REPO, "ui", "data");

const ROOT_FILES = (n) => /^hw_.*\.tex$/i.test(n) || ["weekly_status.md", "project_instructions.md", "curriculum_ladder.md"].includes(n);
const DATA_KEEP = ["backups", "corpus", "notes", "weeks", "jobs", "dag_state.json", "definitions.json", "sessions.json", "curricula", "legacy-v0"];

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "hw-migrate-"));
const roots = { root: path.join(stage, "root"), data: path.join(stage, "data") };
fs.mkdirSync(roots.root, { recursive: true });
fs.mkdirSync(roots.data, { recursive: true });
for (const n of fs.readdirSync(SRC_ROOT)) if (ROOT_FILES(n) && fs.statSync(path.join(SRC_ROOT, n)).isFile()) fs.copyFileSync(path.join(SRC_ROOT, n), path.join(roots.root, n));
for (const n of DATA_KEEP) { const s = path.join(SRC_DATA, n); if (fs.existsSync(s)) fs.cpSync(s, path.join(roots.data, n), { recursive: true }); }
// hw.db: a consistent single-file copy (no -wal/-shm), which is what the hosted app expects.
if (fs.existsSync(path.join(SRC_DATA, "hw.db"))) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(SRC_DATA, "hw.db"), { readOnly: true });
  db.exec(`VACUUM INTO '${path.join(roots.data, "hw.db").replace(/'/g, "''")}'`);
  db.close();
}

const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? walk(f) : files.push(f); } };
walk(stage);
const bytes = files.reduce((a, f) => a + fs.statSync(f).size, 0);
console.log(`${files.length} files, ${(bytes / 1024).toFixed(0)} KB -> ${base}/`);
for (const f of files) console.log("  " + path.relative(stage, f));

const store = blobStore();
const existing = await store.list(`${base}/`);
if (existing.length) { console.error(`${base}/ already holds ${existing.length} blobs; not overwriting.`); process.exit(1); }
if (!go) { console.log("Dry run. Add --yes to upload."); process.exit(0); }
await createMirror({ roots, store, base }).push();
console.log(`uploaded; ${(await store.list(`${base}/`)).length} blobs under ${base}/`);
fs.rmSync(stage, { recursive: true, force: true });
