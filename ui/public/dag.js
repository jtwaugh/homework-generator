// Wu DAG progress map: the content board and the methods board (snapshots of the whiteboards), coloured by
// how far the student has got. States come from Claude's guess (from homework + uploaded notes) unless the teacher
// overrides a node ("set by you"). Methods ids are namespaced "m:eNN" everywhere outside their own file.
// The sidebar sub-items pick the mode: the content board, the methods board, or the lesson plan.
// Every guess run (chain of thought, tool calls, cost, per-node evidence) is under History › Inference.
// Pure helpers (edgePath, computeStates, ladderHints, statusText) are exported for ui/scripts/test.mjs.
import { $, $$, esc, api, S, parseUnitStatuses, log } from "./lib.js";

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
    const groups = (plan.layout || []).map((sec) => ({ title: sec.heading || "", units: (sec.items || []).filter((i) => i.unit && byKey.has(i.unit)).map((i) => {
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
const D = { data: null, version: null, mode: "content", sel: null, view: null, poll: null, side: "info", dragging: null, planView: "linear", graph: null };
try { if (localStorage.getItem(PLAN_VIEW_KEY) === "dag") D.planView = "dag"; } catch {}
Object.defineProperty(D, "board", { get: () => (D.mode === "methods" ? "methods" : "content"), enumerable: true });
const MODE_LABEL = { content: "Content", methods: "Methods", plan: "Lesson plan" };
const STATUS_LABEL = { TAUGHT: "Taught", CURRENT: "Current", NEXT: "Next", FUTURE: "Future" };

function bbox(dag) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of dag.nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h); }
  for (const t of dag.texts || []) { x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y); }
  return { x: x0 - 40, y: y0 - 40, w: x1 - x0 + 80, h: y1 - y0 + 80 };
}

const planDag = () => D.mode === "plan" && D.planView === "dag";
const curDag = () => (planDag() ? D.graph : D.data?.[D.board]);
const statesNow = () => computeStates(curDag(), D.board, D.data.guess, D.data.overrides, D.data.content);

function svgHtml() {
  const dag = curDag();
  const st = statesNow();
  const byId = Object.fromEntries(dag.nodes.map((n) => [n.id, n]));
  const sel = D.sel;
  const edges = dag.edges.filter((e) => byId[e.from] && byId[e.to]).map((e) => {
    const hot = sel && (e.from === sel || e.to === sel);
    const lit = st[e.from].display === "done";
    return `<path class="edge${e.prove ? " prove" : ""}${hot ? " hot" : ""}${lit ? " lit" : ""}" d="${edgePath(byId[e.from], byId[e.to], e.bends)}" marker-end="url(#arr${hot ? "-hot" : ""})"/>`;
  }).join("");
  const nodes = dag.nodes.map((n) => {
    const s = st[n.id];
    return `<g class="node k-${n.kind} d-${s.display}${sel === n.id ? " sel" : ""}${s.by === "you" ? " by-you" : ""}" data-id="${n.id}" transform="translate(${n.x},${n.y})">
      <rect class="body" width="${n.w}" height="${n.h}" rx="10"/>
      ${s.display === "partial" ? `<rect class="half" width="${n.w / 2}" height="${n.h}" rx="10"/><rect class="half-sq" x="${n.w / 2 - 10}" width="10" height="${n.h}"/>` : ""}
      ${n.kind === "word-problem" ? `<rect class="hatch" width="${n.w}" height="${n.h}" rx="10"/>` : ""}
      <rect class="band" width="${n.w}" height="7" rx="3"/>
      <foreignObject x="10" y="10" width="${n.w - 20}" height="${n.h - 14}"><div xmlns="http://www.w3.org/1999/xhtml" class="nt"><b>${esc(n.title)}</b>${n.detail ? `<span>${esc(n.detail)}</span>` : ""}</div></foreignObject>
      ${s.by === "you" ? `<g class="ubadge" transform="translate(12,-6)"><circle r="9"/><text y="4">✎</text></g>` : ""}
    </g>`;
  }).join("");
  const texts = (dag.texts || []).map((t) => `<text class="cap cap-${t.size}" x="${t.x}" y="${t.y + ({ title: 44, large: 30, body: 20 }[t.size] || 20)}">${esc(t.text)}</text>`).join("");
  const v = D.view;
  return `<svg class="dag-svg" viewBox="${v.x} ${v.y} ${v.w} ${v.h}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="ah"/></marker>
      <marker id="arr-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="ah hot"/></marker>
      <pattern id="hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="10" class="hl"/></pattern>
    </defs>${texts}<g class="edges">${edges}</g><g class="nodes">${nodes}</g></svg>`;
}

function legendHtml() {
  const kinds = D.board === "methods" ? ["method", "word-problem"] : ["assumed", "definition", "theorem", "method"];
  return `<div class="dag-legend">
    <span class="lg d-done"></span>done <span class="lg d-partial"></span>partly <span class="lg d-ready"></span>ready next <span class="lg d-locked"></span>locked
    <span class="sep"></span>${kinds.map((k) => `<span class="lg-band k-${k}"></span>${esc(KIND_LABEL[k])}`).join(" ")}
    <span class="sep"></span><span class="lg-edge"></span>used for <span class="lg-edge prove"></span>${D.board === "methods" ? "sub-step" : "needed to prove"}
    <span class="sep"></span><span class="qb u">✎</span>set by you</div>`;
}

// The node panel: what the node is, and where the student stands on it. Nothing about how Claude got there.
function nodePanel(id) {
  const dag = curDag(), n = dag.nodes.find((x) => x.id === id);
  if (!n) return "";
  const t = statusText(dag, D.board, id, D.data.guess, D.data.overrides, D.data.content);
  const s = statesNow()[id];
  const g = D.data.guess?.nodes?.[keyOf(D.board, id)];
  const btn = (v, label) => `<button class="${s.state === v && s.by === "you" ? "on" : ""}" data-set="${v}">${label}</button>`;
  return `<div class="np">
    <div class="k">${esc(BOARD_LABEL[D.board])} · ${esc(KIND_LABEL[n.kind] || n.kind)}${n.sections?.length ? ` · §${n.sections.join(", §")}` : ""}</div>
    <h3 class="np-title">${esc(n.title)}</h3>
    ${n.detail ? `<p>${esc(n.detail)}</p>` : ""}
    <div class="np-state d-${t.display}">${esc(t.label)}</div>
    <p class="np-note">${esc(t.note)}</p>
    ${t.missing.length ? `<div class="nls">${t.missing.map((x) => `<button class="link nl" data-goto-key="${esc(x.key)}">${esc(x.title)}</button>`).join("")}</div>` : ""}
    ${n.kind === "word-problem" ? "" : viewingOther() ? `<p class="muted small">Showing v${D.data.version.seq}; ${esc(S.student || "the student")} is on another version, so states can only be changed there.</p>` : `<h4>Change it</h4><div class="seg np-set">${btn("done", "Done")}${btn("partial", "Partly")}${btn("not-yet", "Not yet")}</div>
    ${s.by === "you" ? `<button class="link" data-set="">use Claude's guess${g ? ` (${esc(g.state)})` : ""}</button>` : ""}`}
  </div>`;
}

function notesPanel() {
  const notes = D.data.notes || [];
  return `<div class="np">
    <h3>Notes for Claude</h3>
    <p class="muted small">Claude reads every homework .tex in the project, weekly_status.md and these notes when it guesses progress. PDFs and photos of notes work too.</p>
    <label class="drop" id="dag-drop"><input type="file" multiple accept=".tex,.md,.txt,.pdf,.png,.jpg,.jpeg,.heic,.webp,.gif" hidden /><span>Drop files here or <u>choose files</u></span></label>
    <ul class="notes">${notes.map((n) => `<li><a href="/notes/${encodeURIComponent(n.name)}" target="_blank" rel="noopener">${esc(n.name)}</a><small>${Math.ceil(n.size / 1024)} KB</small><button class="ghost" data-del-note="${esc(n.name)}" title="Delete">✕</button></li>`).join("") || '<li class="muted">No notes uploaded yet</li>'}</ul>
  </div>`;
}

function planHtml() {
  const groups = lessonPlan(D.data?.plan || S.ladder, S.status);
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
          </div>
        </li>`).join("")}</ol>
    </section>`).join("")}</div>`;
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
    </g>`;
  }).join("");
  const v = D.view;
  const mk = (id, cls) => `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="ah${cls}"/></marker>`;
  return `<svg class="dag-svg plan-dag" viewBox="${v.x} ${v.y} ${v.w} ${v.h}" xmlns="http://www.w3.org/2000/svg">
    <defs>${mk("parr", "")}${mk("parr-anc", " anc")}${mk("parr-desc", " desc")}${mk("parr-dim", " dim")}</defs>
    <g class="edges">${edges}</g><g class="nodes">${nodes}</g></svg>`;
}

