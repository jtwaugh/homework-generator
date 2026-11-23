// The app's database: ui/data/hw.db (SQLite through node:sqlite, no dependencies). One file holds the
// curricula and their versions (content DAG, methods DAG, lesson plan), students, enrollments, progress,
// the shared problem corpus and homework history. Week transcripts stay in data/weeks/<id>.json.
//
// Ontology in one paragraph: a node KEY (e26, m:e5, U05) is the stable identity of a concept; a node REVISION
// is what it looks like in one curriculum version. Everything that points at the curriculum (problem tags,
// progress events, assignments) stores key + the version it was made against, and is read in a newer version
// through LINEAGE (merged / split / replaced / retired). Published versions are immutable.
//
//   openDb(dir?)   -> DatabaseSync (cached per file), schema migrated to the latest user_version
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// node:sqlite prints an ExperimentalWarning on import (Node 22). Silence just that one.
const emit = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  const msg = typeof w === "string" ? w : w?.message;
  if (/SQLite is an experimental feature/.test(msg || "")) return;
  return emit.call(process, w, ...rest);
};
const { DatabaseSync } = await import("node:sqlite");
process.emitWarning = emit;

export const dataDir = () => process.env.HW_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
export const dbFile = (dir = dataDir()) => path.join(dir, "hw.db");

