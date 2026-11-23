// One-time migration from the v0 files to hw.db. Idempotent: does nothing once a curriculum exists.
//
//   1. curriculum wu-algebra-1 v1 from wu_dag.json + wu_methods_dag.json + curriculum_ladder.md (+ covers from the last guess)
//   2. a student (HW_STUDENT or "Student 1") enrolled at v1
//   3. dag_state.json -> guess_run + guess events; overrides -> teacher events (original times)
//   4. corpus/problems.jsonl -> problem, free_tag, problem_tag at v1
//   5. weeks/*.json + each problem's usedOn dates -> assignment + assignment_item (dates without a week: legacy)
//   6. data/backups/weekly_status.*.md + weekly_status.md -> status_revision
//   7. the replaced files move to data/legacy-v0/ (the DAG JSON stays: it is tracked in git and the import input)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tx, now, J, setSetting } from "./db.mjs";
import * as C from "./curriculum.mjs";
import { addStudent, enroll, saveGuessRun, recordEvent } from "./progress.mjs";
import { parseLadder, lineDiff } from "./lessonplan.mjs";

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CURRICULUM = { id: "wu-algebra-1", title: "Wu Algebra 1" };
export const repoRoot = () => (process.env.HW_ROOT ? path.resolve(process.env.HW_ROOT) : path.resolve(UI_DIR, ".."));

const readText = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null);
const readJson = (f, d = null) => { const t = readText(f); if (t == null) return d; try { return JSON.parse(t); } catch { return d; } };
export const readJsonl = (f) => (readText(f) || "").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const dateOf = (name) => { const m = String(name || "").match(/(\d{1,2})[_-](\d{1,2})[_-](\d{4})/); return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null; };
const emptyGraph = { nodes: [], edges: [] };

export const needsMigration = (db) => !db.prepare("SELECT 1 FROM curriculum LIMIT 1").get();

