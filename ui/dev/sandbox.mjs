#!/usr/bin/env node
// Make a throwaway copy of the app's files so tests can click everything (save status, star problems,
// upload notes, delete weeks, run Claude) without touching the real ones.
//
//   node ui/dev/sandbox.mjs [dir]   → prints the dir; then run the server against it:
//   HW_ROOT=<dir>/root HW_DATA=<dir>/data PORT=4757 node ui/server.mjs
//
// Copies: the project's top-level .md/.tex files, and from ui/data the corpus, the two DAGs, weeks,
// notes and dag_state.json. The Python venv is symlinked (read-only use). Delete the dir when done.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.join(UI, "..");
const DATA = path.join(UI, "data");

export function makeSandbox(dir = fs.mkdtempSync(path.join(os.tmpdir(), "hw-sandbox-"))) {
  const root = path.join(dir, "root"), data = path.join(dir, "data");
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(data, { recursive: true });
  for (const f of fs.readdirSync(ROOT)) if (/\.(md|tex)$/i.test(f)) fs.copyFileSync(path.join(ROOT, f), path.join(root, f));
  for (const f of ["corpus", "weeks", "notes", "wu_dag.json", "wu_methods_dag.json", "dag_state.json"]) {
    const src = path.join(DATA, f);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(data, f), { recursive: true });
  }
  if (fs.existsSync(path.join(DATA, "venv"))) fs.symlinkSync(path.join(DATA, "venv"), path.join(data, "venv"));
  return { dir, root, data };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(makeSandbox(process.argv[2]).dir);
}
