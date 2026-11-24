// Changes to the progress map that Claude proposes with a set, and the teacher approves one by one at Save & finish.
// In the final reply, one ```json fenced block {"mapUpdate": [item, ...]}, each item one of:
//   {"add": {"layer": "methods"|"content", "title", "detail", "kind", "restsOn": [content keys], "uses": [keys],
//            "neededBy": [keys], "units": ["U14"]}, "state": "not-yet"|"partial"|"done"|null, "why": "..."}
//   {"key": "m:e38", "state": "partial", "why": "..."}        a new state for a block already on the map
// New blocks go into the curriculum's draft (the teacher publishes it); states are the teacher's progress events
// for this student. No dependencies beyond the curriculum and progress modules; shared by the server and the tests.
import { STATES } from "./progress.mjs";
import { BOARD_KINDS, layerOfKey } from "./curriculum.mjs";

const strs = (a) => (Array.isArray(a) ? [...new Set(a.map(String).map((s) => s.trim()).filter(Boolean))] : []);

// The last {"mapUpdate": [...]} block in a reply, normalized; null when there is none.
export function mapUpdateFrom(text) {
  const blocks = [...(text || "").matchAll(/```([a-zA-Z]*)\n([\s\S]*?)\n```/g)].reverse();
  for (const m of blocks) {
    if (m[1].toLowerCase() !== "json") continue;
    let o;
    try { o = JSON.parse(m[2]); } catch { continue; }
    if (!o || typeof o !== "object" || Array.isArray(o) || !Array.isArray(o.mapUpdate)) continue;
    return o.mapUpdate.filter((x) => x && typeof x === "object").map((x) => {
      const state = STATES.includes(x.state) ? x.state : null;
      const why = typeof x.why === "string" ? x.why.trim() : "";
      if (x.add && typeof x.add === "object") {
        const a = x.add;
        return { add: { layer: a.layer === "content" ? "content" : "methods", title: String(a.title || "").trim(), detail: String(a.detail || "").trim(), kind: String(a.kind || "").trim(),
          restsOn: strs(a.restsOn), uses: strs(a.uses), neededBy: strs(a.neededBy), units: strs(a.units ?? (a.unit ? [a.unit] : [])) }, state, why };
      }
      return { key: String(x.key || "").trim(), state, why };
    });
  }
  return null;
}

// Each item checked against the map: nodes is a Map key -> {layer, title}. Links to keys the map doesn't have are
// dropped (and said so); an item that can't be applied at all gets an error and no checkbox.
export function resolveMapUpdate(items, nodes) {
  const t = (k) => nodes.get(k)?.title || k;
  return (items || []).map((x, i) => {
    if (x.add) {
      const a = x.add, dropped = [];
      const keep = (ks, ok) => ks.filter((k) => (nodes.has(k) && ok(k) ? true : (dropped.push(k), false)));
      const lay = (k) => nodes.get(k)?.layer;
      const r = {
        layer: a.layer, title: a.title, detail: a.detail,
        kind: BOARD_KINDS[a.layer].includes(a.kind) ? a.kind : a.layer === "methods" ? "method" : "theorem",
        restsOn: a.layer === "methods" ? keep(a.restsOn, (k) => lay(k) === "content") : [],
        uses: keep(a.uses, (k) => lay(k) === a.layer),
        // needed by a block of the same layer (a "uses" edge), or by a method resting on a new content block
        neededBy: keep(a.neededBy, (k) => lay(k) === a.layer || (a.layer === "content" && lay(k) === "methods")),
        units: keep(a.units, (k) => lay(k) === "unit"),
      };
      if (a.layer === "content") dropped.push(...a.restsOn);
      const links = [
        r.restsOn.length && `rests on ${r.restsOn.map(t).join(", ")}`,
        r.uses.length && `builds on ${r.uses.map(t).join(", ")}`,
        r.neededBy.length && `needed for ${r.neededBy.map(t).join(", ")}`,
        r.units.length && `in ${r.units.map((u) => `${u} ${t(u)}`).join(", ")}`,
      ].filter(Boolean);
      return { i, kind: "add", add: r, state: x.state, why: x.why, links, dropped: [...new Set(dropped)], error: a.title ? null : "no title" };
    }
    const n = nodes.get(x.key);
    return { i, kind: "mark", key: x.key, title: n ? n.title : x.key, layer: n?.layer || layerOfKey(x.key), state: x.state, why: x.why,
      error: !n ? `${x.key} is not on the map` : n.layer === "unit" ? "units are marked in the status, not on the map" : !x.state ? "no state" : null };
  });
}

// Draft edits for the approved items. newKey(layer) makes a key for each new block; draftNodes is the draft's
// Map key -> {layer, x, y, w, h}; covers is the draft's {unit: [keys]}. Returns {ops, marks: [{key, state, note, isNew}]}.
export function mapUpdateOps(resolved, { newKey, draftNodes, covers = {}, note = "" }) {
  const ops = [], marks = [], cov = Object.fromEntries(Object.entries(covers).map(([u, ks]) => [u, [...ks]]));
  let covChanged = false, placed = 0;
  const has = (k) => draftNodes.has(k);
  for (const r of resolved) {
    if (r.error) continue;
    const why = [note, r.why].filter(Boolean).join(": ");
    if (r.kind === "mark") { if (has(r.key)) marks.push({ key: r.key, state: r.state, note: why, isNew: false }); continue; }
    const a = r.add, key = newKey(a.layer);
    // under the first block it links to on its own board, else at the board's top left
    const anchor = [...a.uses, ...a.neededBy, ...a.restsOn].map((k) => draftNodes.get(k)).find((n) => n && n.layer === a.layer);
    const pos = anchor ? { x: anchor.x + 30 * placed, y: anchor.y + (anchor.h || 88) + 40 } : { x: 40 + 30 * placed, y: 40 };
    placed++;
    ops.push({ op: "upsertNode", layer: a.layer, key, fields: { title: a.title, detail: a.detail, kind: a.kind, ...pos, ...(a.restsOn.filter(has).length ? { restsOn: a.restsOn.filter(has) } : {}) } });
    for (const k of a.uses.filter(has)) ops.push({ op: "addEdge", from: k, to: key, kind: "uses" });
    for (const k of a.neededBy.filter(has)) {
      const lay = draftNodes.get(k).layer;
      ops.push(lay === a.layer ? { op: "addEdge", from: key, to: k, kind: "uses" } : { op: "addEdge", from: k, to: key, kind: "rests_on" });
    }
    for (const u of a.units.filter(has)) { (cov[u] ||= []).push(key); covChanged = true; }
    if (r.state) marks.push({ key, state: r.state, note: why, isNew: true });
  }
  if (covChanged) ops.push({ op: "setCovers", covers: cov });
  return { ops, marks };
}
