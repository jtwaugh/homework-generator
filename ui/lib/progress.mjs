// A student's progress through a curriculum: append-only events per enrollment, read at a version.
//
// Current state of a key = the latest teacher event (unless it is "cleared"), else the latest guess/lineage event.
// Events made against older versions are carried forward through lineage, so nothing is rewritten.
import { tx, now, J, P } from "./db.mjs";
import { lineageIndex, keysOf, coversFor, getVersion } from "./curriculum.mjs";

export const STATES = ["done", "partial", "not-yet"];
const RANK = { "not-yet": 0, partial: 1, done: 2 };

export const getEnrollment = (db, id) => db.prepare("SELECT e.*, s.name student_name FROM enrollment e JOIN student s ON s.id = e.student_id WHERE e.id = ?").get(id);
export const listEnrollments = (db) => db.prepare("SELECT e.*, s.name student_name, c.title curriculum_title, cv.seq version_seq FROM enrollment e JOIN student s ON s.id = e.student_id JOIN curriculum c ON c.id = e.curriculum_id JOIN curriculum_version cv ON cv.id = e.version_id ORDER BY s.name, c.title").all();
export const listStudents = (db) => db.prepare("SELECT * FROM student ORDER BY archived, name").all();

export function addStudent(db, name) {
  return Number(db.prepare("INSERT INTO student(name, created_at, archived) VALUES (?, ?, 0)").run(String(name).trim(), now()).lastInsertRowid);
}
export function enroll(db, studentId, curriculumId, versionId) {
  db.prepare("INSERT INTO enrollment(student_id, curriculum_id, version_id, started_at, status) VALUES (?,?,?,?, 'active') ON CONFLICT(student_id, curriculum_id) DO NOTHING").run(studentId, curriculumId, versionId, now());
  return db.prepare("SELECT id FROM enrollment WHERE student_id = ? AND curriculum_id = ?").get(studentId, curriculumId).id;
}

// ---------- a student's courses ----------
// Every student is in every course; the enrollment row (their progress, status record and homework in it) is
// made the first time the app works on that pair. "taking" is the teacher's flag: is the student doing it now.

export function setTaking(db, studentId, curriculumId, taking) {
  db.prepare("INSERT INTO student_course(student_id, curriculum_id, taking, at) VALUES (?,?,?,?) ON CONFLICT(student_id, curriculum_id) DO UPDATE SET taking = excluded.taking, at = excluded.at")
    .run(studentId, curriculumId, taking ? 1 : 0, now());
}

// [{id, title, taking, enrollment: {id, version_seq} | null, published: latest published seq | null, draft: bool}]
// for every course, the ones being taken first.
export function studentCourses(db, studentId) {
  const rows = db.prepare(`SELECT c.id, c.title, COALESCE(sc.taking, 0) taking, e.id enrollment_id, ev.seq enrolled_seq,
      (SELECT MAX(seq) FROM curriculum_version WHERE curriculum_id = c.id AND status = 'published') published,
      EXISTS (SELECT 1 FROM curriculum_version WHERE curriculum_id = c.id AND status = 'draft') draft
    FROM curriculum c
    LEFT JOIN student_course sc ON sc.curriculum_id = c.id AND sc.student_id = ?
    LEFT JOIN enrollment e ON e.curriculum_id = c.id AND e.student_id = ?
    LEFT JOIN curriculum_version ev ON ev.id = e.version_id
    ORDER BY COALESCE(sc.taking, 0) DESC, c.created_at`).all(studentId, studentId);
  return rows.map((r) => ({ id: r.id, title: r.title, taking: !!r.taking, enrollment: r.enrollment_id ? { id: r.enrollment_id, version_seq: r.enrolled_seq } : null, published: r.published ?? null, draft: !!r.draft }));
}

