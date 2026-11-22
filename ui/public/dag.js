// Wu DAG progress map: the content board and the methods board (snapshots of the whiteboards), coloured by
// how far the student has got. States come from Claude's guess (from homework + uploaded notes) unless the teacher
// overrides a node ("set by you"). Methods ids are namespaced "m:eNN" everywhere outside their own file.
// Pure helpers (edgePath, computeStates, ladderHints) are exported for ui/scripts/test.mjs.
import { $, esc, api, S, parseUnitStatuses, log } from "./lib.js";
import { fmtUSD } from "./cost.js";

export const LOW_CONFIDENCE = 0.6;
const BOARD_LABEL = { content: "Content", methods: "Methods" };
const KIND_LABEL = { assumed: "Assumed (pre-algebra)", definition: "Definition", theorem: "Theorem", method: "Method", "word-problem": "Word problem (not used)" };

// ---------- pure ----------

export const keyOf = (board, id) => (board === "methods" ? "m:" + id : id);

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

const D = { data: null, board: "content", sel: null, view: null, poll: null, side: "info", dragging: null };

function bbox(dag) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of dag.nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h); }
  for (const t of dag.texts || []) { x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y); }
  return { x: x0 - 40, y: y0 - 40, w: x1 - x0 + 80, h: y1 - y0 + 80 };
}

const curDag = () => D.data?.[D.board];
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
      ${s.low ? `<g class="qbadge" transform="translate(${n.w - 12},-6)"><circle r="11"/><text y="5">?</text></g>` : ""}
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
    <span class="sep"></span><span class="qb">?</span>low confidence <span class="qb u">✎</span>set by you</div>`;
}

function nodePanel(id) {
  const dag = curDag(), n = dag.nodes.find((x) => x.id === id);
  if (!n) return "";
  const key = keyOf(D.board, id);
  const s = statesNow()[id];
  const g = D.data.guess?.nodes?.[key];
  const preds = dag.edges.filter((e) => e.to === id).map((e) => dag.nodes.find((x) => x.id === e.from)).filter(Boolean);
  const succ = dag.edges.filter((e) => e.from === id).map((e) => dag.nodes.find((x) => x.id === e.to)).filter(Boolean);
  const st = statesNow();
  const content = D.data.content.nodes;
  const rests = (n.restsOn || []).map((c) => content.find((x) => x.id === c)).filter(Boolean);
  const units = Object.entries(D.data.guess?.ladderToWu || {}).filter(([, ids]) => ids.includes(key)).map(([u]) => u);
  const nodeLink = (x) => `<button class="link nl d-${st[x.id]?.display || ""}" data-goto="${x.id}">${esc(x.title)}</button>`;
  const btn = (v, label) => `<button class="${s.state === v && s.by === "you" ? "on" : ""}" data-set="${v}">${label}</button>`;
  return `<div class="np">
    <div class="k">${esc(BOARD_LABEL[D.board])} · ${esc(KIND_LABEL[n.kind] || n.kind)} · ${esc(key)}${n.sections?.length ? ` · §${n.sections.join(", §")}` : ""}</div>
    <h3 class="np-title">${esc(n.title)}</h3>
    ${n.detail ? `<p class="muted">${esc(n.detail)}</p>` : ""}
    <div class="np-state d-${s.display}">${{ done: "Done", partial: "Partly done", ready: "Ready next", locked: "Locked", unused: "Not used (word problems are banned)" }[s.display]}
      ${s.by === "you" ? `<span class="muted small">· set by you${s.at ? " " + new Date(s.at).toLocaleDateString() : ""}</span>` : s.by === "claude" ? `<span class="muted small">· Claude's guess${s.confidence != null ? `, ${Math.round(s.confidence * 100)}% sure` : ""}</span>` : ""}</div>
    <div class="seg np-set">${btn("done", "Done")}${btn("partial", "Partly")}${btn("not-yet", "Not yet")}</div>
    ${s.by === "you" ? `<button class="link" data-set="">use Claude's guess${g ? ` (${esc(g.state)})` : ""}</button>` : ""}
    ${(g?.evidence || []).length ? `<h4>Evidence</h4><ul class="ev">${g.evidence.map((e) => `<li><b>${esc(e.file || "")}</b>${e.date ? ` <span class="muted">${esc(e.date)}</span>` : ""}${e.quote ? `<q>${esc(e.quote)}</q>` : ""}</li>`).join("")}</ul>` : g ? `<p class="muted small">No evidence found in the homework or notes.</p>` : ""}
    ${units.length ? `<h4>Ladder units</h4><p>${units.map((u) => `<b>${esc(u)}</b> ${esc(S.units.find((x) => x.id === u)?.name || "")}`).join("<br>")}</p>` : ""}
    ${preds.length ? `<h4>${D.board === "methods" ? "Sub-steps" : "Needs"}</h4><div class="nls">${preds.map(nodeLink).join("")}</div>` : ""}
    ${rests.length ? `<h4>Rests on (content)</h4><div class="nls">${rests.map((x) => `<button class="link nl" data-goto-content="${x.id}">${esc(x.title)}</button>`).join("")}</div>` : ""}
    ${succ.length ? `<h4>Used for</h4><div class="nls">${succ.map(nodeLink).join("")}</div>` : ""}
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