const MIGRATIONS = [
  // 1: the whole ontology
  `
  CREATE TABLE curriculum (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE curriculum_version (
    id INTEGER PRIMARY KEY, curriculum_id TEXT NOT NULL REFERENCES curriculum(id),
    seq INTEGER NOT NULL, parent_id INTEGER REFERENCES curriculum_version(id),
    status TEXT NOT NULL CHECK (status IN ('draft','published')),
    origin TEXT NOT NULL CHECK (origin IN ('import','edit','migration')),
    note TEXT NOT NULL DEFAULT '', plan_text TEXT NOT NULL DEFAULT '',
    meta_json TEXT NOT NULL DEFAULT '{}',               -- per-layer headers (source, importedAt, texts), plan layout
    created_at TEXT NOT NULL, published_at TEXT,
    UNIQUE (curriculum_id, seq)
  );
  CREATE UNIQUE INDEX one_draft_per_curriculum ON curriculum_version(curriculum_id) WHERE status = 'draft';

  CREATE TABLE node (
    curriculum_id TEXT NOT NULL REFERENCES curriculum(id), key TEXT NOT NULL,
    layer TEXT NOT NULL CHECK (layer IN ('content','methods','unit')),
    created_in_version INTEGER NOT NULL REFERENCES curriculum_version(id),
    PRIMARY KEY (curriculum_id, key)
  );
  CREATE TABLE node_revision (
    version_id INTEGER NOT NULL REFERENCES curriculum_version(id) ON DELETE CASCADE, node_key TEXT NOT NULL,
    layer TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '',
    x REAL, y REAL, w REAL, h REAL,
    extra_json TEXT NOT NULL DEFAULT '{}',              -- sections, restsOn, unit block/stance/notes, ...
    external_ref TEXT,                                  -- whiteboard element id; only for matching imports
    PRIMARY KEY (version_id, node_key)
  );
  CREATE TABLE edge (
    version_id INTEGER NOT NULL REFERENCES curriculum_version(id) ON DELETE CASCADE, ord INTEGER NOT NULL DEFAULT 0,
    from_key TEXT NOT NULL, to_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('uses','uses_to_prove','rests_on','needs','covers')),
    extra_json TEXT NOT NULL DEFAULT '{}',              -- bends
    PRIMARY KEY (version_id, from_key, to_key, kind)
  );
  CREATE TABLE gated_term (
    version_id INTEGER NOT NULL REFERENCES curriculum_version(id) ON DELETE CASCADE,
    grp INTEGER NOT NULL, pos INTEGER NOT NULL, term TEXT NOT NULL, unit_key TEXT NOT NULL,
    PRIMARY KEY (version_id, grp, pos)
  );
  CREATE TABLE lineage (
    curriculum_id TEXT NOT NULL REFERENCES curriculum(id),
    from_version INTEGER NOT NULL REFERENCES curriculum_version(id),
    to_version INTEGER NOT NULL REFERENCES curriculum_version(id) ON DELETE CASCADE,
    old_key TEXT NOT NULL, new_key TEXT,
    relation TEXT NOT NULL CHECK (relation IN ('merged','split','replaced','retired')),
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX lineage_by_old ON lineage(curriculum_id, old_key);

  CREATE TABLE student (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE enrollment (
    id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES student(id),
    curriculum_id TEXT NOT NULL REFERENCES curriculum(id), version_id INTEGER NOT NULL REFERENCES curriculum_version(id),
    started_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','finished')),
    UNIQUE (student_id, curriculum_id)
  );
  CREATE TABLE guess_run (
    id TEXT PRIMARY KEY, enrollment_id INTEGER NOT NULL REFERENCES enrollment(id),
    version_id INTEGER NOT NULL REFERENCES curriculum_version(id),
    at TEXT NOT NULL, model TEXT, ok INTEGER NOT NULL, error TEXT, summary TEXT NOT NULL DEFAULT '',
    cost_usd REAL NOT NULL DEFAULT 0, files INTEGER, ms INTEGER,
    usage_json TEXT, nodes_json TEXT, ladder_to_wu_json TEXT, log_json TEXT
  );
  CREATE TABLE progress_event (
    id INTEGER PRIMARY KEY, enrollment_id INTEGER NOT NULL REFERENCES enrollment(id),
    node_key TEXT NOT NULL, version_id INTEGER NOT NULL REFERENCES curriculum_version(id),
    state TEXT NOT NULL CHECK (state IN ('done','partial','not-yet','cleared')),
    confidence REAL, source TEXT NOT NULL CHECK (source IN ('teacher','guess','lineage')),
    guess_run_id TEXT REFERENCES guess_run(id), note TEXT NOT NULL DEFAULT '', evidence_json TEXT,
    flagged INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL
  );
  CREATE INDEX progress_by_enrollment ON progress_event(enrollment_id, node_key, at);
  CREATE TABLE status_revision (
    id INTEGER PRIMARY KEY, enrollment_id INTEGER NOT NULL REFERENCES enrollment(id), text TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('teacher','claude','migration','file')),
    assignment_id TEXT, at TEXT NOT NULL
  );

  CREATE TABLE problem (
    id TEXT PRIMARY KEY, tex TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', context TEXT NOT NULL DEFAULT '',
    source_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL CHECK (status IN ('candidate','used','favorite','rejected')),
    cas_verified INTEGER NOT NULL DEFAULT 0, aliases_json TEXT NOT NULL DEFAULT '[]', added_at TEXT NOT NULL,
    ord INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE free_tag (
    problem_id TEXT NOT NULL REFERENCES problem(id) ON DELETE CASCADE, pos INTEGER NOT NULL, tag TEXT NOT NULL,
    PRIMARY KEY (problem_id, tag)
  );
  CREATE TABLE problem_tag (
    problem_id TEXT NOT NULL REFERENCES problem(id) ON DELETE CASCADE, node_key TEXT NOT NULL,
    version_id INTEGER NOT NULL REFERENCES curriculum_version(id), pos INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL CHECK (source IN ('tagger','claude','teacher','manifest','lineage','migration')),
    at TEXT NOT NULL,
    PRIMARY KEY (problem_id, version_id, node_key)
  );
  CREATE TABLE retag_queue (
    problem_id TEXT NOT NULL REFERENCES problem(id) ON DELETE CASCADE,
    version_id INTEGER NOT NULL REFERENCES curriculum_version(id), node_key TEXT NOT NULL,
    reason TEXT NOT NULL, candidates_json TEXT NOT NULL DEFAULT '[]', at TEXT NOT NULL, done_at TEXT,
    PRIMARY KEY (problem_id, version_id, node_key)
  );

  CREATE TABLE assignment (
    id TEXT PRIMARY KEY, enrollment_id INTEGER NOT NULL REFERENCES enrollment(id),
    version_id INTEGER NOT NULL REFERENCES curriculum_version(id),
    title TEXT NOT NULL DEFAULT '', date TEXT, model TEXT, session_id TEXT, done INTEGER NOT NULL DEFAULT 0,
    saved_as TEXT, transcript_path TEXT, legacy INTEGER NOT NULL DEFAULT 0,
    status_before_id INTEGER REFERENCES status_revision(id), status_after_id INTEGER REFERENCES status_revision(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE assignment_item (
    assignment_id TEXT NOT NULL REFERENCES assignment(id) ON DELETE CASCADE, pos INTEGER NOT NULL,
    part TEXT, n INTEGER, problem_id TEXT NOT NULL REFERENCES problem(id),
    answer TEXT, source_ref TEXT, cas_verified INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (assignment_id, pos)
  );
  CREATE INDEX item_by_problem ON assignment_item(problem_id);

  CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

const open = new Map();

// Opens the database in `dir` and applies schema migrations; one cached connection per file. Filling a fresh
// database from the v0 files is lib/migrate.mjs (lib/store.mjs runs it on first open).
// Hosted (Vercel), hw.db is mirrored to Blob as one file, so it uses a rollback journal instead of WAL.
const JOURNAL = process.env.HW_DB_JOURNAL || (process.env.VERCEL ? "DELETE" : "WAL");
export function openDb(dir = dataDir(), { memory = false } = {}) {
  const file = memory ? ":memory:" : dbFile(dir);
  if (!memory && open.has(file)) return open.get(file);
  if (!memory) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = ${JOURNAL}; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`);
  const v = db.prepare("PRAGMA user_version").get().user_version;
  for (let i = v; i < MIGRATIONS.length; i++) {
    tx(db, () => { db.exec(MIGRATIONS[i]); db.exec(`PRAGMA user_version = ${i + 1}`); });
  }
  if (!memory) open.set(file, db);
  return db;
}

export function closeDb(dir = dataDir()) {
  const file = dbFile(dir);
  open.get(file)?.close();
  open.delete(file);
}

// Run fn inside a transaction (nested calls join the outer one).
const depth = new WeakMap();
export function tx(db, fn) {
  const d = depth.get(db) || 0;
  if (d) { depth.set(db, d + 1); try { return fn(); } finally { depth.set(db, d); } }
  db.exec("BEGIN IMMEDIATE");
  depth.set(db, 1);
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
  finally { depth.set(db, 0); }
}

export const now = () => new Date().toISOString();
export const J = (x) => JSON.stringify(x ?? null);
export const P = (s, dflt = null) => { if (s == null) return dflt; try { return JSON.parse(s); } catch { return dflt; } };

export function getSetting(db, key, dflt = null) { return db.prepare("SELECT value FROM setting WHERE key = ?").get(key)?.value ?? dflt; }
export function setSetting(db, key, value) { db.prepare("INSERT INTO setting(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value)); }
