// Wu DAG progress map: the content board and the methods board (snapshots of the whiteboards), coloured by
// how far the student has got. States come from Claude's guess (from homework + uploaded notes) unless the teacher
// overrides a node ("set by you"). Methods ids are namespaced "m:eNN" everywhere outside their own file.
// The sidebar sub-items pick the mode: the content board, the methods board, the lesson plan, or Inference.
// Content, Methods and Lesson plan each have a deterministic Markdown export/import (progressmd.js, status.md);
// Inference is the one place that pays Claude: drop files for it and run a guess. Every guess run (chain of thought, tool calls, cost, per-node evidence) is under History › Inference.
// Pure helpers (edgePath, computeStates, ladderHints, statusText) are exported for ui/scripts/test.mjs.
import { $, $$, esc, api, S, parseUnitStatuses, log } from "./lib.js";
import { parseBoardMd } from "./progressmd.js";
import { fmtUSD } from "./cost.js";

export const LOW_CONFIDENCE = 0.6;
const BOARD_LABEL = { content: "Content", methods: "Methods" };
const KIND_LABEL = { assumed: "Assumed (pre-algebra)", definition: "Definition", theorem: "Theorem", method: "Method", "word-problem": "Word problem (not used)" };

// ---------- pure ----------

// Lesson plan: the course version's units in plan order, grouped by its sections, with each unit's status and
// note from weekly_status.md and any prerequisite not yet taught (only flagged once the unit itself is taught or
// current, as in the Create Homework units widget). `plan` is the structured plan from GET /api/dag
// ({layout:[{heading, items:[{unit}|{raw}]}], units:[{key, name, about, needs, stance, notes}]}), or, as a
// fallback, curriculum_ladder.md text (U units only).
export function lessonPlan(plan, statusMd) {
  const { map } = parseUnitStatuses(statusMd || "");
  const st = (id) => map[id]?.status || "FUTURE";
  const ok = (id) => ["TAUGHT", "CURRENT"].includes(st(id));
  const unit = (id, name, about, needs, stance, guide = "") => {
    const s = st(id);
    return { id, name, about, needs, stance, guide, status: s, note: (map[id]?.note || "").replace(/^\(|\)$/g, ""), missing: ok(id) ? needs.filter((n) => !ok(n)) : [] };
  };
  if (plan && typeof plan === "object") {
    const byKey = new Map((plan.units || []).map((u) => [u.key, u])), placed = new Set();
    const groups = (plan.layout || []).map((sec, si) => ({ title: sec.heading || "", section: si, units: (sec.items || []).filter((i) => i.unit && byKey.has(i.unit)).map((i) => {
      const u = byKey.get(i.unit); placed.add(u.key);
      return unit(u.key, u.name, u.about, u.needs || [], u.stance || "", u.notes || "");
    }) }));
    const rest = (plan.units || []).filter((u) => !placed.has(u.key));
    if (rest.length) groups.push({ title: groups.length ? "Other units" : "", units: rest.map((u) => unit(u.key, u.name, u.about, u.needs || [], u.stance || "", u.notes || "")) });
    return groups.filter((g) => g.units.length);
  }
  const ladderMd = plan;
  const groups = []; let group = null;
  for (const line of (ladderMd || "").split("\n")) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) { group = { title: h[1].trim(), units: [] }; groups.push(group); continue; }
    const u = line.match(/^-\s+(U\d\d)\s+([^.]+)\.(.*)$/);
    if (!u) continue;
    if (!group) { group = { title: "", units: [] }; groups.push(group); }
    const rest = u[3].trim();
    const needs = (rest.match(/Needs\s+([^.]+)\./) || [, ""])[1].match(/U\d\d|M\d|F\d/g) || [];
    const stance = (rest.match(/\b(Formal|Informal[^.]*)\./) || [, ""])[1];
    const about = rest.split(/\s*Needs\s/)[0].trim();
    group.units.push(unit(u[1], u[2].trim(), about, needs, stance));
  }
  return groups.filter((g) => g.units.length);
}

// The lesson plan's latent DAG: units as nodes, "Needs" as edges (need → unit), laid out in layers (Sugiyama
// style). A unit's layer is its longest chain of needs; edges implied by others (U17 → M2 when U17 already needs
// U15 → U16 → U17) are flagged `implied` and left out of the layout; long edges route through invisible dummy
// slots so the barycenter sweeps can untangle them. Needs naming units not in the plan are ignored, and a cycle
// is broken rather than looped on. `ready` marks a unit not yet started whose needs are all taught or current.
// Returns { nodes: [{id, unit, x, y, w, h, layer, ready}], edges: [{from, to, implied, pts}] } where pts is the
// route (source bottom, through dummies, to target top) for non-implied edges.
export const PLAN_NODE = { w: 210, h: 58, gx: 34, gy: 74, dummy: 18 };
export function planGraph(groups) {
  const units = groups.flatMap((g) => g.units), byId = new Map(units.map((u) => [u.id, u]));
  const needs = new Map(units.map((u) => [u.id, [...new Set(u.needs)].filter((n) => byId.has(n) && n !== u.id)]));
  // layers by longest path, breaking cycles at the back edge
  const layer = new Map(), visiting = new Set();
  const depth = (id) => {
    if (layer.has(id)) return layer.get(id);
    if (visiting.has(id)) return -1;
    visiting.add(id);
    const d = 1 + Math.max(-1, ...needs.get(id).map(depth));
    visiting.delete(id); layer.set(id, d); return d;
  };
  units.forEach((u) => depth(u.id));
  for (const [id, ns] of needs) needs.set(id, ns.filter((n) => layer.get(n) < layer.get(id)));
  // transitive reduction: a need is implied when another need of the same unit already reaches it
  const anc = new Map();
  const ancestors = (id) => {
    if (anc.has(id)) return anc.get(id);
    const s = new Set(); anc.set(id, s);
    for (const n of needs.get(id)) { s.add(n); for (const a of ancestors(n)) s.add(a); }
    return s;
  };
  const edges = [];
  for (const u of units) for (const n of needs.get(u.id)) {
    edges.push({ from: n, to: u.id, implied: needs.get(u.id).some((m) => m !== n && ancestors(m).has(n)) });
  }
  // layer rows, with a dummy slot per intermediate layer of each long kept edge
  const nL = Math.max(0, ...layer.values()) + 1;
  const rows = Array.from({ length: nL }, () => []);
  units.forEach((u, i) => rows[layer.get(u.id)].push({ id: u.id, ord: i }));
  const up = new Map(), down = new Map(), link = (a, b) => { (down.get(a) || down.set(a, []).get(a)).push(b); (up.get(b) || up.set(b, []).get(b)).push(a); };
  for (const e of edges) {
    if (e.implied) continue;
    let prev = e.from; e.via = [];
    for (let l = layer.get(e.from) + 1; l < layer.get(e.to); l++) {
      const d = `~${e.from}>${e.to}@${l}`; rows[l].push({ id: d, dummy: true, ord: Infinity }); e.via.push(d); link(prev, d); prev = d;
    }
    link(prev, e.to);
  }
  // order within rows: plan order, then barycenter sweeps down and up
  const pos = new Map();
  const index = () => rows.forEach((r) => r.forEach((n, i) => pos.set(n.id, i)));
  rows.forEach((r) => r.sort((a, b) => a.ord - b.ord)); index();
  const bary = (n, nb) => { const ps = (nb.get(n.id) || []).map((x) => pos.get(x)); return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : pos.get(n.id); };
  for (let it = 0; it < 6; it++) {
    const downSweep = it % 2 === 0;
    for (let k = 1; k < nL; k++) {
      const l = downSweep ? k : nL - 1 - k, nb = downSweep ? up : down;
      const b = new Map(rows[l].map((n) => [n.id, bary(n, nb)]));
      rows[l].sort((x, y) => b.get(x.id) - b.get(y.id) || pos.get(x.id) - pos.get(y.id));
      rows[l].forEach((n, i) => pos.set(n.id, i));
    }
  }
  // coordinates: each row centred on the widest, then sweeps that pull every slot toward the mean centre of its
  // neighbours in the row above (or below) while keeping the order and the gaps, so long edges run straighter
  const { w, h, gx, gy, dummy } = PLAN_NODE;
  const width = (r) => r.reduce((s, n) => s + (n.dummy ? dummy : w), 0) + gx * Math.max(0, r.length - 1);
  const maxW = Math.max(0, ...rows.map(width)), at = new Map();
  rows.forEach((r, l) => {
    let x = (maxW - width(r)) / 2;
    for (const n of r) { const nw = n.dummy ? dummy : w; at.set(n.id, { x, y: l * (h + gy), w: nw }); x += nw + gx; }
  });
  const centre = (id) => at.get(id).x + at.get(id).w / 2;
  for (let it = 0; it < 8; it++) {
    const downSweep = it % 2 === 0;
    for (let k = 1; k < nL; k++) {
      const r = rows[downSweep ? k : nL - 1 - k], nb = downSweep ? up : down;
      if (!r.length) continue;
      const want = r.map((n) => { const ns = nb.get(n.id) || []; return ns.length ? ns.reduce((s, x) => s + centre(x), 0) / ns.length : centre(n.id); });
      const half = r.map((n) => at.get(n.id).w / 2), sep = (i) => half[i - 1] + gx + half[i];
      // the closest centres to `want` that keep the gaps: average a left-to-right and a right-to-left clamp
      const L = [...want], R = [...want];
      for (let i = 1; i < r.length; i++) L[i] = Math.max(want[i], L[i - 1] + sep(i));
      for (let i = r.length - 2; i >= 0; i--) R[i] = Math.min(want[i], R[i + 1] - sep(i + 1));
      r.forEach((n, i) => { at.get(n.id).x = (L[i] + R[i]) / 2 - half[i]; });
    }
  }
  const minX = Math.min(...[...at.values()].map((p) => p.x));
  for (const p of at.values()) p.x -= minX;
  const ok = (id) => ["TAUGHT", "CURRENT"].includes(byId.get(id).status);
  const nodes = units.map((u) => ({ id: u.id, unit: u, ...at.get(u.id), h, layer: layer.get(u.id),
    ready: ["NEXT", "FUTURE"].includes(u.status) && needs.get(u.id).every(ok) }));
  const mid = (id) => { const p = at.get(id); return p.x + p.w / 2; };
  for (const e of edges) {
    if (e.implied) continue;
    const s = at.get(e.from), t = at.get(e.to);
    e.pts = [[mid(e.from), s.y + h], ...e.via.flatMap((d) => [[mid(d), at.get(d).y], [mid(d), at.get(d).y + h]]), [mid(e.to), t.y]];
    delete e.via;
  }
  return { nodes, edges };
}

