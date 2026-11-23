// Curricula and their versions: the content DAG, the methods DAG and the lesson plan, versioned together.
//
// Keys: content nodes keep their original ids (e26), methods nodes carry m: (m:e5), units are U05/M1/F1.
// Nodes created later get c:<rand6> / m:<rand6> / u:<rand6>, so a key is never reused for another concept.
// A draft is a full copy of its parent published version; edits touch only the draft; publish freezes it.
//
//   graphFor(db, v, "content"|"methods")  -> the old wu_dag.json shape {source, importedAt, nodes, edges, texts}
//   planFor(db, v) / ladderFor(db, v)     -> parsed lesson plan / the exact curriculum_ladder.md text
//   resolve(db, cur, key, fromV, toV)     -> {status: current|migrated|ambiguous|retired, keys}
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { tx, now, J, P } from "./db.mjs";
import { parseLadder, renderLadder } from "./lessonplan.mjs";

export const LAYERS = ["content", "methods", "unit"];
const STD = new Set(["id", "title", "detail", "kind", "x", "y", "w", "h"]);
const keyFor = (layer, id) => (layer === "methods" ? `m:${id}` : String(id));
const idFor = (layer, key) => (layer === "methods" ? key.replace(/^m:/, "") : key);
const newKey = (layer) => ({ content: "c:", methods: "m:", unit: "u:" }[layer]) + randomBytes(3).toString("hex");
export const layerOfKey = (key) => (/^m:/.test(key) ? "methods" : /^(U\d\d|M\d|F\d|u:)/.test(key) ? "unit" : "content");

// ---------- curricula and versions ----------

export function ensureCurriculum(db, id, title) {
  db.prepare("INSERT INTO curriculum(id, title, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING").run(id, title, now());
  return db.prepare("SELECT * FROM curriculum WHERE id = ?").get(id);
}
export const listCurricula = (db) => db.prepare("SELECT * FROM curriculum ORDER BY created_at").all();

const vrow = (r) => r && { ...r, meta: P(r.meta_json, {}) };
export const getVersion = (db, id) => vrow(db.prepare("SELECT * FROM curriculum_version WHERE id = ?").get(id));
export const listVersions = (db, cur) => db.prepare("SELECT id, curriculum_id, seq, parent_id, status, origin, note, created_at, published_at FROM curriculum_version WHERE curriculum_id = ? ORDER BY seq").all(cur);
export const latestPublished = (db, cur) => vrow(db.prepare("SELECT * FROM curriculum_version WHERE curriculum_id = ? AND status = 'published' ORDER BY seq DESC LIMIT 1").get(cur));
export const draftOf = (db, cur) => vrow(db.prepare("SELECT * FROM curriculum_version WHERE curriculum_id = ? AND status = 'draft'").get(cur));

function newVersion(db, cur, { origin, note = "", parentId = null, planText = "", meta = {} }) {
  const seq = (db.prepare("SELECT MAX(seq) s FROM curriculum_version WHERE curriculum_id = ?").get(cur).s || 0) + 1;
  return Number(db.prepare("INSERT INTO curriculum_version(curriculum_id, seq, parent_id, status, origin, note, plan_text, meta_json, created_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)")
    .run(cur, seq, parentId, origin, note, planText, J(meta), now()).lastInsertRowid);
}
const setMeta = (db, v, fn) => { const m = getVersion(db, v).meta; fn(m); db.prepare("UPDATE curriculum_version SET meta_json = ? WHERE id = ?").run(J(m), v); };