function planPanel(id) {
  const g = D.graph, n = g.nodes.find((x) => x.id === id);
  if (!n) return '<p class="muted">Click a unit to see what it needs and what it opens up. Its prerequisites light up in green, the units that build on it in blue.</p>';
  const u = n.unit, name = (k) => g.nodes.find((x) => x.id === k)?.unit.name || "";
  const links = (ks) => `<div class="nls">${[...ks].map((k) => `<button class="link nl" data-goto-unit="${esc(k)}"><b>${esc(k)}</b> ${esc(name(k))}</button>`).join("")}</div>`;
  const direct = g.edges.filter((e) => e.from === id).map((e) => e.to), all = planClosure(g, id, "down"), anc = planClosure(g, id, "up");
  const known = new Set(g.nodes.map((x) => x.id)), unknown = u.needs.filter((k) => !known.has(k));
  return `<div class="np">
    <div class="k">Unit ${esc(u.id)}${u.stance ? ` · ${esc(u.stance)}` : ""}</div>
    <h3 class="np-title">${esc(u.name)}</h3>
    ${u.about ? `<p>${esc(u.about)}</p>` : ""}
    <div class="np-state ps-${u.status}">${esc(STATUS_LABEL[u.status])}${n.ready ? " · ready: everything it needs is taught" : ""}</div>
    ${u.note ? `<p class="plan-note small">${esc(u.note)}</p>` : ""}
    ${u.guide ? `<p class="muted small plan-guide">${esc(u.guide)}</p>` : ""}
    ${u.missing.length ? `<p class="bad-text small">${u.missing.map(esc).join(", ")} not taught yet</p>` : ""}
    <h4>Needs</h4>${u.needs.length ? links(u.needs.filter((k) => known.has(k))) : '<p class="muted small">Nothing: it can start any time.</p>'}
    ${unknown.length ? `<p class="muted small">Also lists ${unknown.map(esc).join(", ")}, not in this version.</p>` : ""}
    ${anc.size > u.needs.length ? `<p class="muted small">${anc.size} units in all lie under it.</p>` : ""}
    <h4>Needed by</h4>${direct.length ? links(direct) : '<p class="muted small">No unit builds on it directly.</p>'}
    ${all.size > direct.length ? `<p class="muted small">${all.size} units in all build on it.</p>` : ""}
  </div>`;
}