function hintsPanel() {
  const g = D.data.guess;
  const hints = ladderHints(S.status, g?.ladderToWu, g, D.data.overrides);
  return `<div class="np">
    <h3>Last guess</h3>
    ${g ? `<p>${esc(g.summary || "")}</p><p class="muted small">${new Date(g.at).toLocaleString()} · ${esc(g.model || "")} · ${g.files} files · ${fmtUSD(g.usage?.costUSD)}</p>` : '<p class="muted">No guess yet. Press <b>Guess progress</b>.</p>'}
    <h3>Against weekly_status</h3>
    ${hints.length ? `<ul class="hints">${hints.map((h) => `<li class="h-${h.kind}">${esc(h.text)} <span class="nls">${h.ids.map((k) => `<button class="link" data-goto-key="${esc(k)}">${esc(k)}</button>`).join(" ")}</span></li>`).join("")}</ul>` : `<p class="muted small">${g?.ladderToWu ? "No disagreements between the unit statuses and the map." : "Appears after a guess."}</p>`}
  </div>`;
}

function headHtml() {
  const dag = curDag(), c = counts(dag, statesNow()), job = D.data.job;
  const running = job?.running;
  return `<h2>Progress map</h2>
    <div class="seg board-seg">${["content", "methods"].map((b) => `<button data-board="${b}" class="${D.board === b ? "on" : ""}">${BOARD_LABEL[b]}</button>`).join("")}</div>
    <span class="dag-count"><b>${c.done} of ${c.total} done</b>${c.partial ? ` · ${c.partial} partly` : ""} · ${c.ready} ready</span>
    <span class="spacer"></span>
    ${running ? `<span class="muted small"><span class="spin"></span> Claude is reading the homework and notes… ${Math.round((job.elapsed || 0) / 1000)}s${job.tools?.length ? ` · read ${job.tools.length} file${job.tools.length > 1 ? "s" : ""}` : ""}</span><button class="secondary" data-act="stop-guess">Stop</button>`
      : `${job?.error ? `<span class="bad-text small" title="${esc(job.error)}">Last guess failed</span>` : ""}<button class="primary" data-act="guess" title="One ${esc(D.data.guessModel || "")} run over every homework file and your notes, for both boards">${D.data.guess ? "Guess again" : "Guess progress"}</button>`}
    <button class="ghost" data-act="fit" title="Fit to screen">⤢</button>
    <form method="dialog"><button class="ghost">✕</button></form>`;
}

function drawAll() {
  const d = $("#dag-dlg");
  if (!D.data) { d.innerHTML = `<p class="muted">Loading…</p>`; return; }
  if (!curDag()) { d.innerHTML = `<div class="row"><h2>Progress map</h2><span class="spacer"></span><form method="dialog"><button class="ghost">✕</button></form></div><p class="err">ui/data/wu_dag.json is missing.</p>`; return; }
  D.view ||= bbox(curDag());
  d.innerHTML = `<div class="dag-head row">${headHtml()}</div>
    <div class="dag-main"><div class="dag-canvas">${svgHtml()}</div>
      <aside class="dag-side"><div class="tabs">${["info", "notes", "hints"].map((t) => `<button class="tab${D.side === t ? " on" : ""}" data-side="${t}">${{ info: "Node", notes: `Notes (${(D.data.notes || []).length})`, hints: "Summary" }[t]}</button>`).join("")}</div>
      <div class="side-body">${D.side === "info" ? (D.sel ? nodePanel(D.sel) : '<p class="muted">Click a block to see its evidence and set its state.</p>') : D.side === "notes" ? notesPanel() : hintsPanel()}</div></aside></div>
    ${legendHtml()}`;
}
function drawSvgOnly() { const c = $("#dag-dlg .dag-canvas"); if (c) c.innerHTML = svgHtml(); }

async function load() {
  D.data = await api("/api/dag");
  drawAll();
  clearInterval(D.poll);
  if (D.data.job?.running) D.poll = setInterval(async () => {
    const was = D.data.job?.running;
    D.data = await api("/api/dag");
    if (!D.data.job?.running) { clearInterval(D.poll); if (was) D.side = "hints"; }
    if ($("#dag-dlg").open) drawAll();
  }, 2000);
}

export async function openDag() {
  const d = $("#dag-dlg");
  if (!d.open) d.showModal();
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
  const d = $("#dag-dlg");
  d.addEventListener("click", async (e) => {
    const t = e.target;
    const b = t.closest("[data-board]"); if (b) { D.board = b.dataset.board; D.sel = null; D.view = null; return drawAll(); }
    const sd = t.closest("[data-side]"); if (sd) { D.side = sd.dataset.side; return drawAll(); }
    const a = t.closest("[data-act]");
    if (a?.dataset.act === "fit") { D.view = bbox(curDag()); return drawSvgOnly(); }
    if (a?.dataset.act === "guess") { try { await api("/api/dag/guess", { method: "POST" }); } catch (err) { alert(err.message); } return load(); }
    if (a?.dataset.act === "stop-guess") { await api("/api/dag/guess/stop", { method: "POST" }); return setTimeout(load, 500); }
    const s = t.closest("[data-set]"); if (s && D.sel) return setNode(keyOf(D.board, D.sel), s.dataset.set);
    const go = t.closest("[data-goto]"); if (go) { D.sel = go.dataset.goto; return drawAll(); }
    const gc = t.closest("[data-goto-content]"); if (gc) { D.board = "content"; D.sel = gc.dataset.gotoContent; D.view = null; return drawAll(); }
    const gk = t.closest("[data-goto-key]"); if (gk) { const k = gk.dataset.gotoKey; D.board = k.startsWith("m:") ? "methods" : "content"; D.sel = k.replace(/^m:/, ""); D.side = "info"; D.view = null; return drawAll(); }
    const dn = t.closest("[data-del-note]"); if (dn) { if (!confirm(`Delete ${dn.dataset.delNote}?`)) return; const r = await api(`/api/notes/${encodeURIComponent(dn.dataset.delNote)}`, { method: "DELETE" }); D.data.notes = r.notes; return drawAll(); }
  });
  d.addEventListener("change", (e) => { if (e.target.matches("#dag-drop input")) upload([...e.target.files]); });
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