function ensureNode(db, cur, key, layer, v) {
  db.prepare("INSERT INTO node(curriculum_id, key, layer, created_in_version) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").run(cur, key, layer, v);
}
const insRev = (db, v, r) => db.prepare("INSERT OR REPLACE INTO node_revision(version_id, node_key, layer, ord, title, detail, kind, x, y, w, h, extra_json, external_ref) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run(v, r.key, r.layer, r.ord ?? 0, r.title ?? "", r.detail ?? "", r.kind ?? "", r.x ?? null, r.y ?? null, r.w ?? null, r.h ?? null, J(r.extra || {}), r.external_ref ?? null);
const insEdge = (db, v, e) => db.prepare("INSERT OR REPLACE INTO edge(version_id, ord, from_key, to_key, kind, extra_json) VALUES (?,?,?,?,?,?)").run(v, e.ord ?? 0, e.from, e.to, e.kind, J(e.extra || {}));
const nextOrd = (db, v, table, where = "", ...args) => (db.prepare(`SELECT MAX(ord) o FROM ${table} WHERE version_id = ? ${where}`).get(v, ...args).o ?? -1) + 1;

// ---------- writing layers ----------

// graph: {source, importedAt, nodes:[{id,...}], edges:[{from,to,prove,bends}], texts}; keyOf maps a board id to a key.
export function writeGraph(db, v, layer, graph, { keyOf = (id) => keyFor(layer, id), contentKeyOf = (id) => id } = {}) {
  const cur = getVersion(db, v).curriculum_id;
  tx(db, () => {
    db.prepare("DELETE FROM node_revision WHERE version_id = ? AND layer = ?").run(v, layer);
    const pre = layer === "methods" ? "m:%" : null;
    db.prepare(`DELETE FROM edge WHERE version_id = ? AND kind IN ('uses','uses_to_prove') AND from_key ${pre ? "LIKE 'm:%'" : "NOT LIKE 'm:%'"} AND from_key NOT GLOB '[UMF][0-9]*' AND from_key NOT LIKE 'u:%'`).run(v);
    if (layer === "methods") db.prepare("DELETE FROM edge WHERE version_id = ? AND kind = 'rests_on'").run(v);
    const { nodes = [], edges = [], ...header } = graph;
    nodes.forEach((n, ord) => {
      const key = keyOf(n.id);
      const extra = {};
      for (const [k, val] of Object.entries(n)) if (!STD.has(k) && k !== "restsOn") extra[k] = val;
      ensureNode(db, cur, key, layer, v);
      insRev(db, v, { key, layer, ord, title: n.title, detail: n.detail, kind: n.kind, x: n.x, y: n.y, w: n.w, h: n.h, extra, external_ref: n.id });
      (n.restsOn || []).forEach((c, i) => insEdge(db, v, { ord: i, from: key, to: contentKeyOf(c), kind: "rests_on" }));
    });
    edges.forEach((e, ord) => {
      const { from, to, prove, ...extra } = e;
      insEdge(db, v, { ord, from: keyOf(from), to: keyOf(to), kind: prove ? "uses_to_prove" : "uses", extra });
    });
    setMeta(db, v, (m) => { m[layer] = header; });
  });
}

export function writePlan(db, v, plan, { covers = null } = {}) {
  const cur = getVersion(db, v).curriculum_id;
  tx(db, () => {
    db.prepare("DELETE FROM node_revision WHERE version_id = ? AND layer = 'unit'").run(v);
    db.prepare("DELETE FROM edge WHERE version_id = ? AND kind = 'needs'").run(v);
    db.prepare("DELETE FROM gated_term WHERE version_id = ?").run(v);
    for (const u of plan.units) {
      ensureNode(db, cur, u.key, "unit", v);
      insRev(db, v, { key: u.key, layer: "unit", ord: u.ord, title: u.name, detail: u.about, kind: "unit", extra: { stance: u.stance, notes: u.notes, section: u.section } });
      u.needs.forEach((n, i) => insEdge(db, v, { ord: i, from: u.key, to: n, kind: "needs" }));
    }
    for (const g of plan.gated) g.terms.forEach((t, pos) => db.prepare("INSERT INTO gated_term(version_id, grp, pos, term, unit_key) VALUES (?,?,?,?,?)").run(v, g.grp, pos, t, g.unit));
    db.prepare("UPDATE curriculum_version SET plan_text = ? WHERE id = ?").run(plan.planText, v);
    setMeta(db, v, (m) => { m.plan = { layout: plan.layout, hasSections: plan.hasSections !== false }; });
    if (covers) setCovers(db, v, covers);
  });
}

// covers: {U05: ["e64", "m:e46"]}; keys that don't exist in the version are dropped.
export function setCovers(db, v, covers) {
  const have = keysOf(db, v);
  tx(db, () => {
    db.prepare("DELETE FROM edge WHERE version_id = ? AND kind = 'covers'").run(v);
    for (const [u, keys] of Object.entries(covers || {})) {
      if (!have.has(u)) continue;
      [...new Set(keys)].filter((k) => have.has(k)).forEach((k, i) => insEdge(db, v, { ord: i, from: u, to: k, kind: "covers" }));
    }
  });
}

// ---------- reading ----------

export const keysOf = (db, v, layer = null) => new Set(db.prepare(`SELECT node_key k FROM node_revision WHERE version_id = ? ${layer ? "AND layer = ?" : ""}`).all(...(layer ? [v, layer] : [v])).map((r) => r.k));
export const revisionsOf = (db, v, layer) => db.prepare("SELECT * FROM node_revision WHERE version_id = ? AND layer = ? ORDER BY ord").all(v, layer).map((r) => ({ ...r, extra: P(r.extra_json, {}) }));
const edgesOf = (db, v, kinds) => db.prepare(`SELECT * FROM edge WHERE version_id = ? AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY ord, from_key, to_key`).all(v, ...kinds).map((e) => ({ ...e, extra: P(e.extra_json, {}) }));

export function graphFor(db, v, layer) {
  const ver = getVersion(db, v);
  if (!ver) return null;
  const revs = revisionsOf(db, v, layer);
  const mine = new Set(revs.map((r) => r.node_key));
  const rests = new Map();
  if (layer === "methods") for (const e of edgesOf(db, v, ["rests_on"]).sort((a, b) => a.ord - b.ord)) { if (!rests.has(e.from_key)) rests.set(e.from_key, []); rests.get(e.from_key).push(e.to_key); }
  const nodes = revs.map((r) => {
    const n = { id: idFor(layer, r.node_key), title: r.title, detail: r.detail, kind: r.kind, x: r.x, y: r.y, w: r.w, h: r.h, ...r.extra };
    if (layer === "methods") n.restsOn = rests.get(r.node_key) || [];
    return n;
  });
  const edges = db.prepare("SELECT * FROM edge WHERE version_id = ? AND kind IN ('uses','uses_to_prove') ORDER BY ord").all(v)
    .filter((e) => mine.has(e.from_key) && mine.has(e.to_key))
    .map((e) => ({ from: idFor(layer, e.from_key), to: idFor(layer, e.to_key), prove: e.kind === "uses_to_prove", ...P(e.extra_json, {}) }));
  const { nodes: _n, edges: _e, ...header } = ver.meta[layer] || {};
  return { ...header, nodes, edges };
}

export function planFor(db, v) {
  const ver = getVersion(db, v);
  const needs = new Map();
  for (const e of edgesOf(db, v, ["needs"]).sort((a, b) => a.ord - b.ord)) { if (!needs.has(e.from_key)) needs.set(e.from_key, []); needs.get(e.from_key).push(e.to_key); }
  const units = revisionsOf(db, v, "unit").map((r) => ({ key: r.node_key, name: r.title, about: r.detail, needs: needs.get(r.node_key) || [], stance: r.extra.stance || "", notes: r.extra.notes || "", section: r.extra.section ?? 0, ord: r.ord }));
  const gated = [];
  for (const g of db.prepare("SELECT * FROM gated_term WHERE version_id = ? ORDER BY grp, pos").all(v)) {
    if (gated.at(-1)?.grp !== g.grp) gated.push({ grp: g.grp, terms: [], unit: g.unit_key });
    gated.at(-1).terms.push(g.term);
  }
  const lay = ver.meta.plan || { layout: [], hasSections: false };
  return { planText: ver.plan_text, layout: lay.layout, hasSections: lay.hasSections, units, gated, covers: coversFor(db, v) };
}
export const ladderFor = (db, v) => renderLadder(planFor(db, v));

export function coversFor(db, v) {
  const out = {};
  for (const e of edgesOf(db, v, ["covers"]).sort((a, b) => a.ord - b.ord)) (out[e.from_key] ||= []).push(e.to_key);
  return out;
}

// ---------- drafts ----------

// The curriculum's draft, creating it from the latest published version when there is none.
export function createDraft(db, cur, { origin = "edit", note = "" } = {}) {
  const have = draftOf(db, cur);
  if (have) return have.id;
  const parent = latestPublished(db, cur);
  return tx(db, () => {
    const v = newVersion(db, cur, { origin, note, parentId: parent?.id ?? null, planText: parent?.plan_text || "", meta: parent?.meta || {} });
    if (parent) {
      db.prepare("INSERT INTO node_revision SELECT ?, node_key, layer, ord, title, detail, kind, x, y, w, h, extra_json, external_ref FROM node_revision WHERE version_id = ?").run(v, parent.id);
      db.prepare("INSERT INTO edge SELECT ?, ord, from_key, to_key, kind, extra_json FROM edge WHERE version_id = ?").run(v, parent.id);
      db.prepare("INSERT INTO gated_term SELECT ?, grp, pos, term, unit_key FROM gated_term WHERE version_id = ?").run(v, parent.id);
    }
    return v;
  });
}

export function discardDraft(db, v) {
  const ver = getVersion(db, v);
  if (ver?.status !== "draft") throw new Error("not a draft");
  tx(db, () => {
    db.prepare("DELETE FROM lineage WHERE to_version = ?").run(v);
    db.prepare("DELETE FROM node WHERE created_in_version = ?").run(v);
    db.prepare("DELETE FROM curriculum_version WHERE id = ?").run(v);
  });
}

const requireDraft = (db, v) => { const ver = getVersion(db, v); if (!ver) throw new Error(`no version ${v}`); if (ver.status !== "draft") throw new Error(`v${ver.seq} is published and cannot change; edit a draft`); return ver; };

function writeLineage(db, ver, oldKey, relation, into = [], note = "") {
  db.prepare("DELETE FROM lineage WHERE to_version = ? AND old_key = ?").run(ver.id, oldKey);
  if (relation === "retired" || !into.length) {
    db.prepare("INSERT INTO lineage(curriculum_id, from_version, to_version, old_key, new_key, relation, note) VALUES (?,?,?,?,?,?,?)").run(ver.curriculum_id, ver.parent_id ?? ver.id, ver.id, oldKey, null, "retired", note);
    return;
  }
  const rel = relation === "split" || into.length > 1 ? "split" : relation;
  for (const k of into) db.prepare("INSERT INTO lineage(curriculum_id, from_version, to_version, old_key, new_key, relation, note) VALUES (?,?,?,?,?,?,?)").run(ver.curriculum_id, ver.parent_id ?? ver.id, ver.id, oldKey, k, rel, note);
}

// ops: [{op, ...}]. Returns {keys: [new keys in op order]}.
//   upsertNode {layer, key?, fields:{title, detail, kind, x, y, w, h, ...extra}}   (units: {name, about, needs, stance, notes, section})
//   removeNode {key, relation: retired|merged|replaced|split, into: [keys], note}
//   lineage    {key, relation, into, note}       for a key an import dropped
//   addEdge / removeEdge {from, to, kind, extra?}
//   setCovers {covers: {U05: [...]}} · setPlanText {text} · setGated {gated: [{terms, unit}]} · setLadder {md}
export function editDraft(db, v, ops) {
  const ver = requireDraft(db, v);
  const keys = [];
  tx(db, () => {
    for (const o of ops) {
      if (o.op === "upsertNode") {
        const layer = o.layer || layerOfKey(o.key || "");
        const key = o.key || newKey(layer);
        const old = db.prepare("SELECT * FROM node_revision WHERE version_id = ? AND node_key = ?").get(v, key);
        const f = o.fields || {};
        if (layer === "unit") {
          const ex = old ? P(old.extra_json, {}) : {};
          insRev(db, v, { key, layer, ord: old?.ord ?? nextOrd(db, v, "node_revision", "AND layer = 'unit'"), title: f.name ?? old?.title ?? key, detail: f.about ?? old?.detail ?? "", kind: "unit",
            extra: { stance: f.stance ?? ex.stance ?? "", notes: f.notes ?? ex.notes ?? "", section: f.section ?? ex.section ?? 0 } });
          if (f.needs) { db.prepare("DELETE FROM edge WHERE version_id = ? AND from_key = ? AND kind = 'needs'").run(v, key); f.needs.forEach((n, i) => insEdge(db, v, { ord: i, from: key, to: n, kind: "needs" })); }
        } else {
          const { title, detail, kind, x, y, w, h, restsOn, ...extra } = f;
          const ex = old ? P(old.extra_json, {}) : {};
          insRev(db, v, { key, layer, ord: old?.ord ?? nextOrd(db, v, "node_revision", "AND layer = ?", layer), title: title ?? old?.title ?? "", detail: detail ?? old?.detail ?? "", kind: kind ?? old?.kind ?? (layer === "methods" ? "method" : "theorem"),
            x: x ?? old?.x ?? 0, y: y ?? old?.y ?? 0, w: w ?? old?.w ?? 230, h: h ?? old?.h ?? 88, extra: { ...ex, ...extra }, external_ref: old?.external_ref ?? null });
          if (restsOn) { db.prepare("DELETE FROM edge WHERE version_id = ? AND from_key = ? AND kind = 'rests_on'").run(v, key); restsOn.forEach((c, i) => insEdge(db, v, { ord: i, from: key, to: c, kind: "rests_on" })); }
        }
        ensureNode(db, ver.curriculum_id, key, layer, v);
        keys.push(key);
      } else if (o.op === "removeNode" || o.op === "lineage") {
        const into = o.into || [];
        const persisting = keysOf(db, v);
        for (const k of into) if (!persisting.has(k) || k === o.key) throw new Error(`${o.key}: successor ${k} is not in the draft`);
        if (o.op === "removeNode") {
          // Merged/replaced units hand their gated terms and covers to the successor.
          if (into.length === 1) {
            db.prepare("UPDATE gated_term SET unit_key = ? WHERE version_id = ? AND unit_key = ?").run(into[0], v, o.key);
            // Edges into the old key (covers, rests_on, other units' needs) and a unit's own covers move to the successor.
            for (const e of db.prepare("SELECT * FROM edge WHERE version_id = ? AND kind IN ('covers','rests_on','needs') AND to_key = ? AND from_key != ?").all(v, o.key, into[0])) db.prepare("INSERT OR IGNORE INTO edge VALUES (?,?,?,?,?,?)").run(v, e.ord, e.from_key, into[0], e.kind, e.extra_json);
            for (const e of db.prepare("SELECT * FROM edge WHERE version_id = ? AND kind = 'covers' AND from_key = ?").all(v, o.key)) db.prepare("INSERT OR IGNORE INTO edge VALUES (?,?,?,?,?,?)").run(v, e.ord, into[0], e.to_key, e.kind, e.extra_json);
          }
          db.prepare("DELETE FROM node_revision WHERE version_id = ? AND node_key = ?").run(v, o.key);
          db.prepare("DELETE FROM edge WHERE version_id = ? AND (from_key = ? OR to_key = ?)").run(v, o.key, o.key);
          db.prepare("DELETE FROM gated_term WHERE version_id = ? AND unit_key = ?").run(v, o.key);
        }
        // A key created in this draft never existed in a published version: nothing to record.
        if (db.prepare("SELECT 1 FROM node_revision WHERE version_id = ? AND node_key = ?").get(ver.parent_id ?? -1, o.key)) writeLineage(db, ver, o.key, o.relation || "retired", into, o.note || "");
        else db.prepare("DELETE FROM node WHERE curriculum_id = ? AND key = ? AND created_in_version = ?").run(ver.curriculum_id, o.key, v);
      } else if (o.op === "addEdge") insEdge(db, v, { ord: nextOrd(db, v, "edge"), from: o.from, to: o.to, kind: o.kind, extra: o.extra });
      else if (o.op === "removeEdge") db.prepare("DELETE FROM edge WHERE version_id = ? AND from_key = ? AND to_key = ? AND kind = ?").run(v, o.from, o.to, o.kind);
      else if (o.op === "setCovers") setCovers(db, v, o.covers);
      else if (o.op === "setPlanText") db.prepare("UPDATE curriculum_version SET plan_text = ? WHERE id = ?").run(o.text, v);
      else if (o.op === "setGated") {
        db.prepare("DELETE FROM gated_term WHERE version_id = ?").run(v);
        o.gated.forEach((g, grp) => g.terms.forEach((t, pos) => db.prepare("INSERT INTO gated_term VALUES (?,?,?,?,?)").run(v, grp, pos, t, g.unit)));
      } else if (o.op === "setLadder") {
        const covers = coversFor(db, v);
        writePlan(db, v, parseLadder(o.md), { covers });
      } else if (o.op === "setNote") db.prepare("UPDATE curriculum_version SET note = ? WHERE id = ?").run(o.note, v);
      else throw new Error(`unknown op ${o.op}`);
    }
  });
  return { keys };
}

// Keys that were in the parent, are gone from the draft, and have no lineage yet: publish refuses these.
export function unresolvedRemovals(db, v) {
  const ver = getVersion(db, v);
  if (!ver?.parent_id) return [];
  const now_ = keysOf(db, v);
  const told = new Set(db.prepare("SELECT old_key FROM lineage WHERE to_version = ?").all(v).map((r) => r.old_key));
  return [...keysOf(db, ver.parent_id)].filter((k) => !now_.has(k) && !told.has(k));
}

// ---------- lineage ----------

// Precomputed lineage for a curriculum: per version, its keys and the lineage rows that lead into it.
export function lineageIndex(db, cur) {
  const versions = db.prepare("SELECT id, seq FROM curriculum_version WHERE curriculum_id = ? ORDER BY seq").all(cur);
  const keys = new Map(versions.map((x) => [x.id, keysOf(db, x.id)]));
  const rows = new Map();
  for (const r of db.prepare("SELECT * FROM lineage WHERE curriculum_id = ?").all(cur)) {
    if (!rows.has(r.to_version)) rows.set(r.to_version, new Map());
    const m = rows.get(r.to_version);
    if (!m.has(r.old_key)) m.set(r.old_key, []);
    m.get(r.old_key).push(r);
  }
  const seq = new Map(versions.map((x) => [x.id, x.seq]));
  const resolveKey = (key, fromV, toV) => {
    if (keys.get(toV)?.has(key)) return { status: "current", keys: [key] };
    const a = seq.get(fromV), b = seq.get(toV);
    if (a == null || b == null || b < a) return { status: "retired", keys: [] };
    let set = new Set([key]), split = false;
    for (const ver of versions.filter((x) => x.seq > a && x.seq <= b)) {
      const next = new Set();
      for (const k of set) {
        const rs = rows.get(ver.id)?.get(k);
        if (rs) { for (const r of rs) if (r.new_key) next.add(r.new_key); if (rs.some((r) => r.relation === "split")) split = true; }
        else if (keys.get(ver.id)?.has(k)) next.add(k);
      }
      set = next;
    }
    const out = [...set];
    if (!out.length) return { status: "retired", keys: [] };
    if (out.length > 1 || split) return { status: "ambiguous", keys: out };
    return { status: out[0] === key ? "current" : "migrated", keys: out };
  };
  return { resolve: resolveKey, keys, seq, versions };
}
export const resolve = (db, cur, key, fromV, toV) => lineageIndex(db, cur).resolve(key, fromV, toV);

// Resolve a {key: value} map made against fromV into toV. Ambiguous and retired keys are dropped.
export function remap(index, obj, fromV, toV) {
  if (fromV === toV) return { ...obj };
  const out = {};
  for (const [k, val] of Object.entries(obj || {})) { const r = index.resolve(k, fromV, toV); if (r.keys.length === 1 && !(k in out && r.status !== "current")) out[r.keys[0]] = val; }
  return out;
}

// ---------- publish ----------

// Freezes the draft. Problem tags whose keys disappeared get a lineage tag (one successor) or go on the
// retag queue (split/retired). Exports the version under exportDir/<curriculum>/v<seq>/.
export function publish(db, v, { exportDir = null, autoRetire = false } = {}) {
  const ver = requireDraft(db, v);
  const missing = unresolvedRemovals(db, v);
  if (missing.length && !autoRetire) { const e = new Error(`Say what happened to ${missing.join(", ")} (retire, merge or split) before publishing`); e.missing = missing; throw e; }
  const stats = tx(db, () => {
    for (const k of missing) writeLineage(db, ver, k, "retired", [], "removed without a successor");
    db.prepare("UPDATE curriculum_version SET status = 'published', published_at = ? WHERE id = ?").run(now(), v);
    return migrateTags(db, ver.curriculum_id, v);
  });
  if (exportDir) exportVersion(db, v, exportDir);
  return { version: getVersion(db, v), ...stats };
}

function migrateTags(db, cur, v) {
  const lineage = db.prepare("SELECT * FROM lineage WHERE to_version = ?").all(v);
  if (!lineage.length) return { lineageTags: 0, queued: 0 };
  const idx = lineageIndex(db, cur);
  const byOld = new Map();
  for (const r of lineage) { if (!byOld.has(r.old_key)) byOld.set(r.old_key, []); byOld.get(r.old_key).push(r); }
  let lineageTags = 0, queued = 0;
  const at = now();
  for (const { problem_id } of db.prepare("SELECT DISTINCT t.problem_id FROM problem_tag t JOIN curriculum_version cv ON cv.id = t.version_id WHERE cv.curriculum_id = ?").all(cur)) {
    const base = baseTags(db, cur, problem_id, idx, v);
    if (!base) continue;
    for (const key of base.keys) {
      if (!byOld.has(key)) continue;
      const r = idx.resolve(key, base.version, v);
      if (r.status === "migrated" || (r.status === "current" && r.keys[0] !== key)) {
        db.prepare("INSERT OR IGNORE INTO problem_tag(problem_id, node_key, version_id, pos, source, at) VALUES (?,?,?,?,?,?)").run(problem_id, r.keys[0], v, 0, "lineage", at);
        lineageTags++;
      } else if (r.status === "ambiguous" || r.status === "retired") {
        db.prepare("INSERT OR REPLACE INTO retag_queue(problem_id, version_id, node_key, reason, candidates_json, at) VALUES (?,?,?,?,?,?)").run(problem_id, v, key, r.status === "ambiguous" ? "split" : "retired", J(r.keys), at);
        queued++;
      }
    }
  }
  return { lineageTags, queued };
}

// A problem's own tag set for a curriculum: the rows of the latest version <= atV that has non-lineage rows.
export function baseTags(db, cur, problemId, idx, atV) {
  const rows = db.prepare("SELECT t.node_key, t.version_id, t.pos, t.source, cv.seq FROM problem_tag t JOIN curriculum_version cv ON cv.id = t.version_id WHERE t.problem_id = ? AND cv.curriculum_id = ? AND t.source != 'lineage' ORDER BY cv.seq DESC, t.pos").all(problemId, cur);
  const atSeq = idx.seq.get(atV) ?? Infinity;
  const mine = rows.filter((r) => r.seq <= atSeq);
  if (!mine.length) return null;
  const version = mine[0].version_id;
  return { version, keys: mine.filter((r) => r.version_id === version).map((r) => r.node_key) };
}

// ---------- diff, import matching, export ----------

export function diffVersions(db, a, b) {
  const out = { added: [], removed: [], changed: [], edgesAdded: [], edgesRemoved: [], lineage: [], planTextChanged: false, gatedChanged: false };
  const ra = new Map(db.prepare("SELECT * FROM node_revision WHERE version_id = ?").all(a).map((r) => [r.node_key, r]));
  const rb = new Map(db.prepare("SELECT * FROM node_revision WHERE version_id = ?").all(b).map((r) => [r.node_key, r]));
  const strip = (r) => ({ title: r.title, detail: r.detail, kind: r.kind, extra: r.extra_json });
  for (const [k, r] of rb) if (!ra.has(k)) out.added.push({ key: k, layer: r.layer, title: r.title });
  for (const [k, r] of ra) if (!rb.has(k)) out.removed.push({ key: k, layer: r.layer, title: r.title });
  for (const [k, r] of rb) {
    const o = ra.get(k); if (!o) continue;
    const fields = ["title", "detail", "kind", "extra"].filter((f) => strip(o)[f] !== strip(r)[f]);
    const moved = o.x !== r.x || o.y !== r.y;
    if (fields.length || moved) out.changed.push({ key: k, layer: r.layer, title: r.title, fields: moved ? [...fields, "layout"] : fields, before: { title: o.title, detail: o.detail }, after: { title: r.title, detail: r.detail } });
  }
  const ek = (e) => `${e.kind}|${e.from_key}|${e.to_key}`;
  const ea = new Set(db.prepare("SELECT * FROM edge WHERE version_id = ?").all(a).map(ek));
  const eb = new Set(db.prepare("SELECT * FROM edge WHERE version_id = ?").all(b).map(ek));
  const unk = (s) => { const [kind, from, to] = s.split("|"); return { kind, from, to }; };
  for (const e of eb) if (!ea.has(e)) out.edgesAdded.push(unk(e));
  for (const e of ea) if (!eb.has(e)) out.edgesRemoved.push(unk(e));
  out.lineage = db.prepare("SELECT old_key, new_key, relation, note FROM lineage WHERE to_version = ?").all(b);
  out.planTextChanged = getVersion(db, a).plan_text !== getVersion(db, b).plan_text;
  const g = (v) => J(db.prepare("SELECT grp, pos, term, unit_key FROM gated_term WHERE version_id = ? ORDER BY grp, pos").all(v));
  out.gatedChanged = g(a) !== g(b);
  return out;
}

const normTitle = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Match a re-imported board's nodes to existing keys: first by whiteboard id, then by normalized title.
//   old: [{key, external_ref, title}]   incoming: [{id, title}]   -> {map: {id: key|null}, unmatchedOld: [keys]}
export function matchImport(old, incoming) {
  const map = {}, used = new Set();
  const byRef = new Map(old.filter((o) => o.external_ref).map((o) => [o.external_ref, o]));
  for (const n of incoming) {
    const o = byRef.get(n.id);
    if (o && !used.has(o.key)) { map[n.id] = o.key; used.add(o.key); }
  }
  for (const n of incoming) {
    if (map[n.id]) continue;
    const o = old.find((x) => !used.has(x.key) && normTitle(x.title) === normTitle(n.title));
    if (o) { map[n.id] = o.key; used.add(o.key); } else map[n.id] = null;
  }
  return { map, unmatchedOld: old.filter((o) => !used.has(o.key)).map((o) => o.key) };
}

// Re-import one board into the curriculum's draft. New nodes get fresh keys; old keys with no match are
// returned so the teacher can say whether each was merged, split or retired.
export function importBoard(db, cur, layer, graph, { note = "whiteboard import" } = {}) {
  const v = createDraft(db, cur, { origin: "import", note });
  const old = revisionsOf(db, v, layer).map((r) => ({ key: r.node_key, external_ref: r.external_ref, title: r.title }));
  const { map, unmatchedOld } = matchImport(old, graph.nodes);
  const keyOf = (id) => (map[id] ||= newKey(layer));
  const contentRefs = new Map(revisionsOf(db, v, "content").map((r) => [r.external_ref, r.node_key]));
  // Edges and covers that point at nodes being replaced are dropped with them; re-add covers by hand.
  const covers = coversFor(db, v);
  writeGraph(db, v, layer, graph, { keyOf, contentKeyOf: (id) => contentRefs.get(id) || id });
  setCovers(db, v, covers);
  const added = graph.nodes.filter((n) => !old.some((o) => o.key === map[n.id])).map((n) => ({ id: n.id, key: map[n.id], title: n.title }));
  return { draft: v, matched: graph.nodes.length - added.length, added, unmatchedOld: unmatchedOld.map((k) => ({ key: k, title: old.find((o) => o.key === k).title })) };
}

export function exportVersion(db, v, dir) {
  const ver = getVersion(db, v);
  const out = path.join(dir, ver.curriculum_id, `v${ver.seq}`);
  fs.mkdirSync(out, { recursive: true });
  const w = (f, x) => fs.writeFileSync(path.join(out, f), typeof x === "string" ? x : JSON.stringify(x, null, 1) + "\n");
  w("content.json", graphFor(db, v, "content"));
  w("methods.json", graphFor(db, v, "methods"));
  const plan = planFor(db, v);
  w("lesson_plan.json", { planText: plan.planText, units: plan.units, gated: plan.gated, covers: plan.covers });
  w("curriculum_ladder.md", renderLadder(plan));
  w("version.json", { curriculum: ver.curriculum_id, seq: ver.seq, parent: ver.parent_id && getVersion(db, ver.parent_id)?.seq, origin: ver.origin, note: ver.note, publishedAt: ver.published_at,
    lineage: db.prepare("SELECT old_key, new_key, relation, note FROM lineage WHERE to_version = ?").all(v) });
  return out;
}
