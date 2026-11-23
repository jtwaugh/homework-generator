// The app's working context (db, active enrollment, its version) and the DB-backed corpus.
//
//   ctx()  -> {db, dir, enrollmentId, versionId, curriculumId, studentName}
//   The active enrollment: HW_ENROLLMENT, else the "active_enrollment" setting, else the first one.
//   A data dir with no curriculum yet is migrated from the v0 files on first open.
import { openDb, dataDir, tx, now, J, P, getSetting, setSetting } from "./db.mjs";
import { needsMigration, migrateV1 } from "./migrate.mjs";
import { lineageIndex, baseTags, layerOfKey, getVersion } from "./curriculum.mjs";

export function ctx({ dir = dataDir(), enrollment = null } = {}) {
  const db = openDb(dir);
  if (needsMigration(db)) migrateV1(db, { data: dir, log: (m) => console.error(`[store] ${m}`) });
  const want = enrollment ?? process.env.HW_ENROLLMENT ?? getSetting(db, "active_enrollment");
  const e = (want && db.prepare("SELECT * FROM enrollment WHERE id = ?").get(Number(want))) || db.prepare("SELECT * FROM enrollment ORDER BY id LIMIT 1").get();
  if (!e) throw new Error("no enrollment in hw.db");
  const s = db.prepare("SELECT name FROM student WHERE id = ?").get(e.student_id);
  return { db, dir, enrollmentId: e.id, versionId: e.version_id, curriculumId: e.curriculum_id, studentName: s?.name || "" };
}
export function setActiveEnrollment(db, id) { setSetting(db, "active_enrollment", id); }

// ---------- corpus ----------

// Item shape as in the v0 jsonl: {id, tex, answer, units, wuNodes, tags, context, source, status, usedOn, casVerified, addedAt, aliases?}
//   units/wuNodes: the problem's own tags resolved to the active version. taggedIn (a version seq) is set when
//   some of those tags name nodes the active version no longer has; needsRetag when one can't be resolved.
//   usedOn: dates of this enrollment's assignments that contain the problem.
export function loadCorpusDb(c = ctx()) {
  const { db } = c;
  const idx = lineageIndex(db, c.curriculumId);
  const free = new Map();
  for (const r of db.prepare("SELECT problem_id, tag FROM free_tag ORDER BY problem_id, pos").all()) { if (!free.has(r.problem_id)) free.set(r.problem_id, []); free.get(r.problem_id).push(r.tag); }
  const used = new Map();
  for (const r of db.prepare("SELECT DISTINCT i.problem_id, a.date FROM assignment_item i JOIN assignment a ON a.id = i.assignment_id WHERE a.enrollment_id = ? AND a.date IS NOT NULL ORDER BY a.date").all(c.enrollmentId)) {
    if (!used.has(r.problem_id)) used.set(r.problem_id, []); used.get(r.problem_id).push(r.date);
  }
  const tagged = new Set(db.prepare("SELECT DISTINCT problem_id FROM problem_tag").all().map((r) => r.problem_id));
  const queued = new Set(db.prepare("SELECT DISTINCT problem_id FROM retag_queue WHERE done_at IS NULL AND version_id = ?").all(c.versionId).map((r) => r.problem_id));
  return db.prepare("SELECT * FROM problem ORDER BY ord, added_at").all().map((r) => {
    const units = [], wuNodes = [];
    let taggedIn = null; // set only when some tag had to be read forward (its key is gone in the active version)
    if (tagged.has(r.id)) {
      const base = baseTags(db, c.curriculumId, r.id, idx, c.versionId);
      if (base) {
        for (const k of base.keys) {
          const res = idx.resolve(k, base.version, c.versionId);
          if (res.status !== "current") taggedIn = base.version;
          if (res.keys.length !== 1) continue;
          const key = res.keys[0];
          const list = layerOfKey(key) === "unit" ? units : wuNodes;
          if (!list.includes(key)) list.push(key);
        }
      }
    }
    const p = {
      id: r.id, tex: r.tex, answer: r.answer, units, wuNodes, tags: free.get(r.id) || [], context: r.context,
      source: P(r.source_json, {}), status: r.status, usedOn: used.get(r.id) || [], casVerified: !!r.cas_verified, addedAt: r.added_at,
    };
    const aliases = P(r.aliases_json, []);
    if (aliases.length) p.aliases = aliases;
    if (taggedIn != null && taggedIn !== c.versionId) p.taggedIn = getVersion(db, taggedIn)?.seq;
    if (queued.has(r.id)) p.needsRetag = true;
    return p;
  });
}