// SVG path through route points: vertical-tangent curves between layers, straight runs through dummy slots.
export function curvePath(pts) {
  const r = (v) => Math.round(v * 10) / 10;
  let d = `M${r(pts[0][0])},${r(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    if (x0 === x1 && i % 2 === 0) d += ` L${r(x1)},${r(y1)}`;
    else { const m = (y0 + y1) / 2; d += ` C${r(x0)},${r(m)} ${r(x1)},${r(m)} ${r(x1)},${r(y1)}`; }
  }
  return d;
}

export const keyOf =(board, id) => (board === "methods" ? "m:" + id : id);

// Right-angle route for an edge, following the board's `bends` format (see ui/scripts/import-dag.mjs):
//   ['v', d1]          down d1 from the source's bottom centre, across to the target's centre x, down to its top
//   ['v', d1, dx, dy]  down d1, across dx, vertically to (target top − |dy|), across to the target centre, down
//   null               elbow at mid height
export function edgePath(s, t, bends) {
  const sx = s.x + s.w / 2, sy = s.y + s.h, tx = t.x + t.w / 2, ty = t.y;
  const pts = [[sx, sy]];
  if (Array.isArray(bends) && bends[0] === "v" && bends.length >= 2) {
    const y1 = sy + bends[1];
    pts.push([sx, y1]);
    if (bends.length >= 4) {
      const x2 = sx + bends[2], y2 = ty - Math.abs(bends[3]);
      pts.push([x2, y1], [x2, y2], [tx, y2]);
    } else pts.push([tx, y1]);
  } else {
    const my = ty > sy ? (sy + ty) / 2 : sy + 30;
    pts.push([sx, my], [tx, my]);
    if (ty <= sy) pts.push([tx, ty - 30]);
  }
  pts.push([tx, ty]);
  // drop zero-length segments
  const clean = pts.filter((p, i) => !i || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
  return "M" + clean.map((p) => p.map((v) => Math.round(v * 10) / 10).join(",")).join(" L");
}

// raw state of one node key: override > guess > not-yet
export function rawState(key, guess, overrides) {
  const o = overrides?.[key];
  if (o) return { state: o.state, by: "you", note: o.note, at: o.at };
  const g = guess?.nodes?.[key];
  if (g) return { state: g.state || "not-yet", by: "claude", confidence: g.confidence, evidence: g.evidence || [] };
  return { state: "not-yet", by: null };
}

// Display state per node: done | partial | ready | locked | unused (word problems).
export function computeStates(dag, board, guess, overrides, contentDag) {
  const out = {};
  const preds = {};
  for (const e of dag.edges) (preds[e.to] ||= []).push(e.from);
  const raw = (id) => rawState(keyOf(board, id), guess, overrides);
  const contentRaw = (id) => rawState(id, guess, overrides).state;
  for (const n of dag.nodes) {
    const r = raw(n.id);
    let display = r.state === "not-yet" ? null : r.state;
    if (n.kind === "word-problem" && r.state === "not-yet") display = "unused";
    if (!display) {
      const needOk = (preds[n.id] || []).every((p) => raw(p).state === "done");
      const restOk = board !== "methods" || (n.restsOn || []).every((c) => ["done", "partial"].includes(contentRaw(c)));
      display = needOk && restOk ? "ready" : "locked";
    }
    out[n.id] = { ...r, display, low: r.by === "claude" && r.confidence != null && r.confidence < LOW_CONFIDENCE };
  }
  return out;
}

export function counts(dag, states) {
  const c = { total: 0, done: 0, partial: 0, ready: 0, locked: 0, unused: 0 };
  for (const n of dag.nodes) { const d = states[n.id].display; c[d]++; if (d !== "unused") c.total++; }
  return c;
}

// Plain explanation of one node's state for the node panel. `missing` lists what still blocks a locked node:
// predecessors not done, and (methods) content nodes it rests on that are not at least partly done.
export function statusText(dag, board, id, guess, overrides, contentDag) {
  const n = dag.nodes.find((x) => x.id === id);
  const st = computeStates(dag, board, guess, overrides, contentDag)[id];
  const byWho = st.by === "you" ? `set by you${st.at ? " on " + new Date(st.at).toLocaleDateString() : ""}` : st.by === "claude" ? "Claude's guess" : "";
  const missing = [];
  if (st.display === "locked") {
    for (const e of dag.edges) if (e.to === id && rawState(keyOf(board, e.from), guess, overrides).state !== "done") {
      const p = dag.nodes.find((x) => x.id === e.from); if (p) missing.push({ key: keyOf(board, p.id), title: p.title });
    }
    if (board === "methods") for (const c of n?.restsOn || []) if (!["done", "partial"].includes(rawState(c, guess, overrides).state)) {
      const p = contentDag?.nodes.find((x) => x.id === c); if (p) missing.push({ key: c, title: p.title });
    }
  }
  const label = { done: "Done", partial: "Partly done", ready: "Ready next", locked: "Locked", unused: "Not used" }[st.display];
  const note = {
    done: `The student has this. ${byWho}`.trim(),
    partial: `The student has seen this but it needs more practice. ${byWho}`.trim(),
    ready: "Not done yet, and everything it needs is done, so it can come next.",
    locked: missing.length ? "Not done yet. It needs these first:" : "Not done yet.",
    unused: "Word problems are left out of these sets.",
  }[st.display];
  return { display: st.display, label, note, missing, by: st.by };
}

// Where Claude's ladder → Wu mapping disagrees with weekly_status unit statuses.
export function ladderHints(statusMd, ladderToWu, guess, overrides) {
  if (!ladderToWu) return [];
  const { map } = parseUnitStatuses(statusMd);
  const hints = [];
  for (const [unit, ids] of Object.entries(ladderToWu)) {
    if (!ids?.length) continue;
    const st = map[unit]?.status || "FUTURE";
    const states = ids.map((k) => rawState(k, guess, overrides).state);
    const done = states.filter((s) => s === "done").length, none = states.filter((s) => s === "not-yet").length;
    if (st === "TAUGHT" && none > ids.length / 2) hints.push({ unit, ids, kind: "behind", text: `${unit} is marked taught, but ${none} of its ${ids.length} Wu nodes look not yet done` });
    if ((st === "FUTURE" || st === "NEXT") && done > 0 && done >= ids.length / 2) hints.push({ unit, ids, kind: "ahead", text: `${unit} is ${st.toLowerCase()} in weekly_status, but ${done} of its ${ids.length} Wu nodes look done already` });
  }
  return hints;
}

// ---------- view ----------

const PLAN_VIEW_KEY = "hw.planView";
// editing: the page shows the course's draft and every view can change it (Edit board / Edit units).
//   edit: the view id (board block id or unit key) whose form is open, or {board} / {section} for a new one
//   remove: the view id whose retire-or-merge choice is open
// cEdit: the comment being edited; openC: the linear plan unit whose comments are open.
const D = { data: null, version: null, mode: "content", sel: null, view: null, poll: null, side: "info", dragging: null, planView: "linear", graph: null,
  editing: false, edit: null, remove: null, editErr: "", cEdit: null, cErr: "", openC: null, hist: { filter: "all", data: null, err: "" } };
try { if (localStorage.getItem(PLAN_VIEW_KEY) === "dag") D.planView = "dag"; } catch {}
Object.defineProperty(D, "board", { get: () => (D.mode === "methods" ? "methods" : "content"), enumerable: true });
const MODE_LABEL = { content: "Content", methods: "Methods", plan: "Lesson plan", inference: "Inference" };
const LAYER_LABEL = { content: "Content", methods: "Methods", unit: "Lesson plan" };
const STATUS_LABEL = { TAUGHT: "Taught", CURRENT: "Current", NEXT: "Next", FUTURE: "Future" };
const BOARD_KINDS = { content: ["assumed", "definition", "theorem", "method"], methods: ["method", "word-problem"] };

function bbox(dag) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of dag.nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h); }
  for (const t of dag.texts || []) { x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y); }
  return { x: x0 - 40, y: y0 - 40, w: x1 - x0 + 80, h: y1 - y0 + 80 };
}

const planDag = () => D.mode === "plan" && D.planView === "dag";
const curDag = () => (planDag() ? D.graph : D.data?.[D.board]);
const statesNow = () => computeStates(curDag(), D.board, D.data.guess, D.data.overrides, D.data.content);
// a view id (what the SVG and D.sel use) → the node's key in the curriculum
const nodeKey = (id) => (D.mode === "plan" ? id : keyOf(D.board, id));
const commentsOf = (key) => D.data?.comments?.[key] || [];
const when = (at) => new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

// ---------- shared components (all three views) ----------

// The comment count on a node, in either SVG.
function cBadge(key, w) {
  const n = commentsOf(key).length;
  return n ? `<g class="cbadge" transform="translate(${w - 22},-8)"><title>${n} comment${n === 1 ? "" : "s"}</title><rect width="30" height="17" rx="8.5"/><text x="15" y="12.5">💬${n}</text></g>` : "";
}

// Comments on one node: the teacher's own notes. They belong to the node's key, not to a version, so any version
// takes them and they follow the node into later versions. Claude never sees them.
function commentsHtml(key) {
  const cs = commentsOf(key);
  const err = D.cErr ? ` <span class="err small">${esc(D.cErr)}</span>` : "";
  return `<div class="cmts" data-ckey="${esc(key)}">
    <h4>Comments${cs.length ? ` (${cs.length})` : ""}</h4>
    ${cs.map((c) => D.cEdit === c.id
      ? `<form class="cmt-form" data-cid="${c.id}"><textarea name="text" rows="3">${esc(c.text)}</textarea>
          <div class="pe-row"><button class="small-btn primary" type="submit">Save</button> <button class="link" type="button" data-cmt="cancel">Cancel</button>${err}</div></form>`
      : `<div class="cmt" data-cid="${c.id}"><div class="cmt-text">${esc(c.text)}</div>
          <div class="cmt-meta muted small">${esc(when(c.updated || c.at))}${c.updated ? " · edited" : ""}<span class="cmt-acts"><button class="link" data-cmt="edit">Edit</button><button class="link" data-cmt="delete">Delete</button></span></div></div>`).join("")}
    ${D.cEdit ? "" : `<form class="cmt-form"><textarea name="text" rows="2" placeholder="Add a comment: for you, not for Claude"></textarea>
      <div class="pe-row"><button class="small-btn" type="submit">Add comment</button>${err}</div></form>`}
  </div>`;
}

// A key picker: chips for the chosen nodes, an input that autocompletes the rest ("U03 — Linear equations"),
// and a hidden input with the keys for the form. Used for unit needs and for board uses / proves / rests on.
const kpChip = (k, label) => `<span class="kp-chip" data-k="${esc(k)}" title="${esc(k)}">${esc(label)}<button type="button" class="ghost" data-kp-del aria-label="Remove ${esc(label)}">✕</button></span>`;
function pickerHtml(name, keys, opts, placeholder) {
  const lab = new Map(opts.map((o) => [o.key, o.label]));
  return `<div class="kp" data-name="${name}"><input type="hidden" name="${name}" value="${esc(keys.join(","))}" />
    <span class="kp-chips">${keys.map((k) => kpChip(k, lab.get(k) || k)).join("")}</span>
    <input class="kp-in" list="kp-${name}" placeholder="${esc(placeholder)}" autocomplete="off" />
    <datalist id="kp-${name}">${opts.map((o) => `<option value="${esc(o.key)} — ${esc(o.label)}"></option>`).join("")}</datalist></div>`;
}
function kpAdd(kp, exact) {
  const inp = $(".kp-in", kp), val = inp.value.trim(); if (!val) return false;
  const opts = [...kp.querySelectorAll("datalist option")].map((o) => o.value);
  const hit = opts.find((o) => o === val) || (!exact && (opts.find((o) => o.split(" — ")[0].toLowerCase() === val.toLowerCase()) || opts.filter((o) => o.toLowerCase().includes(val.toLowerCase())).reduce((a, o, i, all) => (all.length === 1 ? o : a), null)));
  if (!hit) return false;
  const [k, ...rest] = hit.split(" — "), hid = $("input[type=hidden]", kp), keys = hid.value ? hid.value.split(",") : [];
  if (!keys.includes(k)) { keys.push(k); hid.value = keys.join(","); $(".kp-chips", kp).insertAdjacentHTML("beforeend", kpChip(k, rest.join(" — "))); }
  inp.value = "";
  return true;
}

// Retire a node, or merge it into another of the same kind (its links, tags and covers move there).
function removeHtml(id, label, neededBy, others) {
  return `<div class="plan-remove small" data-node="${esc(id)}">
    <span>Remove ${esc(label)}?${neededBy.length ? ` ${neededBy.map(esc).join(", ")} build${neededBy.length === 1 ? "s" : ""} on it.` : ""}</span>
    <button class="small-btn" data-pe="retire" title="Drop it; problems tagged with it go on the retag queue when the draft is published">Retire it</button>
    <span class="muted">or merge into</span> <select class="pe-into">${others.map((o) => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join("")}</select>
    <button class="small-btn" data-pe="merge" title="What builds on it, its tags and covers move to the one you pick">Merge</button>
    <button class="link" data-pe="cancel">Cancel</button>${D.editErr ? ` <span class="err">${esc(D.editErr)}</span>` : ""}</div>`;
}
// Edit / Remove for the selected node in a side panel (boards and the lesson plan DAG).
const editBarHtml = (id) => `<div class="np-edit" data-node="${esc(id)}"><button class="small-btn" data-pe="edit">✎ Edit</button><button class="small-btn" data-pe="remove">✕ Remove</button></div>`;
const formButtons = (isNew, addLabel) => `<div class="pe-row"><button class="small-btn primary" type="submit">${isNew ? addLabel : "Save"}</button> <button class="link" type="button" data-pe="cancel">Cancel</button>
  ${D.editErr ? `<span class="err small">${esc(D.editErr)}</span>` : ""}</div>`;

// ---------- boards ----------

function edgesHtml(dag, st, byId) {
  const sel = D.sel;
  return dag.edges.filter((e) => byId[e.from] && byId[e.to]).map((e) => {
    const hot = sel && (e.from === sel || e.to === sel);
    const lit = st[e.from].display === "done";
    return `<path class="edge${e.prove ? " prove" : ""}${hot ? " hot" : ""}${lit ? " lit" : ""}" d="${edgePath(byId[e.from], byId[e.to], e.bends)}" marker-end="url(#arr${hot ? "-hot" : ""})"/>`;
  }).join("");
}
function svgHtml() {
  const dag = curDag();
  const st = statesNow();
  const byId = Object.fromEntries(dag.nodes.map((n) => [n.id, n]));
  const sel = D.sel;
  const nodes = dag.nodes.map((n) => {
    const s = st[n.id];
    return `<g class="node k-${n.kind} d-${s.display}${sel === n.id ? " sel" : ""}${s.by === "you" ? " by-you" : ""}" data-id="${n.id}" transform="translate(${n.x},${n.y})">
      <rect class="body" width="${n.w}" height="${n.h}" rx="10"/>
      ${s.display === "partial" ? `<rect class="half" width="${n.w / 2}" height="${n.h}" rx="10"/><rect class="half-sq" x="${n.w / 2 - 10}" width="10" height="${n.h}"/>` : ""}
      ${n.kind === "word-problem" ? `<rect class="hatch" width="${n.w}" height="${n.h}" rx="10"/>` : ""}
      <rect class="band" width="${n.w}" height="7" rx="3"/>
      <foreignObject x="10" y="10" width="${n.w - 20}" height="${n.h - 14}"><div xmlns="http://www.w3.org/1999/xhtml" class="nt"><b>${esc(n.title)}</b>${n.detail ? `<span>${esc(n.detail)}</span>` : ""}</div></foreignObject>
      ${s.by === "you" ? `<g class="ubadge" transform="translate(12,-6)"><circle r="9"/><text y="4">✎</text></g>` : ""}
      ${cBadge(keyOf(D.board, n.id), n.w)}
    </g>`;
  }).join("");
  const texts = (dag.texts || []).map((t) => `<text class="cap cap-${t.size}" x="${t.x}" y="${t.y + ({ title: 44, large: 30, body: 20 }[t.size] || 20)}">${esc(t.text)}</text>`).join("");
  const v = D.view;
  return `<svg class="dag-svg${D.editing ? " editing" : ""}" viewBox="${v.x} ${v.y} ${v.w} ${v.h}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="ah"/></marker>
      <marker id="arr-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="ah hot"/></marker>
      <pattern id="hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="10" class="hl"/></pattern>
    </defs>${texts}<g class="edges">${edgesHtml(dag, st, byId)}</g><g class="nodes">${nodes}</g></svg>`;
}

function legendHtml() {
  const kinds = BOARD_KINDS[D.board];
  return `<div class="dag-legend">
    <span class="lg d-done"></span>done <span class="lg d-partial"></span>partly <span class="lg d-ready"></span>ready next <span class="lg d-locked"></span>locked
    <span class="sep"></span>${kinds.map((k) => `<span class="lg-band k-${k}"></span>${esc(KIND_LABEL[k])}`).join(" ")}
    <span class="sep"></span><span class="lg-edge"></span>used for <span class="lg-edge prove"></span>${D.board === "methods" ? "sub-step" : "needed to prove"}
    <span class="sep"></span><span class="qb u">✎</span>set by you <span class="lg-c">💬</span>comments${D.editing ? '<span class="sep"></span>drag a block to move it' : ""}</div>`;
}

// The block form (both boards): what it is, and what it builds on. New blocks go in the middle of the view.
function blockFormHtml(n) {
  const board = D.board, dag = D.data[board], key = n ? keyOf(board, n.id) : "";
  const into = (prove) => (n ? dag.edges.filter((e) => e.to === n.id && !!e.prove === prove).map((e) => keyOf(board, e.from)) : []);
  const opts = dag.nodes.filter((x) => !n || x.id !== n.id).map((x) => ({ key: keyOf(board, x.id), label: x.title }));
  const kind = n?.kind || BOARD_KINDS[board][board === "content" ? 2 : 0];
  return `<form class="pe-form" data-layer="${board}" data-key="${esc(key)}"><div class="pe-fields">
    <label>Title <input name="title" value="${esc(n?.title || "")}" required autocomplete="off" /></label>
    <label>Description <textarea name="detail" rows="2">${esc(n?.detail || "")}</textarea></label>
    <label>Kind <select name="kind">${BOARD_KINDS[board].map((k) => `<option value="${k}"${k === kind ? " selected" : ""}>${esc(KIND_LABEL[k])}</option>`).join("")}</select></label>
    <div class="pe-lab">Uses ${pickerHtml("uses", into(false), opts, "Add a block it uses…")}</div>
    <div class="pe-lab">${board === "methods" ? "Sub-steps" : "Needed to prove it"} ${pickerHtml("proves", into(true), opts, "Add a block…")}</div>
    ${board === "methods" ? `<div class="pe-lab">Rests on (content) ${pickerHtml("restsOn", n?.restsOn || [], D.data.content.nodes.map((x) => ({ key: x.id, label: x.title })), "Add a content block…")}</div>` : ""}
    ${formButtons(!n, "Add block")}
  </div></form>`;
}

// The node panel: what the node is, and where the student stands on it. Nothing about how Claude got there.
// While editing it also has Edit / Remove (or the form itself); comments are always there.
function nodePanel(id) {
  if (D.editing && D.edit?.board) return `<div class="np"><div class="k">New ${esc(BOARD_LABEL[D.board].toLowerCase())} block</div>${blockFormHtml(null)}</div>`;
  const dag = curDag(), n = dag.nodes.find((x) => x.id === id);
  if (!n) return `<p class="muted">${D.editing ? "Click a block to change it, drag it to move it, or add one with + Add block." : "Click a block to see where the student stands on it."}</p>`;
  const key = keyOf(D.board, id);
  const head = `<div class="k">${esc(BOARD_LABEL[D.board])} · ${esc(KIND_LABEL[n.kind] || n.kind)}${n.sections?.length ? ` · §${n.sections.join(", §")}` : ""}${D.editing ? ` · <code>${esc(key)}</code>` : ""}</div>`;
  if (D.editing && D.edit === id) return `<div class="np">${head}${blockFormHtml(n)}</div>`;
  const t = statusText(dag, D.board, id, D.data.guess, D.data.overrides, D.data.content);
  const s = statesNow()[id];
  const g = D.data.guess?.nodes?.[key];
  const btn = (v, label) => `<button class="${s.state === v && s.by === "you" ? "on" : ""}" data-set="${v}">${label}</button>`;
  const title = (k) => dag.nodes.find((x) => x.id === k)?.title || k;
  const edits = D.editing ? editBarHtml(id) + (D.remove === id ? removeHtml(id, `“${n.title}”`, dag.edges.filter((e) => e.from === id).map((e) => `“${title(e.to)}”`),
    dag.nodes.filter((x) => x.id !== id).map((x) => ({ key: keyOf(D.board, x.id), label: x.title }))) : "") : "";
  const state = D.editing ? "" : `<div class="np-state d-${t.display}">${esc(t.label)}</div>
    <p class="np-note">${esc(t.note)}</p>
    ${t.missing.length ? `<div class="nls">${t.missing.map((x) => `<button class="link nl" data-goto-key="${esc(x.key)}">${esc(x.title)}</button>`).join("")}</div>` : ""}
    ${n.kind === "word-problem" ? "" : viewingOther() ? `<p class="muted small">Showing v${D.data.version.seq}; ${esc(S.student || "the student")} is on another version, so states can only be changed there.</p>` : `<h4>Change it</h4><div class="seg np-set">${btn("done", "Done")}${btn("partial", "Partly")}${btn("not-yet", "Not yet")}</div>
    ${s.by === "you" ? `<button class="link" data-set="">use Claude's guess${g ? ` (${esc(g.state)})` : ""}</button>` : ""}`}`;
  return `<div class="np">${head}
    <h3 class="np-title">${esc(n.title)}</h3>
    ${n.detail ? `<p>${esc(n.detail)}</p>` : ""}
    ${edits}${state}
    ${commentsHtml(key)}
  </div>`;
}

// Progress map › Inference: unstructured evidence in, Claude's guess out. Files on the left; the guess now on
// the maps on the right, with the full run log a click away in History › Inference.
function inferenceHtml() {
  const notes = D.data.notes || [], g = D.data.guess, runs = D.data.runs || [];
  const last = runs.find((r) => r.id === g?.runId) || runs.find((r) => r.ok);
  const tally = (board) => {
    const ks = (D.data[board]?.nodes || []).map((n) => keyOf(board, n.id)), c = { done: 0, partial: 0, "not-yet": 0 };
    for (const k of ks) c[g?.nodes?.[k]?.state || "not-yet"] = (c[g?.nodes?.[k]?.state || "not-yet"] || 0) + 1;
    return `<li><b>${BOARD_LABEL[board]}</b> ${c.done} done · ${c.partial} partly · ${c["not-yet"]} not yet <button class="link" data-dag-go="${board}">open</button></li>`;
  };
  return `<div class="inf-map">
    <section class="np">
      <h3>Files for Claude</h3>
      <p class="muted small">Drop anything here: photos or PDFs of notes, worksheets, .tex, .md or .txt. When you guess, Claude reads these, every homework .tex in the project and the unit statuses, and guesses what is done on both boards. Each run costs money.</p>
      <label class="drop big" id="dag-drop"><input type="file" multiple accept=".tex,.md,.txt,.pdf,.png,.jpg,.jpeg,.heic,.webp,.gif" hidden /><span>Drop files here or <u>choose files</u></span></label>
      <ul class="notes">${notes.map((n) => `<li><a href="/notes/${encodeURIComponent(n.name)}" target="_blank" rel="noopener">${esc(n.name)}</a><small>${Math.ceil(n.size / 1024)} KB</small><button class="ghost" data-del-note="${esc(n.name)}" title="Delete">✕</button></li>`).join("") || '<li class="muted">No files uploaded yet</li>'}</ul>
    </section>
    <section class="np">
      <h3>Last guess</h3>
      ${last ? `<p class="muted small">${new Date(last.at).toLocaleString()} · ${esc(last.model || "")} · ${fmtUSD(last.costUSD)}${last.files ? ` · ${last.files} files` : ""}</p>
        ${last.summary ? `<p>${esc(last.summary)}</p>` : ""}` : '<p class="muted small">No guess yet.</p>'}
      ${g ? `<ul class="inf-tally">${tally("content")}${tally("methods")}</ul>
        <p class="muted small">Your own settings on a board (set by you, or imported from .md) win over the guess.</p>` : ""}
      <p><button class="link" data-page="history" data-hist="inference">All runs, reasoning and cost in History › Inference →</button></p>
    </section>
  </div>`;
}

// ---------- lesson plan ----------
// Edits go to the course's draft (created from the latest published version on the first edit), never to a
// published version: the student keeps using theirs until the draft is published on Courses and they're upgraded.
const planUnits = () => D.data?.plan?.units || [];
const unitSections = () => (D.data?.plan?.layout || []).map((s, i) => ({ i, heading: s.heading })).filter((s) => !/^gated/i.test(s.heading));
const sectionOf = (key) => (D.data?.plan?.layout || []).findIndex((s) => (s.items || []).some((i) => i.unit === key));
const unitOpts = (except) => planUnits().filter((x) => x.key !== except).map((x) => ({ key: x.key, label: x.name }));
const cToggle = (id) => { const n = commentsOf(id).length; return `<button class="ghost cmt-tog${D.openC === id ? " on" : ""}" data-cmt-toggle="${esc(id)}" title="${n ? `${n} comment${n === 1 ? "" : "s"}` : "Add a comment"}">💬${n ? ` ${n}` : ""}</button>`; };

function planHtml() {
  const groups = lessonPlan(D.data?.plan || S.ladder, S.status);
  if (D.editing) return planEditHtml(groups);
  if (!groups.length) return '<p class="muted plan-empty">This version of the course has no units yet.</p>';
  return `<div class="plan">${groups.map((g) => `
    <section class="plan-group">${g.title ? `<h3>${esc(g.title)}</h3>` : ""}
      <ol class="plan-list">${g.units.map((u) => `
        <li class="plan-unit s-${u.status}" data-unit="${u.id}" title="Show ${u.id} in the DAG">
          <span class="chip s-${u.status}${u.note && u.status === "TAUGHT" ? " partial" : ""}${u.missing.length ? " warn" : ""}">${u.id}</span>
          <div class="plan-body">
            <div class="plan-title"><b>${esc(u.name)}</b> <span class="st s-${u.status}">${STATUS_LABEL[u.status]}</span>${u.stance ? ` <span class="muted small">${esc(u.stance)}</span>` : ""}</div>
            ${u.about ? `<div class="plan-about">${esc(u.about)}</div>` : ""}
            ${u.note ? `<div class="plan-note small">${esc(u.note)}</div>` : ""}
            ${u.guide ? `<div class="muted small plan-guide">${esc(u.guide)}</div>` : ""}
            ${u.needs.length ? `<div class="muted small">Needs ${u.needs.map(esc).join(", ")}${u.missing.length ? ` · <span class="bad-text">${u.missing.map(esc).join(", ")} not taught yet</span>` : ""}</div>` : ""}
            ${D.openC === u.id ? commentsHtml(u.id) : ""}
          </div>
          <span class="plan-acts">${cToggle(u.id)}</span>
        </li>`).join("")}</ol>
    </section>`).join("")}</div>`;
}

function unitRowHtml(u) {
  const neededBy = planUnits().filter((x) => x.needs.includes(u.id)).map((x) => x.key);
  const confirm = D.remove === u.id ? removeHtml(u.id, u.id, neededBy, unitOpts(u.id).map((o) => ({ key: o.key, label: `${o.key} ${o.label}` }))) : "";
  const drag = !D.edit && !D.remove && D.openC !== u.id;
  return `<li class="plan-unit s-${u.status}" data-edit-unit="${esc(u.id)}" data-node="${esc(u.id)}"${drag ? ` draggable="true" title="Drag to reorder"` : ""}>
    ${drag ? '<span class="grip" aria-hidden="true">⋮⋮</span>' : ""}<span class="chip s-${u.status}">${esc(u.id)}</span>
    <div class="plan-body">
      <div class="plan-title"><b>${esc(u.name)}</b>${u.stance ? ` <span class="muted small">${esc(u.stance)}</span>` : ""}</div>
      ${u.about ? `<div class="plan-about">${esc(u.about)}</div>` : ""}
      ${u.guide ? `<div class="muted small plan-guide">${esc(u.guide)}</div>` : ""}
      ${u.needs.length ? `<div class="muted small">Needs ${u.needs.map(esc).join(", ")}</div>` : ""}
      ${confirm}
      ${D.openC === u.id ? commentsHtml(u.id) : ""}
    </div>
    <span class="plan-acts">${cToggle(u.id)}<button class="ghost" data-pe="edit" title="Edit ${esc(u.id)}">✎</button><button class="ghost" data-pe="remove" title="Remove ${esc(u.id)}">✕</button></span>
  </li>`;
}

// The unit form, in the linear list and in the lesson plan DAG's side panel.
function unitFormHtml(u, section) {
  const secs = unitSections();
  return `<form class="pe-form" data-layer="unit" data-key="${esc(u?.key || "")}">
    <span class="chip">${esc(u?.key || "new")}</span>
    <div class="pe-fields">
      <label>Name <input name="name" value="${esc(u?.name || "")}" required autocomplete="off" /></label>
      <label>What it covers <textarea name="about" rows="2">${esc(u?.about || "")}</textarea></label>
      <div class="pe-lab">Needs ${pickerHtml("needs", u?.needs || [], unitOpts(u?.key), "Add a unit it needs…")}</div>
      <label>Stance <input name="stance" value="${esc(u?.stance || "")}" placeholder="Formal / Informal…" list="pe-stances" autocomplete="off" /></label>
      <label>Notes for the homework <input name="notes" value="${esc(u?.notes || "")}" autocomplete="off" /></label>
      ${secs.length ? `<label>Section <select name="section">${secs.map((s) => `<option value="${s.i}"${s.i === section ? " selected" : ""}>${esc(s.heading)}</option>`).join("")}</select></label>` : ""}
      <datalist id="pe-stances"><option value="Formal"></option><option value="Informal"></option></datalist>
      ${formButtons(!u, "Add unit")}
    </div></form>`;
}

function planEditHtml(groups) {
  const byKey = new Map(planUnits().map((u) => [u.key, u]));
  const secs = unitSections();
  // every unit section, even an empty one, so a unit can be added to it
  const shown = secs.map((s) => ({ title: s.heading, section: s.i, units: groups.find((g) => g.section === s.i)?.units || [] }));
  for (const g of groups) if (g.section == null) shown.push(g);
  if (!shown.length) shown.push({ title: "", section: 0, units: groups.flatMap((g) => g.units) });
  const adding = (si) => D.edit && typeof D.edit === "object" && D.edit.section === si;
  const form = (u, si) => `<li class="plan-unit plan-form">${unitFormHtml(u, si)}</li>`;
  return `<div class="plan editing">${shown.map((g) => `
    <section class="plan-group">${g.title ? `<h3>${esc(g.title)}</h3>` : ""}
      <ol class="plan-list"${g.section != null ? ` data-section="${g.section}"` : ""}>${g.units.map((u) => (D.edit === u.id ? form(byKey.get(u.id), g.section) : unitRowHtml(u))).join("")}
        ${adding(g.section) ? form(null, g.section) : g.section != null ? `<li class="plan-add"><button class="link" data-pe="add" data-section="${g.section}">+ Add a unit${g.title ? ` to ${esc(g.title)}` : ""}</button></li>` : ""}
      </ol>
    </section>`).join("")}</div>`;
}

// Every edit, from any of the three views, goes through here.
async function draftEdit(ops, what) {
  let r = null;
  try {
    r = await api("/api/versions/draft", { method: "POST", body: { ops } });
    log("dag-edit", { mode: D.mode, ...what });
    D.edit = null; D.remove = null; D.editErr = "";
    D.data = await api(dagUrl());
  } catch (e) {
    D.editErr = e.message;
    // keep what was typed: show the error in the open form instead of redrawing it
    const row = $("#p-dag .pe-form .pe-row:last-of-type");
    if (row) { row.querySelector(".err")?.remove(); row.insertAdjacentHTML("beforeend", `<span class="err small">${esc(e.message)}</span>`); return null; }
  }
  drawAll();
  return r;
}

async function startEditing() {
  let draft = D.data?.versions?.find((v) => v.status === "draft")?.id;
  if (!draft) draft = (await api("/api/versions/draft", { method: "POST", body: { ops: [], note: "edits in the app" } })).draft;
  Object.assign(D, { editing: true, edit: null, remove: null, editErr: "", version: draft });
  log("dag-edit-mode", { on: true, draft, mode: D.mode });
  await load();
}

// The lesson plan as its DAG. Selecting a unit lights up everything it rests on (ancestors) and everything that
// rests on it (descendants), and dims the rest; implied edges are drawn only for the selected unit.
function planClosure(g, id, dir) {
  const out = new Set(), next = (x) => g.edges.filter((e) => (dir === "up" ? e.to === x : e.from === x)).map((e) => (dir === "up" ? e.from : e.to));
  const walk = (x) => { for (const y of next(x)) if (!out.has(y)) { out.add(y); walk(y); } };
  walk(id); return out;
}
function planSvgHtml() {
  const g = D.graph, sel = g.nodes.some((n) => n.id === D.sel) ? D.sel : null;
  const up = sel ? planClosure(g, sel, "up") : new Set(), down = sel ? planClosure(g, sel, "down") : new Set();
  const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  const ok = (id) => ["TAUGHT", "CURRENT"].includes(byId[id].unit.status);
  const edges = g.edges.map((e) => {
    const touches = sel && (e.from === sel || e.to === sel);
    if (e.implied && !touches) return "";
    const s = byId[e.from], t = byId[e.to];
    const pts = e.pts || [[s.x + s.w / 2, s.y + s.h], [t.x + t.w / 2, t.y]];
    const cls = !sel ? "" : (up.has(e.from) || e.from === sel) && (up.has(e.to) || e.to === sel) ? " anc" : (down.has(e.to) || e.to === sel) && (down.has(e.from) || e.from === sel) ? " desc" : " dim";
    return `<path class="edge${ok(e.from) ? " lit" : ""}${e.implied ? " implied" : ""}${cls}" d="${curvePath(pts)}" marker-end="url(#parr${cls.trim() ? "-" + cls.trim() : ""})"/>`;
  }).join("");
  const nodes = g.nodes.map((n) => {
    const u = n.unit, rel = !sel ? "" : n.id === sel ? " sel" : up.has(n.id) ? " anc" : down.has(n.id) ? " desc" : " dim";
    return `<g class="node pnode ps-${u.status}${n.ready ? " ready" : ""}${u.missing.length ? " warn" : ""}${rel}" data-id="${n.id}" transform="translate(${n.x},${n.y})">
      <title>${esc(u.id)} ${esc(u.name)}${u.needs.length ? ` · needs ${esc(u.needs.join(", "))}` : ""}</title>
      <rect class="body" width="${n.w}" height="${n.h}" rx="10"/>
      ${u.missing.length ? `<circle class="wdot" cx="${n.w - 4}" cy="4" r="5"/>` : ""}
      <foreignObject x="10" y="7" width="${n.w - 20}" height="${n.h - 12}"><div xmlns="http://www.w3.org/1999/xhtml" class="nt"><b><span class="pid">${esc(u.id)}</span> ${esc(u.name)}</b><span>${esc(STATUS_LABEL[u.status])}${n.ready ? " · ready" : ""}</span></div></foreignObject>
      ${cBadge(u.id, n.w - (u.missing.length ? 12 : 0))}
    </g>`;
  }).join("");
  const v = D.view;
  const mk = (id, cls) => `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="ah${cls}"/></marker>`;
  return `<svg class="dag-svg plan-dag" viewBox="${v.x} ${v.y} ${v.w} ${v.h}" xmlns="http://www.w3.org/2000/svg">
    <defs>${mk("parr", "")}${mk("parr-anc", " anc")}${mk("parr-desc", " desc")}${mk("parr-dim", " dim")}</defs>
    <g class="edges">${edges}</g><g class="nodes">${nodes}</g></svg>`;
}

function planPanel(id) {
  if (D.editing && D.edit && typeof D.edit === "object") return `<div class="np"><div class="k">New unit</div>${unitFormHtml(null, D.edit.section)}</div>`;
  const g = D.graph, n = g.nodes.find((x) => x.id === id);
  if (!n) return `<p class="muted">${D.editing ? "Click a unit to change or remove it, or add one with + Add unit." : "Click a unit to see what it needs and what it opens up. Its prerequisites light up in green, the units that build on it in blue."}</p>`;
  const u = n.unit, name = (k) => g.nodes.find((x) => x.id === k)?.unit.name || "";
  if (D.editing && D.edit === id) return `<div class="np"><div class="k">Unit ${esc(u.id)}</div>${unitFormHtml(planUnits().find((x) => x.key === id), sectionOf(id))}</div>`;
  const links = (ks) => `<div class="nls">${[...ks].map((k) => `<button class="link nl" data-goto-unit="${esc(k)}"><b>${esc(k)}</b> ${esc(name(k))}</button>`).join("")}</div>`;
  const direct = g.edges.filter((e) => e.from === id).map((e) => e.to), all = planClosure(g, id, "down"), anc = planClosure(g, id, "up");
  const known = new Set(g.nodes.map((x) => x.id)), unknown = u.needs.filter((k) => !known.has(k));
  const edits = D.editing ? editBarHtml(id) + (D.remove === id ? removeHtml(id, u.id, direct, unitOpts(id).map((o) => ({ key: o.key, label: `${o.key} ${o.label}` }))) : "") : "";
  return `<div class="np">
    <div class="k">Unit ${esc(u.id)}${u.stance ? ` · ${esc(u.stance)}` : ""}</div>
    <h3 class="np-title">${esc(u.name)}</h3>
    ${u.about ? `<p>${esc(u.about)}</p>` : ""}
    ${edits}
    <div class="np-state ps-${u.status}">${esc(STATUS_LABEL[u.status])}${n.ready ? " · ready: everything it needs is taught" : ""}</div>
    ${u.note ? `<p class="plan-note small">${esc(u.note)}</p>` : ""}
    ${u.guide ? `<p class="muted small plan-guide">${esc(u.guide)}</p>` : ""}
    ${u.missing.length ? `<p class="bad-text small">${u.missing.map(esc).join(", ")} not taught yet</p>` : ""}
    <h4>Needs</h4>${u.needs.length ? links(u.needs.filter((k) => known.has(k))) : '<p class="muted small">Nothing: it can start any time.</p>'}
    ${unknown.length ? `<p class="muted small">Also lists ${unknown.map(esc).join(", ")}, not in this version.</p>` : ""}
    ${anc.size > u.needs.length ? `<p class="muted small">${anc.size} units in all lie under it.</p>` : ""}
    <h4>Needed by</h4>${direct.length ? links(direct) : '<p class="muted small">No unit builds on it directly.</p>'}
    ${all.size > direct.length ? `<p class="muted small">${all.size} units in all build on it.</p>` : ""}
    ${commentsHtml(u.id)}
  </div>`;
}

function planLegendHtml() {
  return `<div class="dag-legend">
    <span class="lg ps-TAUGHT"></span>taught <span class="lg ps-CURRENT"></span>current <span class="lg ps-NEXT"></span>next <span class="lg ps-FUTURE"></span>future <span class="lg ps-FUTURE ready"></span>ready (needs all taught)
    <span class="sep"></span><span class="lg-edge"></span>needed for <span class="lg-edge implied"></span>implied by a longer chain (shown for the selected unit)
    <span class="sep"></span><span class="wdot-lg"></span>a need is not taught yet <span class="lg-c">💬</span>comments</div>`;
}

// ---------- page ----------

// The header: which curriculum and version this is, then the view's own controls; Edit history sits top right.
function titleHtml() {
  const v = D.data?.version, cur = D.data?.curriculum?.title || S.curriculum || "";
  const ver = v ? `v${v.seq}${v.status === "draft" ? " · draft" : ""}${v.id === v.enrolled ? ` · ${S.student || "the student"}'s version` : ""}` : "";
  return `<div class="dag-title"><div class="eyebrow">Progress map › ${esc(MODE_LABEL[D.mode])}</div>
    <h2>${esc(cur || "Progress map")}${ver ? ` <span class="dag-ver${v.status === "draft" ? " draft" : ""}">${esc(ver)}</span>` : ""}</h2></div>`;
}
const planViewSeg = () => `<div class="seg plan-view">${["linear", "dag"].map((v) => `<button data-plan-view="${v}" class="${D.planView === v ? "on" : ""}">${{ linear: "Linear", dag: "DAG" }[v]}</button>`).join("")}</div>`;
const fitBtn = () => (D.mode !== "plan" || planDag() ? '<button class="ghost" data-act="fit" title="Fit to screen">⤢</button>' : "");

function headBodyHtml() {
  const job = D.data?.job, running = job?.running;
  if (D.editing) {
    const n = D.mode === "plan" ? planUnits().length : curDag()?.nodes.length || 0, what = D.mode === "plan" ? "unit" : "block";
    return `<span class="dag-count"><b>Editing draft v${D.data.version.seq}</b> · ${n} ${what}${n === 1 ? "" : "s"}</span>
      ${D.mode === "plan" ? planViewSeg() : ""}
      <button class="secondary" data-act="add-node">+ Add ${what}</button>
      <span class="spacer"></span><span class="muted small">Publish the draft on <button class="link" data-page="courses">Courses</button> to use it</span>
      ${fitBtn()}<button class="primary" data-act="edit-done">Done</button>`;
  }
  if (D.mode === "plan") {
    const us = lessonPlan(D.data?.plan || S.ladder, S.status).flatMap((g) => g.units), n = (s) => us.filter((u) => u.status === s).length;
    const ready = planDag() && D.graph ? D.graph.nodes.filter((x) => x.ready).length : 0;
    return `<span class="dag-count"><b>${n("TAUGHT")} of ${us.length} taught</b> · ${n("CURRENT")} current${n("NEXT") ? ` · ${n("NEXT")} next` : ""}${ready ? ` · ${ready} ready` : ""}</span>
      ${planViewSeg()}
      <span class="spacer"></span><span class="muted small">Statuses from the app's status record · change them on Create Homework</span>
      <button class="ghost" data-act="status-export" title="Download the whole status record (unit statuses, review priority, standing conventions, history) as Markdown">Export status.md</button>
      <button class="ghost" data-act="status-upload" title="Replace the status record with an edited status.md (the old one stays in the history)">Import status.md</button>${versionPicker()}${fitBtn()}
      <button class="secondary" data-act="edit" title="Add, change or remove units in the course's draft">Edit units</button>`;
  }
  if (D.mode === "inference") {
    return `<span class="spacer"></span>
      ${running ? `<span class="muted small"><span class="spin"></span> Claude is reading the homework and notes… ${Math.round((job.elapsed || 0) / 1000)}s${job.tools?.length ? ` · read ${job.tools.length} file${job.tools.length > 1 ? "s" : ""}` : ""}</span><button class="secondary" data-act="stop-guess">Stop</button>`
        : `${job?.error ? `<span class="bad-text small" title="${esc(job.error)}">Last guess failed</span>` : ""}<button class="primary" data-act="guess" title="One ${esc(D.data.guessModel || "")} run over every homework file and these files, for both boards">${D.data.guess ? "Guess again" : "Guess progress"}</button>`}`;
  }
  const c = counts(curDag(), statesNow()), count = `<span class="dag-count"><b>${c.done} of ${c.total} done</b>${c.partial ? ` · ${c.partial} partly` : ""} · ${c.ready} ready</span>`;
  const name = D.board === "methods" ? "methods.md" : "content.md";
  return `${count}
    <span class="spacer"></span>
    ${viewingOther() ? `<span class="muted small">Viewing v${D.data.version.seq}, read through the course's lineage</span>` : `${running ? `<span class="muted small"><span class="spin"></span> Claude is guessing…</span>` : ""}
      <button class="ghost" data-act="board-export" title="Download every block on this board with its state as Markdown">Export ${name}</button>
      <button class="ghost" data-act="board-import" title="Set states from an edited ${name}: each changed line becomes your setting, auto goes back to Claude's guess">Import ${name}</button>`}
    ${versionPicker()}${fitBtn()}
    <button class="secondary" data-act="edit" title="Add, change, link, move or remove blocks in the course's draft">Edit board</button>`;
}
const headHtml = () => `<div class="dag-head row">${titleHtml()}${headBodyHtml()}
  <button class="ghost dag-hist" data-act="history" title="Every change to this curriculum: edits, imports, publishes and comments">↺ Edit history</button></div>`;

// Which version of the course to show. The student's own (enrolled) version is the default and the only one
// where states can be changed; any other shows their progress read through the course's lineage.
const viewingOther = () => D.data?.version && D.data.version.id !== D.data.version.enrolled;
function versionPicker() {
  const vs = D.data?.versions || [];
  if (vs.length < 2) return "";
  const en = D.data.version.enrolled;
  return `<select class="dag-version" title="Version of the course to show">${[...vs].reverse().map((v) =>
    `<option value="${v.id}"${v.id === D.data.version.id ? " selected" : ""}>v${v.seq}${v.status === "draft" ? " (draft)" : ""}${v.id === en ? ` · ${esc(S.student || "student")}'s` : ""}</option>`).join("")}</select>`;
}

function syncSidebar() {
  for (const b of $$("[data-dag]")) b.classList.toggle("on", b.dataset.dag === D.mode);
}

function drawAll() {
  const d = $("#p-dag");
  syncSidebar();
  if (D.editing && D.data?.version && D.data.version.status !== "draft") Object.assign(D, { editing: false, edit: null, remove: null, editErr: "" });
  if (D.mode === "plan" && D.planView === "dag") {
    const groups = lessonPlan(D.data?.plan || S.ladder, S.status);
    D.graph = planGraph(groups);
    if (!D.graph.nodes.length) { d.innerHTML = `${headHtml()}${D.editing && D.edit ? `<div class="plan">${planPanel(null)}</div>` : planHtml()}`; return; }
    D.view ||= bbox(D.graph);
    d.innerHTML = `${headHtml()}
      <div class="dag-main"><div class="dag-canvas">${planSvgHtml()}</div>
        <aside class="dag-side"><div class="side-body">${planPanel(D.sel)}</div></aside></div>
      ${planLegendHtml()}`;
    return;
  }
  if (D.mode === "plan") { d.innerHTML = `${headHtml()}${planHtml()}`; return; }
  if (!D.data) { d.innerHTML = `<p class="muted">Loading…</p>`; return; }
  if (D.mode === "inference") { if (D.editing) Object.assign(D, { editing: false, edit: null, remove: null, editErr: "", version: null }); d.innerHTML = `${headHtml()}${inferenceHtml()}`; return; }
  if (!curDag()) { d.innerHTML = `<div class="row dag-head">${titleHtml()}</div><p class="err">ui/data/wu_dag.json is missing.</p>`; return; }
  D.view ||= bbox(curDag());
  d.innerHTML = `${headHtml()}
    <div class="dag-main"><div class="dag-canvas">${svgHtml()}</div>
      <aside class="dag-side"><div class="side-body">${nodePanel(D.sel)}</div></aside></div>
    ${legendHtml()}`;
}
function drawSvgOnly() { const c = $("#p-dag .dag-canvas"); if (c) c.innerHTML = planDag() ? planSvgHtml() : svgHtml(); }
// someone is typing in a form on the page: background refreshes leave it alone
const typing = () => !!document.activeElement?.closest?.("#p-dag form");

const dagUrl = () => (D.version ? `/api/dag?version=${D.version}` : "/api/dag");
async function load() {
  try { D.data = await api(dagUrl()); } catch (e) { if (e.status === 404 && D.version) { D.version = null; D.data = await api(dagUrl()); } else throw e; }
  drawAll();
  startPoll();
}
function startPoll() {
  clearInterval(D.poll);
  if (D.data.job?.running) D.poll = setInterval(async () => {
    D.data = await api(dagUrl());
    if (!D.data.job?.running) clearInterval(D.poll);
    if (!$("#p-dag").hidden && !typing()) drawAll();
  }, 2000);
}

// Show one block ("eNN" or "m:eNN") on its board, selected: used by links here and from History › Inference.
export function focusNode(k) {
  const mode = k.startsWith("m:") ? "methods" : "content";
  if (mode !== D.board || D.mode === "plan") D.view = null;
  D.mode = mode; D.sel = k.replace(/^m:/, ""); D.side = "info";
  log("dag-mode", { mode });
}

export async function openDag(btn) {
  if (btn?.dataset.dag && btn.dataset.dag !== D.mode) { const wasBoard = D.board, wasPlan = planDag(); D.mode = btn.dataset.dag; Object.assign(D, { edit: null, remove: null, editErr: "", cEdit: null }); if (D.board !== wasBoard || planDag() !== wasPlan) { D.sel = null; D.view = null; } }
  if (!D.data) drawAll();
  await load();
}

async function setNode(key, state) {
  const r = await api("/api/dag", { method: "PUT", body: { id: key, state: state || null } });
  D.data.overrides = r.overrides;
  drawAll();
}

async function commentCall(path, method, body) {
  try {
    const r = await api(path, { method, body });
    D.data.comments = r.comments; D.cEdit = null; D.cErr = "";
    log("dag-comment", { method, path });
  } catch (e) { D.cErr = e.message; }
  drawAll();
}

// ---------- edit history (the dialog behind the header's top-right button) ----------
const HIST_FILTERS = { all: ["All", () => true], content: ["Content", (r) => r.layer === "content"], methods: ["Methods", (r) => r.layer === "methods"],
  unit: ["Lesson plan", (r) => r.layer === "unit"], comments: ["Comments", (r) => r.op.startsWith("comment")], versions: ["Versions", (r) => ["version", "publish", "discard", "import"].includes(r.op)] };
const OP_ICON = { add: "+", edit: "✎", move: "↔", remove: "✕", lineage: "→", link: "⟶", unlink: "⤫", reorder: "⇅", covers: "⊂", "plan-text": "¶", gated: "⊘", ladder: "¶", note: "✎",
  comment: "💬", "comment-edit": "💬", "comment-delete": "💬", version: "◇", publish: "✓", discard: "🗑", import: "⇩" };
function histDetailHtml(r) {
  const d = r.detail || {}, field = (f) => esc({ detail: "description", about: "what it covers", proves: "needed to prove", restsOn: "rests on" }[f] || f);
  const rows = (d.changes || []).map((c) => `<tr><th>${field(c.field)}</th><td class="he-b">${esc(c.before) || '<span class="muted">—</span>'}</td><td class="he-arrow">→</td><td class="he-a">${esc(c.after) || '<span class="muted">—</span>'}</td></tr>`);
  const snap = (s) => Object.entries(s || {}).filter(([, v]) => (Array.isArray(v) ? v.length : v !== "" && v != null)).map(([f, v]) => `<tr><th>${field(f)}</th><td colspan="3">${esc(Array.isArray(v) ? v.join(", ") : v)}</td></tr>`);
  const body = rows.length ? rows : d.after && typeof d.after === "object" ? snap(d.after) : d.before && typeof d.before === "object" ? snap(d.before) : [];
  let quote = typeof d.after === "string" ? d.after : typeof d.before === "string" ? d.before : "";
  if (quote && r.summary.includes(quote)) quote = ""; // the summary already says it
  if (!body.length && !quote) return "";
  return `<details class="he-more"><summary>details</summary>${body.length ? `<table class="he-t">${body.join("")}</table>` : ""}${quote ? `<blockquote>${esc(quote)}</blockquote>` : ""}</details>`;
}
function histHtml() {
  const h = D.hist, title = D.data?.curriculum?.title || "this curriculum";
  const [, keep] = HIST_FILTERS[h.filter] || HIST_FILTERS.all, shown = (h.data || []).filter(keep);
  const here = (r) => r.key && (r.layer === "unit" ? planUnits().some((u) => u.key === r.key) : r.layer === "methods" ? D.data?.methods?.nodes.some((n) => "m:" + n.id === r.key) : D.data?.content?.nodes.some((n) => n.id === r.key));
  const days = [];
  for (const r of shown) { const day = new Date(r.at).toLocaleDateString([], { weekday: "short", year: "numeric", month: "short", day: "numeric" }); if (days.at(-1)?.day !== day) days.push({ day, rows: [] }); days.at(-1).rows.push(r); }
  const list = h.err ? `<p class="err">${esc(h.err)}</p>` : !h.data ? '<p class="muted">Loading…</p>' : !shown.length ? '<p class="muted">Nothing here yet.</p>' : days.map((g) => `
    <h3 class="he-day">${esc(g.day)}</h3>
    <ol class="he-list">${g.rows.map((r) => `<li class="he op-${esc(r.op)}">
      <time>${esc(new Date(r.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}</time>
      <span class="he-ic" aria-hidden="true">${OP_ICON[r.op] || "·"}</span>
      <div class="he-main"><div class="he-sum">${esc(r.summary)}
        ${here(r) ? ` <button class="link small" data-hist-go="${esc(r.key)}" data-layer="${esc(r.layer)}">show</button>` : ""}</div>
        <div class="he-tags">${r.layer ? `<span class="he-tag l-${esc(r.layer)}">${esc(LAYER_LABEL[r.layer] || r.layer)}</span>` : ""}${r.seq ? `<span class="he-tag">v${r.seq}</span>` : ""}${r.source && r.source !== "app" ? `<span class="he-tag src">${esc({ file: "curriculum_ladder.md edited", import: "whiteboard" }[r.source] || r.source)}</span>` : ""}</div>
        ${histDetailHtml(r)}</div></li>`).join("")}</ol>`).join("");
  return `<div class="row he-head"><div><div class="eyebrow">Edit history</div><h2>${esc(title)}</h2></div><span class="spacer"></span><button class="ghost" data-hist-close title="Close">✕</button></div>
    <p class="muted small">Every change to the course: edits on the content board, the methods board and the lesson plan, whiteboard imports, drafts started, published and discarded, and comments. Newest first.</p>
    <div class="seg he-filters">${Object.entries(HIST_FILTERS).map(([k, [label, f]]) => `<button data-hist-filter="${k}" class="${h.filter === k ? "on" : ""}">${label}${h.data ? ` <span class="muted">${h.data.filter(f).length}</span>` : ""}</button>`).join("")}</div>
    <div class="he-scroll">${list}</div>`;
}
async function openHistory() {
  const dlg = $("#dag-hist-dlg");
  D.hist.err = "";
  dlg.innerHTML = histHtml();
  if (!dlg.open) dlg.showModal();
  try { D.hist.data = (await api("/api/dag/history")).edits; } catch (e) { D.hist.err = e.message; }
  log("dag-history", { entries: D.hist.data?.length ?? null });
  dlg.innerHTML = histHtml();
}
function initHistory() {
  const dlg = $("#dag-hist-dlg"); if (!dlg) return;
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) return dlg.close(); // the backdrop
    const f = e.target.closest("[data-hist-filter]"); if (f) { D.hist.filter = f.dataset.histFilter; log("dag-history-filter", { filter: D.hist.filter }); dlg.innerHTML = histHtml(); return; }
    if (e.target.closest("[data-hist-close]")) return dlg.close();
    const go = e.target.closest("[data-hist-go]");
    if (go) {
      dlg.close();
      const k = go.dataset.histGo;
      if (go.dataset.layer === "unit") { Object.assign(D, { mode: "plan", planView: "dag", sel: k, view: null }); try { localStorage.setItem(PLAN_VIEW_KEY, "dag"); } catch {} }
      else focusNode(k);
      log("dag-history-go", { key: k });
      drawAll();
    }
  });
}

async function upload(files) {
  for (const f of files) {
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    try { const r = await api("/api/notes", { method: "POST", body: { name: f.name, data: btoa(bin) } }); D.data.notes = r.notes; }
    catch (e) { alert(`${f.name}: ${e.message}`); }
  }
  drawAll();
}

// Replace the status record with an edited status.md. The server checks it looks like one; the previous
// revision stays in the status history.
function uploadStatus() {
  const inp = Object.assign(document.createElement("input"), { type: "file", accept: ".md,.markdown,.txt,text/markdown,text/plain" });
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    const text = await f.text();
    const { map } = parseUnitStatuses(text);
    const n = Object.keys(map).length;
    if (!confirm(`Replace ${S.student || "the student"}'s status with ${f.name} (${n} unit${n === 1 ? "" : "s"} with a status)? The current one stays in the status history.`)) return;
    try { await api("/api/status", { method: "PUT", body: { text, source: "upload" } }); }
    catch (err) { return alert(err.message); }
    S.status = S.savedStatus = text.replace(/\r\n/g, "\n");
    log("status-upload", { name: f.name, units: n });
    load();
  };
  inp.click();
}