// data: the data dir (hw.db lives here). root: where curriculum_ladder.md, weekly_status.md and the .tex files are.
export function migrateV1(db, { data, root = repoRoot(), student = process.env.HW_STUDENT || "Student 1", move = true, log = () => {} } = {}) {
  if (!needsMigration(db)) return { skipped: true };
  const dagFile = (f) => [path.join(data, f), path.join(UI_DIR, "data", f)].find((x) => fs.existsSync(x));
  const content = readJson(dagFile("wu_dag.json"), emptyGraph), methods = readJson(dagFile("wu_methods_dag.json"), emptyGraph);
  const ladder = readText(path.join(root, "curriculum_ladder.md")) || "";
  const st = readJson(path.join(data, "dag_state.json"), { guess: null, overrides: {} });
  const corpusFile = path.join(data, "corpus", "problems.jsonl");
  const problems = readJsonl(corpusFile);
  const report = { ladderDiff: [], content: content.nodes.length, methods: methods.nodes.length, units: 0, problems: 0, tagsDropped: 0, assignments: 0, items: 0, statusRevisions: 0, guessRuns: 0, overrides: 0 };

  const result = tx(db, () => {
    // 1. curriculum v1
    C.ensureCurriculum(db, CURRICULUM.id, CURRICULUM.title);
    const v = C.createDraft(db, CURRICULUM.id, { origin: "migration", note: "Imported from the v0 files" });
    C.writeGraph(db, v, "content", content);
    C.writeGraph(db, v, "methods", methods);
    const plan = parseLadder(ladder);
    C.writePlan(db, v, plan, { covers: st.guess?.ladderToWu || {} });
    report.units = plan.units.length;
    report.ladderDiff = lineDiff(ladder, C.ladderFor(db, v));
    C.publish(db, v);
    const keys = C.keysOf(db, v);

    // 2. student + enrollment
    const sid = addStudent(db, student);
    const enr = enroll(db, sid, CURRICULUM.id, v);
    setSetting(db, "active_enrollment", enr);

    // 3. guesses and overrides
    const runs = st.runs?.length ? st.runs : st.guess ? [{ id: `${Date.parse(st.guess.at) || 0}`, at: st.guess.at, model: st.guess.model, ok: true, files: st.guess.files, usage: st.guess.usage || null, summary: st.guess.summary || "", nodes: st.guess.nodes, ladderToWu: st.guess.ladderToWu || {}, log: [] }] : [];
    for (const r of [...runs].sort((a, b) => String(a.at).localeCompare(String(b.at)))) { saveGuessRun(db, enr, { ...r, versionId: v }); report.guessRuns++; }
    for (const [key, o] of Object.entries(st.overrides || {}).sort((a, b) => String(a[1].at).localeCompare(String(b[1].at)))) {
      if (!keys.has(key)) continue;
      recordEvent(db, enr, { key, versionId: v, state: o.state, note: o.note || "", source: "teacher", at: o.at || now() });
      report.overrides++;
    }

    // 4. problems
    const at = now();
    const insP = db.prepare("INSERT OR IGNORE INTO problem(id, tex, answer, context, source_json, status, cas_verified, aliases_json, added_at, ord) VALUES (?,?,?,?,?,?,?,?,?,?)");
    const insF = db.prepare("INSERT OR IGNORE INTO free_tag(problem_id, pos, tag) VALUES (?,?,?)");
    const insT = db.prepare("INSERT OR IGNORE INTO problem_tag(problem_id, node_key, version_id, pos, source, at) VALUES (?,?,?,?, 'migration', ?)");
    problems.forEach((p, ord) => {
      const status = ["candidate", "used", "favorite", "rejected"].includes(p.status) ? p.status : "candidate";
      insP.run(p.id, p.tex, p.answer || "", p.context || "", J(p.source || {}), status, p.casVerified ? 1 : 0, J(p.aliases || []), p.addedAt || at, ord);
      (p.tags || []).forEach((t, i) => insF.run(p.id, i, t));
      [...(p.units || []), ...(p.wuNodes || [])].forEach((k, i) => { if (keys.has(k)) insT.run(p.id, k, v, i, at); else report.tagsDropped++; });
      report.problems++;
    });

    // 5. assignments: one per week (dated by its saved .tex), then one legacy set per remaining usedOn date
    const weeksDir = path.join(data, "weeks");
    const weeks = fs.existsSync(weeksDir) ? fs.readdirSync(weeksDir).filter((f) => /\.json$/.test(f)).sort() : [];
    const byDate = new Map();
    const insA = db.prepare("INSERT OR IGNORE INTO assignment(id, enrollment_id, version_id, title, date, model, session_id, done, saved_as, transcript_path, legacy, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const f of weeks) {
      const w = readJson(path.join(weeksDir, f));
      if (!w?.id) continue;
      const date = dateOf(w.savedAs) || dateOf(w.id);
      insA.run(w.id, enr, v, w.title || w.id, date, w.model || null, w.sessionId || null, w.done ? 1 : 0, w.savedAs || null, `weeks/${f}`, 0, w.createdAt || at);
      if (date && !byDate.has(date)) byDate.set(date, w.id);
      report.assignments++;
    }
    const texAt = new Map(fs.existsSync(root) ? fs.readdirSync(root).filter((f) => /\.tex$/i.test(f)).map((f) => [dateOf(f), f]) : []);
    const insI = db.prepare("INSERT INTO assignment_item(assignment_id, pos, problem_id, answer, source_ref, cas_verified) VALUES (?,?,?,?,?,?)");
    const pos = new Map();
    for (const p of problems) for (const d of [...new Set(p.usedOn || [])].sort()) {
      let a = byDate.get(d);
      if (!a) {
        a = `legacy-${d}`;
        insA.run(a, enr, v, texAt.get(d) || `Homework ${d}`, d, null, null, 1, texAt.get(d) || null, null, 1, `${d}T00:00:00.000Z`);
        byDate.set(d, a); report.assignments++;
      }
      const n = pos.get(a) || 0; pos.set(a, n + 1);
      insI.run(a, n, p.id, p.answer || null, p.source?.file || null, p.casVerified ? 1 : 0);
      report.items++;
    }

    // 6. status history
    const backups = path.join(data, "backups");
    const revs = (fs.existsSync(backups) ? fs.readdirSync(backups) : []).filter((f) => /^weekly_status\..+\.md$/.test(f)).sort()
      .map((f) => ({ text: readText(path.join(backups, f)), at: f.replace(/^weekly_status\.|\.md$/g, "").replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z/, "T$1:$2:$3.$4Z"), source: "file" }));
    const statusFile = path.join(root, "weekly_status.md");
    const cur = readText(statusFile);
    if (cur != null) revs.push({ text: cur, at: fs.statSync(statusFile).mtime.toISOString(), source: "migration" });
    let last = null;
    for (const r of revs) { if (r.text === last) continue; db.prepare("INSERT INTO status_revision(enrollment_id, text, source, at) VALUES (?,?,?,?)").run(enr, r.text, r.source, r.at); last = r.text; report.statusRevisions++; }

    return { version: v, enrollment: enr };
  });

  C.exportVersion(db, result.version, path.join(data, "curricula"));
  // 7. keep the replaced files, out of the way
  if (move) {
    const legacy = path.join(data, "legacy-v0");
    for (const f of ["corpus/problems.jsonl", "dag_state.json", "backups"]) {
      const src = path.join(data, f);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(legacy, f);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
    }
  }
  log(`migrated to hw.db: ${report.content} content + ${report.methods} methods nodes, ${report.units} units, ${report.problems} problems, ${report.assignments} assignments (${report.items} items), ${report.statusRevisions} status revisions${report.ladderDiff.length ? `; ladder round-trip differs on ${report.ladderDiff.length} lines` : ""}`);
  return { ...result, report };
}