// Writes items back. Tags that changed become a new tag set at the active version; usedOn dates this
// enrollment has no assignment for go into a legacy assignment for that date.
export function saveCorpusDb(items, c = ctx(), { source = "claude" } = {}) {
  const { db } = c;
  const before = new Map(loadCorpusDb(c).map((p) => [p.id, p]));
  const at = now();
  const valid = lineageIndex(db, c.curriculumId).keys.get(c.versionId);
  tx(db, () => {
    const upP = db.prepare(`INSERT INTO problem(id, tex, answer, context, source_json, status, cas_verified, aliases_json, added_at, ord) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET tex = excluded.tex, answer = excluded.answer, context = excluded.context, source_json = excluded.source_json, status = excluded.status,
        cas_verified = excluded.cas_verified, aliases_json = excluded.aliases_json, ord = excluded.ord`);
    items.forEach((p, ord) => {
      const status = ["candidate", "used", "favorite", "rejected"].includes(p.status) ? p.status : "candidate";
      upP.run(p.id, p.tex, p.answer || "", p.context || "", J(p.source || {}), status, p.casVerified ? 1 : 0, J(p.aliases || []), p.addedAt || at, ord);
      const old = before.get(p.id);
      if (J(old?.tags || []) !== J(p.tags || [])) {
        db.prepare("DELETE FROM free_tag WHERE problem_id = ?").run(p.id);
        [...new Set(p.tags || [])].forEach((t, i) => db.prepare("INSERT INTO free_tag(problem_id, pos, tag) VALUES (?,?,?)").run(p.id, i, t));
      }
      const keys = [...(p.units || []), ...(p.wuNodes || [])].filter((k) => valid.has(k));
      if (J([...(old?.units || []), ...(old?.wuNodes || [])]) !== J(keys) || (old?.needsRetag && keys.length)) {
        db.prepare("DELETE FROM problem_tag WHERE problem_id = ? AND version_id = ?").run(p.id, c.versionId);
        [...new Set(keys)].forEach((k, i) => db.prepare("INSERT INTO problem_tag(problem_id, node_key, version_id, pos, source, at) VALUES (?,?,?,?,?,?)").run(p.id, k, c.versionId, i, source, at));
        db.prepare("UPDATE retag_queue SET done_at = ? WHERE problem_id = ? AND version_id = ? AND done_at IS NULL").run(at, p.id, c.versionId);
      }
      for (const d of p.usedOn || []) if (!(old?.usedOn || []).includes(d)) addLegacyUse(db, c, p, d);
    });
  });
}

function addLegacyUse(db, c, p, date) {
  const have = db.prepare("SELECT 1 FROM assignment_item i JOIN assignment a ON a.id = i.assignment_id WHERE a.enrollment_id = ? AND a.date = ? AND i.problem_id = ?").get(c.enrollmentId, date, p.id);
  if (have) return;
  const a = db.prepare("SELECT id FROM assignment WHERE enrollment_id = ? AND date = ? ORDER BY legacy LIMIT 1").get(c.enrollmentId, date)?.id || `legacy-${c.enrollmentId}-${date}`;
  db.prepare("INSERT OR IGNORE INTO assignment(id, enrollment_id, version_id, title, date, done, legacy, created_at) VALUES (?,?,?,?,?,1,1,?)").run(a, c.enrollmentId, c.versionId, `Homework ${date}`, date, now());
  const pos = (db.prepare("SELECT MAX(pos) m FROM assignment_item WHERE assignment_id = ?").get(a).m ?? -1) + 1;
  db.prepare("INSERT INTO assignment_item(assignment_id, pos, problem_id, answer, source_ref, cas_verified) VALUES (?,?,?,?,?,?)").run(a, pos, p.id, p.answer || null, p.source?.file || null, p.casVerified ? 1 : 0);
}

// Record one homework set's problems for this enrollment (replaces the set's previous items).
export function recordAssignment(c, { id, title, date, model, sessionId, savedAs, transcriptPath, items }) {
  const { db } = c;
  tx(db, () => {
    db.prepare(`INSERT INTO assignment(id, enrollment_id, version_id, title, date, model, session_id, done, saved_as, transcript_path, legacy, created_at) VALUES (?,?,?,?,?,?,?,1,?,?,0,?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, date = excluded.date, model = excluded.model, done = 1, saved_as = excluded.saved_as, version_id = excluded.version_id`)
      .run(id, c.enrollmentId, c.versionId, title || id, date || null, model || null, sessionId || null, savedAs || null, transcriptPath || null, now());
    db.prepare("DELETE FROM assignment_item WHERE assignment_id = ?").run(id);
    items.forEach((it, pos) => db.prepare("INSERT INTO assignment_item(assignment_id, pos, part, n, problem_id, answer, source_ref, cas_verified) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, pos, it.part != null ? String(it.part) : null, it.n ?? null, it.problemId, it.answer || null, it.sourceRef || null, it.casVerified ? 1 : 0));
  });
}

// ---------- weekly status ----------

export const latestStatus = (c) => c.db.prepare("SELECT * FROM status_revision WHERE enrollment_id = ? ORDER BY at DESC, id DESC LIMIT 1").get(c.enrollmentId);
export function saveStatus(c, text, { source = "teacher", assignmentId = null } = {}) {
  if (latestStatus(c)?.text === text) return latestStatus(c).id;
  return Number(c.db.prepare("INSERT INTO status_revision(enrollment_id, text, source, assignment_id, at) VALUES (?,?,?,?,?)").run(c.enrollmentId, text, source, assignmentId, now()).lastInsertRowid);
}
export const statusHistory = (c, limit = 50) => c.db.prepare("SELECT id, source, assignment_id, at, length(text) chars FROM status_revision WHERE enrollment_id = ? ORDER BY at DESC, id DESC LIMIT ?").all(c.enrollmentId, limit);