// Set this board's states from an edited content.md / methods.md (progressmd.js). The page parses it first to
// say what will change; the server parses it again and refuses the whole file on any error.
function importBoard() {
  const board = D.board;
  const inp = Object.assign(document.createElement("input"), { type: "file", accept: ".md,.markdown,.txt,text/markdown,text/plain" });
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    const text = await f.text();
    const { changes, errors } = parseBoardMd(text, { board, dag: D.data[board], guess: D.data.guess, overrides: D.data.overrides });
    if (errors.length) return alert(`${f.name} was not imported:\n${errors.slice(0, 8).join("\n")}${errors.length > 8 ? `\n(and ${errors.length - 8} more)` : ""}`);
    if (!changes.length) return alert(`${f.name} matches the ${BOARD_LABEL[board].toLowerCase()} board already. Nothing to change.`);
    const auto = changes.filter((x) => x.state == null).length;
    if (!confirm(`Set ${changes.length} block${changes.length === 1 ? "" : "s"} on the ${BOARD_LABEL[board].toLowerCase()} board from ${f.name}${auto ? ` (${auto} back to Claude's guess)` : ""}?`)) return;
    try { const r = await api("/api/dag/import", { method: "POST", body: { board, text } }); D.data.overrides = r.overrides; }
    catch (err) { return alert(err.message); }
    log("dag-import", { board, name: f.name, changed: changes.length });
    drawAll();
  };
  inp.click();
}

const focusForm = () => $("#p-dag .pe-form input[name=name], #p-dag .pe-form input[name=title]")?.focus();
const listKeys = (f, n) => (f.elements[n]?.value || "").split(",").filter(Boolean);

export function initDag() {
  const d = $("#p-dag");
  initHistory();
  d.addEventListener("click", async (e) => {
    const t = e.target;
    const go = t.closest("[data-dag-go]"); if (go) { D.mode = go.dataset.dagGo; D.sel = null; D.view = null; log("dag-mode", { mode: D.mode }); return drawAll(); }
    const pv = t.closest("[data-plan-view]");
    if (pv) {
      if (pv.dataset.planView === D.planView) return;
      Object.assign(D, { planView: pv.dataset.planView, sel: null, view: null, edit: null, remove: null, editErr: "" });
      try { localStorage.setItem(PLAN_VIEW_KEY, D.planView); } catch {}
      log("plan-view", { view: D.planView }); return drawAll();
    }
    // key pickers
    const kd = t.closest("[data-kp-del]");
    if (kd) { const kp = kd.closest(".kp"), chip = kd.closest(".kp-chip"), hid = $("input[type=hidden]", kp); hid.value = hid.value.split(",").filter((k) => k && k !== chip.dataset.k).join(","); chip.remove(); return; }
    // comments: before anything that reacts to a click on the node around them
    const ct = t.closest("[data-cmt-toggle]");
    if (ct) { D.openC = D.openC === ct.dataset.cmtToggle ? null : ct.dataset.cmtToggle; D.cEdit = null; D.cErr = ""; drawAll(); if (D.openC) $(`#p-dag .cmts[data-ckey="${CSS.escape(D.openC)}"] textarea`)?.focus(); return; }
    if (t.closest(".cmts")) {
      const c = t.closest("[data-cmt]"); if (!c) return;
      const id = Number(c.closest("[data-cid]")?.dataset.cid);
      D.cErr = "";
      if (c.dataset.cmt === "edit") { D.cEdit = id; drawAll(); return $("#p-dag .cmt-form[data-cid] textarea")?.focus(); }
      if (c.dataset.cmt === "cancel") { D.cEdit = null; return drawAll(); }
      if (c.dataset.cmt === "delete") return commentCall(`/api/comments/${id}`, "DELETE");
      return;
    }
    const pe = t.closest("[data-pe]");
    if (pe && D.editing) {
      const act = pe.dataset.pe, id = pe.closest("[data-node]")?.dataset.node;
      D.editErr = "";
      if (act === "edit") { D.edit = id; D.remove = null; }
      else if (act === "add") { D.edit = { section: Number(pe.dataset.section) }; D.remove = null; }
      else if (act === "remove") { D.remove = id; D.edit = null; }
      else if (act === "cancel") { D.edit = null; D.remove = null; }
      else if (act === "retire") { if (D.sel === id) D.sel = null; return draftEdit([{ op: "removeNode", key: nodeKey(id), relation: "retired" }], { op: "remove", key: nodeKey(id), relation: "retired" }); }
      else if (act === "merge") { const into = pe.parentElement.querySelector(".pe-into")?.value; if (into) { if (D.sel === id) D.sel = D.mode === "plan" ? into : into.replace(/^m:/, ""); return draftEdit([{ op: "removeNode", key: nodeKey(id), relation: "merged", into: [into] }], { op: "remove", key: nodeKey(id), relation: "merged", into }); } }
      drawAll();
      if (act === "edit" || act === "add") focusForm();
      return;
    }
    const pu = t.closest(".plan-unit[data-unit]");
    if (pu) { D.planView = "dag"; D.sel = pu.dataset.unit; D.view = null; try { localStorage.setItem(PLAN_VIEW_KEY, "dag"); } catch {} log("plan-view", { view: "dag", from: pu.dataset.unit }); return drawAll(); }
    const gu = t.closest("[data-goto-unit]"); if (gu) { D.sel = gu.dataset.gotoUnit; Object.assign(D, { edit: null, remove: null, cEdit: null }); log("dag-select", { board: "plan", id: D.sel }); return drawAll(); }
    const a = t.closest("[data-act]");
    if (a?.dataset.act === "history") return openHistory();
    if (a?.dataset.act === "edit") { try { await startEditing(); } catch (err) { alert(err.message); } return; }
    if (a?.dataset.act === "edit-done") { Object.assign(D, { editing: false, edit: null, remove: null, editErr: "", version: null }); log("dag-edit-mode", { on: false }); return load(); }
    if (a?.dataset.act === "add-node") {
      Object.assign(D, { edit: D.mode === "plan" ? { section: unitSections()[0]?.i ?? 0 } : { board: D.board }, remove: null, editErr: "", side: "info" });
      if (D.mode !== "plan") D.sel = null;
      drawAll(); return focusForm();
    }
    if (a?.dataset.act === "fit") { D.view = bbox(curDag()); return drawSvgOnly(); }
    if (a?.dataset.act === "status-export") { log("status-export", {}); location.href = "/api/status/export"; return; }
    if (a?.dataset.act === "status-upload") return uploadStatus();
    if (a?.dataset.act === "board-export") { log("dag-export", { board: D.board }); location.href = `/api/dag/export?board=${D.board}`; return; }
    if (a?.dataset.act === "board-import") return importBoard();
    if (a?.dataset.act === "guess") { try { await api("/api/dag/guess", { method: "POST" }); } catch (err) { alert(err.message); } return load(); }
    if (a?.dataset.act === "stop-guess") { await api("/api/dag/guess/stop", { method: "POST" }); return setTimeout(load, 500); }
    const s = t.closest("[data-set]"); if (s && D.sel) return setNode(keyOf(D.board, D.sel), s.dataset.set);
    const gk = t.closest("[data-goto-key]"); if (gk) { focusNode(gk.dataset.gotoKey); return drawAll(); }
    const dn = t.closest("[data-del-note]"); if (dn) { if (!confirm(`Delete ${dn.dataset.delNote}?`)) return; const r = await api(`/api/notes/${encodeURIComponent(dn.dataset.delNote)}`, { method: "DELETE" }); D.data.notes = r.notes; return drawAll(); }
  });
  d.addEventListener("submit", async (e) => {
    e.preventDefault();
    const cf = e.target.closest(".cmt-form");
    if (cf) {
      const text = cf.elements.text.value.trim(); if (!text) return;
      return cf.dataset.cid ? commentCall(`/api/comments/${cf.dataset.cid}`, "PATCH", { text }) : commentCall("/api/comments", "POST", { key: cf.closest(".cmts").dataset.ckey, text });
    }
    const f = e.target.closest(".pe-form"); if (!f) return;
    // text left in a picker's input counts if it names a node
    for (const kp of $$(".kp", f)) if ($(".kp-in", kp).value.trim() && !kpAdd(kp)) { D.editErr = `“${$(".kp-in", kp).value.trim()}”: pick one from the list`; return drawAll(); }
    const v = (n) => f.elements[n]?.value.trim() ?? "";
    const key = f.dataset.key || undefined, layer = f.dataset.layer;
    if (layer === "unit") {
      const fields = { name: v("name").replace(/\.$/, ""), about: v("about").replace(/\s+/g, " "), needs: listKeys(f, "needs"), stance: v("stance").replace(/\.$/, ""), notes: v("notes") };
      if (f.elements.section) fields.section = Number(f.elements.section.value);
      const r = await draftEdit([{ op: "upsertNode", layer: "unit", key, check: true, fields }], { op: key ? "edit" : "add", key });
      if (r && !key && planDag()) { D.sel = r.keys[0]; drawAll(); }
      return;
    }
    const fields = { title: v("title"), detail: v("detail").replace(/\s+/g, " "), kind: v("kind"), uses: listKeys(f, "uses"), proves: listKeys(f, "proves") };
    if (layer === "methods") fields.restsOn = listKeys(f, "restsOn");
    if (!key) { const c = D.view; Object.assign(fields, { x: Math.round((c.x + c.w / 2 - 115) / 10) * 10, y: Math.round((c.y + c.h / 2 - 44) / 10) * 10 }); }
    const r = await draftEdit([{ op: "upsertNode", layer, key, check: true, fields }], { op: key ? "edit" : "add", key });
    if (r) { D.sel = (key || r.keys[0]).replace(/^m:/, ""); drawAll(); }
  });
  d.addEventListener("input", (e) => { if (e.target.matches(".kp-in")) kpAdd(e.target.closest(".kp"), true); });
  // drag a unit to reorder it within its section (Lesson plan › Edit units)
  let dragging = null;
  const clearMarks = () => $$("#p-dag .drop-before, #p-dag .drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
  const dropSpot = (e) => {
    const li = e.target.closest?.("li[data-edit-unit]");
    if (!dragging || !li || li.parentElement !== dragging.parentElement) return null;
    const r = li.getBoundingClientRect();
    return { li, after: e.clientY > r.top + r.height / 2 };
  };
  d.addEventListener("dragstart", (e) => {
    const li = e.target.closest?.("li[data-edit-unit][draggable]"); if (!li || !D.editing) return;
    dragging = li; li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", li.dataset.editUnit);
  });
  d.addEventListener("dragover", (e) => {
    const s = dropSpot(e); if (!s) return;
    e.preventDefault(); clearMarks();
    if (s.li !== dragging) s.li.classList.add(s.after ? "drop-after" : "drop-before");
  });
  d.addEventListener("drop", (e) => {
    const s = dropSpot(e); if (!s) return;
    e.preventDefault();
    const list = dragging.parentElement, keys = [...list.querySelectorAll(":scope > li[data-edit-unit]")].map((x) => x.dataset.editUnit);
    const from = dragging.dataset.editUnit, to = s.li.dataset.editUnit, next = keys.filter((k) => k !== from);
    next.splice(next.indexOf(to) + (s.after ? 1 : 0), 0, from);
    if (to === from || next.join() === keys.join()) return;
    draftEdit([{ op: "orderUnits", section: Number(list.dataset.section), keys: next }], { op: "reorder", key: from, before: next[next.indexOf(from) + 1] || null });
  });
  d.addEventListener("dragend", () => { dragging?.classList.remove("dragging"); dragging = null; clearMarks(); });
  d.addEventListener("keydown", (e) => {
    if (e.target.matches?.(".kp-in") && e.key === "Enter") { e.preventDefault(); if (!kpAdd(e.target.closest(".kp"))) e.target.classList.add("bad"); return; }
    if (e.target.matches?.(".cmt-form textarea") && e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.target.form.requestSubmit(); return; }
    if (e.key === "Escape" && (D.cEdit || (D.editing && (D.edit || D.remove)))) { Object.assign(D, { edit: null, remove: null, editErr: "", cEdit: null, cErr: "" }); drawAll(); }
  });
  d.addEventListener("change", (e) => {
    if (e.target.matches("#dag-drop input")) upload([...e.target.files]);
    if (e.target.matches(".dag-version")) {
      const id = Number(e.target.value);
      D.version = id === D.data?.version?.enrolled ? null : id; D.sel = null; D.view = null;
      log("dag-version", { version: id }); load();
    }
  });
  d.addEventListener("dragover", (e) => { if (e.target.closest("#dag-drop")) { e.preventDefault(); e.target.closest("#dag-drop").classList.add("over"); } });
  d.addEventListener("dragleave", (e) => e.target.closest?.("#dag-drop")?.classList.remove("over"));
  d.addEventListener("drop", (e) => { if (e.target.closest("#dag-drop")) { e.preventDefault(); upload([...e.dataTransfer.files]); } });

  // pan (drag the background or a node) and zoom (wheel / pinch) by editing the viewBox; while editing a board,
  // dragging a block moves it instead (its hand-drawn bends give way to plain elbows)
  const toBoard = (svg, cx, cy) => { const r = svg.getBoundingClientRect(), v = D.view, k = Math.max(v.w / r.width, v.h / r.height); return { x: v.x + (cx - r.left - (r.width - v.w / k) / 2) * k, y: v.y + (cy - r.top - (r.height - v.h / k) / 2) * k, k }; };
  d.addEventListener("wheel", (e) => {
    const svg = e.target.closest(".dag-svg"); if (!svg) return;
    e.preventDefault();
    const p = toBoard(svg, e.clientX, e.clientY), f = Math.exp((e.ctrlKey ? e.deltaY * 2 : e.deltaY) * 0.0015), v = D.view;
    const w = Math.min(12000, Math.max(300, v.w * f)), s = w / v.w;
    D.view = { x: p.x - (p.x - v.x) * s, y: p.y - (p.y - v.y) * s, w, h: v.h * s };
    svg.setAttribute("viewBox", `${D.view.x} ${D.view.y} ${D.view.w} ${D.view.h}`);
  }, { passive: false });
  d.addEventListener("pointerdown", (e) => {
    const svg = e.target.closest(".dag-svg"); if (!svg || e.button !== 0) return;
    const node = e.target.closest(".node")?.dataset.id, n = node && D.editing && !planDag() && D.mode !== "plan" ? curDag().nodes.find((x) => x.id === node) : null;
    D.dragging = { sx: e.clientX, sy: e.clientY, v: { ...D.view }, k: toBoard(svg, 0, 0).k, moved: false, node, move: n ? { n, x0: n.x, y0: n.y } : null };
    svg.setPointerCapture(e.pointerId);
  });
  d.addEventListener("pointermove", (e) => {
    const g = D.dragging; if (!g) return;
    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) g.moved = true;
    if (!g.moved) return;
    if (g.move) {
      const { n } = g.move, dag = curDag();
      n.x = Math.round((g.move.x0 + dx * g.k) / 10) * 10; n.y = Math.round((g.move.y0 + dy * g.k) / 10) * 10;
      for (const ed of dag.edges) if (ed.from === n.id || ed.to === n.id) ed.bends = null;
      $(`.dag-svg g.node[data-id="${CSS.escape(n.id)}"]`, d)?.setAttribute("transform", `translate(${n.x},${n.y})`);
      $(".dag-svg .edges", d).innerHTML = edgesHtml(dag, statesNow(), Object.fromEntries(dag.nodes.map((x) => [x.id, x])));
      return;
    }
    D.view = { ...g.v, x: g.v.x - dx * g.k, y: g.v.y - dy * g.k };
    $(".dag-svg", d).setAttribute("viewBox", `${D.view.x} ${D.view.y} ${D.view.w} ${D.view.h}`);
  });
  d.addEventListener("pointerup", () => {
    const g = D.dragging; D.dragging = null;
    if (g?.move && g.moved) {
      const { n, x0, y0 } = g.move;
      if (n.x === x0 && n.y === y0) return;
      D.sel = n.id; D.side = "info";
      return draftEdit([{ op: "upsertNode", layer: D.board, key: keyOf(D.board, n.id), fields: { x: n.x, y: n.y } }], { op: "move", key: keyOf(D.board, n.id) });
    }
    if (g && !g.moved) {
      const was = D.sel; D.sel = g.node && g.node !== D.sel ? g.node : g.node ? D.sel : null;
      if (g.node) D.side = "info";
      if (D.sel !== was) { Object.assign(D, { edit: null, remove: null, editErr: "", cEdit: null, cErr: "" }); log("dag-select", { board: D.mode === "plan" ? "plan" : D.board, id: D.sel, from: was }); }
      drawAll();
    }
  });
  d.addEventListener("close", () => clearInterval(D.poll));
}
export const dagState = D;