export function recordEvent(db, enrollmentId, ev) {
  const e = getEnrollment(db, enrollmentId);
  if (!e) throw new Error(`no enrollment ${enrollmentId}`);
  if (ev.state !== "cleared" && !STATES.includes(ev.state)) throw new Error(`bad state ${ev.state}`);
  db.prepare("INSERT INTO progress_event(enrollment_id, node_key, version_id, state, confidence, source, guess_run_id, note, evidence_json, flagged, at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(enrollmentId, ev.key, ev.versionId ?? e.version_id, ev.state, ev.confidence ?? null, ev.source, ev.guessRunId ?? null, ev.note ?? "", J(ev.evidence || []), ev.flagged ? 1 : 0, ev.at || now());
}

// {key: {state, confidence, evidence, note, at, source, flagged, fromKey}} for the keys present at versionId.
//   layers: which picture to build. "teacher" only, "machine" (guess + lineage) only, or both (default).
export function currentProgress(db, enrollmentId, versionId = null, { sources = null } = {}) {
  const e = getEnrollment(db, enrollmentId);
  const v = versionId ?? e.version_id;
  const idx = lineageIndex(db, e.curriculum_id);
  const have = idx.keys.get(v) || keysOf(db, v);
  const rows = db.prepare("SELECT * FROM progress_event WHERE enrollment_id = ? ORDER BY at, id").all(enrollmentId);
  const teacher = new Map(), machine = new Map();
  for (const r of rows) {
    if (sources && !sources.includes(r.source)) continue;
    const res = idx.resolve(r.node_key, r.version_id, v);
    if (res.keys.length !== 1) continue; // split or retired since: the upgrade wrote lineage events for these
    const key = res.keys[0];
    if (!have.has(key)) continue;
    const val = { state: r.state, confidence: r.confidence, evidence: P(r.evidence_json, []), note: r.note, at: r.at, source: r.source, flagged: !!r.flagged, ...(key !== r.node_key ? { fromKey: r.node_key } : {}) };
    // A teacher event on a key that has since merged away is history; the lineage event decides.
    (r.source === "teacher" && key === r.node_key ? teacher : machine).set(key, val);
  }
  const out = {};
  for (const [k, val] of machine) out[k] = val;
  for (const [k, val] of teacher) if (val.state === "cleared") { /* falls back to the machine state */ } else out[k] = val;
  return out;
}

// ---------- guess runs ----------

export function saveGuessRun(db, enrollmentId, run) {
  const e = getEnrollment(db, enrollmentId);
  const v = run.versionId ?? e.version_id;
  tx(db, () => {
    db.prepare("INSERT OR REPLACE INTO guess_run(id, enrollment_id, version_id, at, model, ok, error, summary, cost_usd, files, ms, usage_json, nodes_json, ladder_to_wu_json, log_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(String(run.id), enrollmentId, v, run.at, run.model || "", run.ok ? 1 : 0, run.error || null, run.summary || "", run.usage?.costUSD || 0, run.files ?? 0, run.ms ?? null, J(run.usage || null), J(run.nodes || null), J(run.ladderToWu || {}), J(run.log || []));
    if (!run.ok) return;
    const have = keysOf(db, v);
    for (const [key, n] of Object.entries(run.nodes || {})) {
      if (!have.has(key) || !STATES.includes(n?.state)) continue;
      recordEvent(db, enrollmentId, { key, versionId: v, state: n.state, confidence: n.confidence, evidence: n.evidence, source: "guess", guessRunId: String(run.id), at: run.at });
    }
  });
}

const runRow = (r) => r && { id: r.id, at: r.at, model: r.model, ok: !!r.ok, error: r.error || undefined, summary: r.summary, files: r.files, ms: r.ms, usage: P(r.usage_json, null), nodes: P(r.nodes_json, null), ladderToWu: P(r.ladder_to_wu_json, {}), log: P(r.log_json, []), versionId: r.version_id };
export const getRun = (db, id) => runRow(db.prepare("SELECT * FROM guess_run WHERE id = ?").get(String(id)));
export const listRuns = (db, enrollmentId, limit = 50) => db.prepare("SELECT * FROM guess_run WHERE enrollment_id = ? ORDER BY at DESC LIMIT ?").all(enrollmentId, limit).map(runRow);

// The old dag_state.json shape, so the DAG tab and prompts barely change:
//   guess.nodes = machine progress (guess + lineage) at the version; overrides = teacher events.
export function dagState(db, enrollmentId, versionId = null) {
  const e = getEnrollment(db, enrollmentId);
  const v = versionId ?? e.version_id;
  const runs = listRuns(db, enrollmentId);
  const last = runs.find((r) => r.ok);
  const machine = currentProgress(db, enrollmentId, v, { sources: ["guess", "lineage"] });
  const teacher = currentProgress(db, enrollmentId, v, { sources: ["teacher"] });
  const covers = coversFor(db, v);
  const guess = last || Object.keys(machine).length ? {
    at: last?.at, model: last?.model, summary: last?.summary || "", usage: last?.usage || null, files: last?.files, runId: last?.id,
    nodes: Object.fromEntries(Object.entries(machine).map(([k, x]) => [k, { state: x.state, confidence: x.confidence, evidence: x.evidence, ...(x.flagged ? { flagged: true } : {}), ...(x.fromKey ? { fromKey: x.fromKey } : {}) }])),
    ladderToWu: Object.keys(covers).length ? covers : last?.ladderToWu || {},
  } : null;
  const overrides = Object.fromEntries(Object.entries(teacher).map(([k, x]) => [k, { state: x.state, note: x.note || "", at: x.at }]));
  return { guess, overrides, runs };
}

// Teacher override (state null clears it).
export function setOverride(db, enrollmentId, key, state, note = "") {
  recordEvent(db, enrollmentId, { key, state: state == null ? "cleared" : state, note, source: "teacher" });
  return dagState(db, enrollmentId).overrides;
}

// ---------- upgrading an enrollment to a newer version ----------

// Persisting keys need nothing. Merged: the successor gets the least advanced predecessor state (including
// its own, if it persisted). Split: a new successor gets "partial", flagged for review; a successor that
// already existed keeps its own state (plus any merges into it). Retired: history only.
export function upgradeEnrollment(db, enrollmentId, toVersion) {
  const e = getEnrollment(db, enrollmentId);
  const from = e.version_id;
  if (from === toVersion) return { written: 0 };
  const to = getVersion(db, toVersion);
  if (to?.curriculum_id !== e.curriculum_id || to.status !== "published") throw new Error("upgrade target must be a published version of the same curriculum");
  const idx = lineageIndex(db, e.curriculum_id);
  if (idx.seq.get(toVersion) < idx.seq.get(from)) throw new Error("cannot downgrade an enrollment");
  const before = currentProgress(db, enrollmentId, from);
  const have = idx.keys.get(toVersion);
  const target = new Map(); // successor key -> {merged: [states], split: bool, from: [keys]}
  for (const [key, x] of Object.entries(before)) {
    const r = idx.resolve(key, from, toVersion);
    if (r.status === "current" || r.status === "retired") continue;
    for (const k of r.keys) {
      if (!target.has(k)) target.set(k, { merged: [], split: false, from: [] });
      const t = target.get(k);
      t.from.push(key);
      if (r.status === "ambiguous") t.split = true; else t.merged.push(x.state);
    }
  }
  let written = 0;
  tx(db, () => {
    for (const [k, t] of target) {
      if (!have.has(k)) continue;
      const own = before[k]?.state;
      const states = [...t.merged, ...(own ? [own] : [])];
      if (!states.length && !t.split) continue;
      const flagged = !states.length; // only split into it, nothing known: ask the teacher
      const state = flagged ? "partial" : states.reduce((a, b) => (RANK[b] < RANK[a] ? b : a));
      if (own && state === own && !t.merged.length) continue; // split into a key that keeps its own state
      recordEvent(db, enrollmentId, { key: k, versionId: toVersion, state, source: "lineage", flagged, note: `${t.split && !t.merged.length ? "split" : "merged"} from ${t.from.join(", ")}` });
      written++;
    }
    db.prepare("UPDATE enrollment SET version_id = ? WHERE id = ?").run(toVersion, enrollmentId);
  });
  return { written };
}