function planLegendHtml() {
  return `<div class="dag-legend">
    <span class="lg ps-TAUGHT"></span>taught <span class="lg ps-CURRENT"></span>current <span class="lg ps-NEXT"></span>next <span class="lg ps-FUTURE"></span>future <span class="lg ps-FUTURE ready"></span>ready (needs all taught)
    <span class="sep"></span><span class="lg-edge"></span>needed for <span class="lg-edge implied"></span>implied by a longer chain (shown for the selected unit)
    <span class="sep"></span><span class="wdot-lg"></span>a need is not taught yet</div>`;
}

// ---------- page ----------

function headHtml() {
  const job = D.data?.job, running = job?.running;
  if (D.mode === "plan") {
    const us = lessonPlan(D.data?.plan || S.ladder, S.status).flatMap((g) => g.units), n = (s) => us.filter((u) => u.status === s).length;
    const ready = planDag() && D.graph ? D.graph.nodes.filter((x) => x.ready).length : 0;
    return `<h2>Progress map <span class="muted">· Lesson plan</span></h2>
      <span class="dag-count"><b>${n("TAUGHT")} of ${us.length} taught</b> · ${n("CURRENT")} current${n("NEXT") ? ` · ${n("NEXT")} next` : ""}${ready ? ` · ${ready} ready` : ""}</span>
      <div class="seg plan-view">${["linear", "dag"].map((v) => `<button data-plan-view="${v}" class="${D.planView === v ? "on" : ""}">${{ linear: "Linear", dag: "DAG" }[v]}</button>`).join("")}</div>
      <span class="spacer"></span><span class="muted small">Statuses from weekly_status.md · change them on Create Homework</span>${versionPicker()}${planDag() ? '<button class="ghost" data-act="fit" title="Fit to screen">⤢</button>' : ""}`;
  }
  const c = counts(curDag(), statesNow()), count = `<span class="dag-count"><b>${c.done} of ${c.total} done</b>${c.partial ? ` · ${c.partial} partly` : ""} · ${c.ready} ready</span>`;
  return `<h2>Progress map <span class="muted">· ${esc(MODE_LABEL[D.mode])}</span></h2>
    ${count}
    <span class="spacer"></span>
    ${viewingOther() ? `<span class="muted small">Viewing v${D.data.version.seq}, read through the course's lineage</span>` : running ? `<span class="muted small"><span class="spin"></span> Claude is reading the homework and notes… ${Math.round((job.elapsed || 0) / 1000)}s${job.tools?.length ? ` · read ${job.tools.length} file${job.tools.length > 1 ? "s" : ""}` : ""}</span><button class="secondary" data-act="stop-guess">Stop</button>`
      : `${job?.error ? `<span class="bad-text small" title="${esc(job.error)}">Last guess failed</span>` : ""}<button class="primary" data-act="guess" title="One ${esc(D.data.guessModel || "")} run over every homework file and your notes, for both boards">${D.data.guess ? "Guess again" : "Guess progress"}</button>`}
    ${versionPicker()}<button class="ghost" data-act="fit" title="Fit to screen">⤢</button>`;
}

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
  if (D.mode === "plan" && D.planView === "dag") {
    const groups = lessonPlan(D.data?.plan || S.ladder, S.status);
    D.graph = planGraph(groups);
    if (!D.graph.nodes.length) { d.innerHTML = `<div class="dag-head row">${headHtml()}</div>${planHtml()}`; return; }
    D.view ||= bbox(D.graph);
    d.innerHTML = `<div class="dag-head row">${headHtml()}</div>
      <div class="dag-main"><div class="dag-canvas">${planSvgHtml()}</div>
        <aside class="dag-side"><div class="side-body">${planPanel(D.sel)}</div></aside></div>
      ${planLegendHtml()}`;
    return;
  }
  if (D.mode === "plan") { d.innerHTML = `<div class="dag-head row">${headHtml()}</div>${planHtml()}`; return; }
  if (!D.data) { d.innerHTML = `<p class="muted">Loading…</p>`; return; }
  if (!curDag()) { d.innerHTML = `<div class="row dag-head"><h2>Progress map</h2></div><p class="err">ui/data/wu_dag.json is missing.</p>`; return; }
  D.view ||= bbox(curDag());
  d.innerHTML = `<div class="dag-head row">${headHtml()}</div>
    <div class="dag-main"><div class="dag-canvas">${svgHtml()}</div>
      <aside class="dag-side"><div class="tabs">${["info", "notes"].map((t) => `<button class="tab${D.side === t ? " on" : ""}" data-side="${t}">${{ info: "Node", notes: `Notes (${(D.data.notes || []).length})` }[t]}</button>`).join("")}</div>
      <div class="side-body">${D.side === "info" ? (D.sel ? nodePanel(D.sel) : '<p class="muted">Click a block to see where the student stands on it.</p>') : notesPanel()}</div></aside></div>
    ${legendHtml()}`;
}
function drawSvgOnly() { const c = $("#p-dag .dag-canvas"); if (c) c.innerHTML = planDag() ? planSvgHtml() : svgHtml(); }

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
    if (!$("#p-dag").hidden) drawAll();
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
  if (btn?.dataset.dag && btn.dataset.dag !== D.mode) { const wasBoard = D.board, wasPlan = planDag(); D.mode = btn.dataset.dag; if (D.board !== wasBoard || planDag() !== wasPlan) { D.sel = null; D.view = null; } }
  if (!D.data) drawAll();
  await load();
}

async function setNode(key, state) {
  const r = await api("/api/dag", { method: "PUT", body: { id: key, state: state || null } });
  D.data.overrides = r.overrides;
  drawAll();
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

export function initDag() {
  const d = $("#p-dag");
  d.addEventListener("click", async (e) => {
    const t = e.target;
    const sd = t.closest("[data-side]"); if (sd) { D.side = sd.dataset.side; return drawAll(); }
    const pv = t.closest("[data-plan-view]");
    if (pv) {
      if (pv.dataset.planView === D.planView) return;
      D.planView = pv.dataset.planView; D.sel = null; D.view = null;
      try { localStorage.setItem(PLAN_VIEW_KEY, D.planView); } catch {}
      log("plan-view", { view: D.planView }); return drawAll();
    }
    const pu = t.closest(".plan-unit[data-unit]");
    if (pu) { D.planView = "dag"; D.sel = pu.dataset.unit; D.view = null; try { localStorage.setItem(PLAN_VIEW_KEY, "dag"); } catch {} log("plan-view", { view: "dag", from: pu.dataset.unit }); return drawAll(); }
    const gu = t.closest("[data-goto-unit]"); if (gu) { D.sel = gu.dataset.gotoUnit; log("dag-select", { board: "plan", id: D.sel }); return drawAll(); }
    const a = t.closest("[data-act]");
    if (a?.dataset.act === "fit") { D.view = bbox(curDag()); return drawSvgOnly(); }
    if (a?.dataset.act === "guess") { try { await api("/api/dag/guess", { method: "POST" }); } catch (err) { alert(err.message); } return load(); }
    if (a?.dataset.act === "stop-guess") { await api("/api/dag/guess/stop", { method: "POST" }); return setTimeout(load, 500); }
    const s = t.closest("[data-set]"); if (s && D.sel) return setNode(keyOf(D.board, D.sel), s.dataset.set);
    const gk = t.closest("[data-goto-key]"); if (gk) { focusNode(gk.dataset.gotoKey); return drawAll(); }
    const dn = t.closest("[data-del-note]"); if (dn) { if (!confirm(`Delete ${dn.dataset.delNote}?`)) return; const r = await api(`/api/notes/${encodeURIComponent(dn.dataset.delNote)}`, { method: "DELETE" }); D.data.notes = r.notes; return drawAll(); }
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

  // pan (drag the background or a node) and zoom (wheel / pinch) by editing the viewBox
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
    D.dragging = { sx: e.clientX, sy: e.clientY, v: { ...D.view }, k: toBoard(svg, 0, 0).k, moved: false, node: e.target.closest(".node")?.dataset.id };
    svg.setPointerCapture(e.pointerId);
  });
  d.addEventListener("pointermove", (e) => {
    const g = D.dragging; if (!g) return;
    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) g.moved = true;
    if (!g.moved) return;
    D.view = { ...g.v, x: g.v.x - dx * g.k, y: g.v.y - dy * g.k };
    $(".dag-svg", d).setAttribute("viewBox", `${D.view.x} ${D.view.y} ${D.view.w} ${D.view.h}`);
  });
  d.addEventListener("pointerup", () => {
    const g = D.dragging; D.dragging = null;
    if (g && !g.moved) { const was = D.sel; D.sel = g.node && g.node !== D.sel ? g.node : g.node ? D.sel : null; if (g.node) D.side = "info"; if (D.sel !== was) log("dag-select", { board: D.board, id: D.sel, from: was }); drawAll(); }
  });
  d.addEventListener("close", () => clearInterval(D.poll));
}
export const dagState = D;
