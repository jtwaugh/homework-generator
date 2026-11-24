#!/usr/bin/env node
// Stage 6: load the merged Wu curricula into hw.db as drafts.
//
//   node ui/scripts/wu/load.mjs [--dry] [curriculum ...]        (HW_DATA=<dir> to load into a sandbox's data)
//
// Each curriculum is created if missing; both graphs go into its draft through importBoard, which keeps the key of
// every node it can match (by board id from an earlier load, then by title). So re-running after an edit to the
// chapter files updates the same draft, and wu-algebra-1's hand-drawn nodes keep their keys and problem tags where
// the extraction used their titles. Nothing is published: review each draft in the app (Courses) and publish there.
import fs from "node:fs";
import { openDb, dataDir } from "../../lib/db.mjs";
import * as C from "../../lib/curriculum.mjs";
import { p } from "./sources.mjs";
import { readJson } from "./claude.mjs";

const args = process.argv.slice(2), dry = args.includes("--dry");
const only = args.filter((a) => !a.startsWith("--"));
const split = readJson(p("split.json"));
const db = openDb(dataDir());
console.log(`hw.db in ${dataDir()}${dry ? " (dry run)" : ""}`);

// A course that already has a published version (wu-algebra-1's hand-drawn boards) was reviewed: an arrow there
// between two blocks the draft kept, with no path between them in the draft, goes back in rather than being lost.
function keepPublishedArrows(cur, draft) {
  const pub = C.latestPublished(db, cur);
  if (!pub) return { added: 0, skipped: [] };
  const KINDS = "kind IN ('uses','uses_to_prove','rests_on')";
  const edges = (v) => db.prepare(`SELECT from_key f, to_key t, kind, extra_json FROM edge WHERE version_id = ? AND ${KINDS}`).all(v);
  const have = new Set(db.prepare("SELECT node_key FROM node_revision WHERE version_id = ?").all(draft).map((r) => r.node_key));
  const out = new Map();
  const link = (a, b) => (out.get(a) || out.set(a, []).get(a)).push(b);
  for (const e of edges(draft)) link(e.f, e.t);
  const reach = (a, b) => { const seen = new Set([a]), st = [a]; while (st.length) { const x = st.pop(); if (x === b) return true; for (const y of out.get(x) || []) if (!seen.has(y)) { seen.add(y); st.push(y); } } return false; };
  const title = (k) => db.prepare("SELECT title FROM node_revision WHERE version_id = ? AND node_key = ?").get(draft, k)?.title || k;
  const ins = db.prepare("INSERT INTO edge (version_id, ord, from_key, to_key, kind, extra_json) VALUES (?, ?, ?, ?, ?, ?)");
  let added = 0; const skipped = [];
  for (const e of edges(pub.id)) {
    if (!have.has(e.f) || !have.has(e.t) || reach(e.f, e.t)) continue;
    if (reach(e.t, e.f)) { skipped.push(`${title(e.f)} -> ${title(e.t)}`); continue; }
    ins.run(draft, 1000 + added++, e.f, e.t, e.kind, e.extra_json); link(e.f, e.t);
  }
  return { added, skipped, from: pub.seq };
}

for (const c of split.curricula) {
  if (only.length && !only.includes(c.id)) continue;
  const content = readJson(p(c.id, "content.json")), methods = readJson(p(c.id, "methods.json"));
  if (!content || !methods) { console.log(`${c.id}: not merged yet`); continue; }
  const existed = !!db.prepare("SELECT 1 FROM curriculum WHERE id = ?").get(c.id);
  if (dry) { console.log(`${c.id}: would ${existed ? "update the draft of" : "create"} "${c.title}" with ${content.nodes.length} content and ${methods.nodes.length} methods nodes`); continue; }
  C.ensureCurriculum(db, c.id, c.title);
  // Content first: importBoard maps the methods' restsOn ids through the draft's content board ids.
  const rc = C.importBoard(db, c.id, "content", content, { note: "Wu library extraction" });
  const rm = C.importBoard(db, c.id, "methods", methods, { note: "Wu library extraction" });
  const v = C.getVersion(db, rc.draft);
  const kept = keepPublishedArrows(c.id, rc.draft);
  const unmatched = [...rc.unmatchedOld, ...rm.unmatchedOld];
  console.log(`${c.id}: draft v${v.seq} · content ${rc.matched} matched, ${rc.added.length} new · methods ${rm.matched} matched, ${rm.added.length} new${kept.added ? ` · ${kept.added} reviewed arrows kept from v${kept.from}` : ""}${kept.skipped.length ? ` · ${kept.skipped.length} not kept (would close a cycle): ${kept.skipped.join("; ")}` : ""}${unmatched.length ? ` · ${unmatched.length} earlier nodes not in the extraction (kept out of the draft; say retire/merge when publishing): ${unmatched.slice(0, 8).map((u) => u.title).join("; ")}${unmatched.length > 8 ? "…" : ""}` : ""}`);
}

// An assumed node from another course says which node it is as xref "<curriculum>:<board id>"; now that every
// course is loaded, point it at that node's key there ("<curriculum>:<key>", stable across re-imports).
if (!dry) {
  const rows = db.prepare("SELECT r.version_id, r.node_key, r.extra_json, cv.curriculum_id FROM node_revision r JOIN curriculum_version cv ON cv.id = r.version_id WHERE cv.status = 'draft' AND r.layer = 'content' AND r.extra_json LIKE '%\"xref\"%'").all();
  const keyIn = db.prepare("SELECT r.node_key FROM node_revision r JOIN curriculum_version cv ON cv.id = r.version_id WHERE cv.curriculum_id = ? AND r.layer = 'content' AND r.external_ref = ? ORDER BY cv.status = 'draft' DESC, cv.seq DESC LIMIT 1");
  const set = db.prepare("UPDATE node_revision SET extra_json = ? WHERE version_id = ? AND node_key = ?");
  let linked = 0;
  for (const r of rows) {
    const x = JSON.parse(r.extra_json);
    const m = /^([a-z0-9-]+):(w\d+)$/.exec(x.xref || "");
    if (!m || !x.xrefResolved) continue;
    const k = keyIn.get(m[1], m[2])?.node_key;
    if (!k) continue;
    x.xref = `${m[1]}:${k}`; delete x.xrefResolved;
    set.run(JSON.stringify(x), r.version_id, r.node_key); linked++;
  }
  console.log(`${linked} cross-course links point at node keys`);
}
