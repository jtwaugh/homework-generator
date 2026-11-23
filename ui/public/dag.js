// Wu DAG progress map: the content board and the methods board (snapshots of the whiteboards), coloured by
// how far the student has got. States come from Claude's guess (from homework + uploaded notes) unless the teacher
// overrides a node ("set by you"). Methods ids are namespaced "m:eNN" everywhere outside their own file.
// The sidebar sub-items pick the mode: the content board, the methods board, or the inference history
// (every guess run with its chain of thought, tool calls and cost). Per-node evidence lives only there.
// Pure helpers (edgePath, computeStates, ladderHints, statusText) are exported for ui/scripts/test.mjs.
import { $, $$, esc, api, S, parseUnitStatuses, log, md } from "./lib.js";
import { fmtUSD } from "./cost.js";

export const LOW_CONFIDENCE = 0.6;
const BOARD_LABEL = { content: "Content", methods: "Methods" };
const KIND_LABEL = { assumed: "Assumed (pre-algebra)", definition: "Definition", theorem: "Theorem", method: "Method", "word-problem": "Word problem (not used)" };

// ---------- pure ----------

// Lesson plan: every U unit in curriculum_ladder.md, in ladder order, grouped by the ladder's "## " sections,
// with its status and note from weekly_status.md and any prerequisite not yet taught (only flagged once the
// unit itself is taught or current, as in the Create Homework units widget).
export function lessonPlan(ladderMd, statusMd) {
  const { map } = parseUnitStatuses(statusMd || "");
  const st = (id) => map[id]?.status || "FUTURE";
  const ok = (id) => ["TAUGHT", "CURRENT"].includes(st(id));
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
    const s = st(u[1]);
    group.units.push({ id: u[1], name: u[2].trim(), about, needs, stance, status: s, note: (map[u[1]]?.note || "").replace(/^\(|\)$/g, ""),
      missing: ok(u[1]) ? needs.filter((n) => !ok(n)) : [] });
  }
  return groups.filter((g) => g.units.length);
}


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

const D = { data: null, mode: "content", sel: null, view: null, poll: null, side: "info", dragging: null, run: null, runs: {} };
Object.defineProperty(D, "board", { get: () => (D.mode === "methods" ? "methods" : "content"), enumerable: true });
const MODE_LABEL = { content: "Content", methods: "Methods", plan: "Lesson plan", runs: "Inference history" };
const STATUS_LABEL = { TAUGHT: "Taught", CURRENT: "Current", NEXT: "Next", FUTURE: "Future" };

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
    ${n.kind === "word-problem" ? "" : `<h4>Change it</h4><div class="seg np-set">${btn("done", "Done")}${btn("partial", "Partly")}${btn("not-yet", "Not yet")}</div>
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

// ---------- inference history ----------

const fmtDur = (ms) => (ms == null ? "" : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
const kb = (c) => (c == null ? "" : c < 1024 ? `${c} chars` : `${Math.round(c / 1024)}K chars`);

function runsListHtml() {
  const runs = D.data.runs || [], job = D.data.job;
  const total = runs.reduce((a, r) => a + (r.costUSD || 0), 0);
  const live = job?.running ? `<li data-run="live" class="${D.run === "live" ? "on" : ""}"><span><span class="spin"></span> Running now</span><small>${esc(D.data.guessModel || "")} · ${fmtDur(job.elapsed)}</small></li>` : "";
  const rows = runs.map((r) => `<li data-run="${esc(r.id)}" class="${D.run === r.id ? "on" : ""}${r.ok ? "" : " failed"}">
    <span>${esc(new Date(r.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}${r.id === D.data.guess?.runId ? ' <span class="cur-tag">current</span>' : ""}</span>
    <small>${esc(r.model || "")} · ${r.ok ? fmtUSD(r.costUSD) : "failed"}${r.ms ? " · " + fmtDur(r.ms) : ""}</small></li>`).join("");
  return `<h3>Guess runs</h3><p class="muted small">${runs.length} run${runs.length === 1 ? "" : "s"} · ${fmtUSD(total)} in all</p>
    <ul class="h-weeks">${live}${rows || (live ? "" : '<li class="muted">No guesses yet</li>')}</ul>`;
}

function logHtml(entries, live = false) {
  if (!entries?.length) return `<p class="muted small">${live ? '<span class="spin"></span> Waiting for Claude…' : "No log was kept for this run (it predates inference history)."}</p>`;
  return `<ol class="cot">${entries.map((e) => {
    if (e.t === "tool") return `<li class="cot-tool"><b>${esc(e.name)}</b> <code>${esc(e.input || "")}</code> <span class="muted">${e.ok === false ? "failed" : kb(e.chars)}${e.ms != null ? " · " + fmtDur(e.ms) : ""}</span></li>`;
    // The guess reply is reasoning prose, then the ```json answer: show the prose, fold the JSON away.
    const cut = e.t === "text" ? e.text.search(/```json/) : -1;
    const prose = (cut >= 0 ? e.text.slice(0, cut) : e.text).trim(), json = cut >= 0 ? e.text.slice(cut) : "";
    const head = e.t === "thinking" ? "Thinking" : "Reasoning";
    const long = !json && prose.length > 2500;
    const body = prose ? `<div class="md">${md(prose)}</div>` : "";
    const raw = json ? `<details class="cot-json"><summary>Raw answer <span class="muted">(JSON, ${kb(json.length)})</span></summary><pre>${esc(json.replace(/^```json\s*|```\s*$/g, ""))}</pre></details>` : "";
    return `<li class="cot-${e.t}">${long ? `<details><summary>${head} <span class="muted">(${kb(e.text.length)})</span></summary>${body}</details>` : `${body ? `<div class="cot-h">${head}</div>${body}` : ""}${raw}`}</li>`;
  }).join("")}</ol>`;
}

function costHtml(u) {
  if (!u) return "";
  const models = Object.entries(u.models || {});
  return `<table class="cost-t"><tr><th>Model</th><th>In</th><th>Out</th><th>Cache read</th><th>Cache write</th><th>Cost</th></tr>
    ${models.map(([m, x]) => `<tr><td>${esc(m)}</td><td>${x.in}</td><td>${x.out}</td><td>${x.cacheRead}</td><td>${x.cacheWrite}</td><td>${fmtUSD(x.costUSD)}</td></tr>`).join("")}
    <tr class="tot"><td>Total</td><td colspan="4">${u.numTurns || 0} turn${u.numTurns === 1 ? "" : "s"} · ${fmtDur(u.durationMs)}</td><td>${fmtUSD(u.costUSD)}</td></tr></table>`;
}

function nodesTableHtml(run) {
  const nodes = Object.entries(run.nodes || {});
  if (!nodes.length) return "";
  const title = (k) => (k.startsWith("m:") ? D.data.methods : D.data.content)?.nodes.find((x) => x.id === k.replace(/^m:/, ""))?.title || "";
  return `<details class="run-nodes"><summary>Per-node guesses (${nodes.length})</summary><table class="nodes-t"><tr><th>Node</th><th>State</th><th>Sure</th><th>Evidence</th></tr>
    ${nodes.map(([k, g]) => `<tr><td><button class="link" data-goto-key="${esc(k)}">${esc(k)}</button> ${esc(title(k))}</td><td class="d-${esc(g.state || "")}">${esc(g.state || "")}</td><td>${g.confidence != null ? Math.round(g.confidence * 100) + "%" : ""}</td>
      <td>${(g.evidence || []).map((e) => `<div><b>${esc(e.file || "")}</b>${e.quote ? ` <q>${esc(e.quote)}</q>` : ""}</div>`).join("")}</td></tr>`).join("")}</table></details>`;
}

function runDetailHtml() {
  const job = D.data.job;
  if (D.run === "live") {
    if (!job?.running) return '<p class="muted">The run finished. Pick it on the left.</p>';
    return `<div class="row"><h2>Running now</h2><span class="muted small">${esc(D.data.guessModel || "")} · ${fmtDur(job.elapsed)}</span><span class="spacer"></span><button class="secondary" data-act="stop-guess">Stop</button></div>
      <h3>Chain of thought</h3>${logHtml(job.log, true)}`;
  }
  const r = D.runs[D.run];
  if (!D.run) return `<div class="h-empty muted">${(D.data.runs || []).length ? "Pick a run on the left." : "No guesses yet. Press <b>Guess progress</b>."}</div>`;
  if (!r) return '<p class="muted"><span class="spin"></span> Loading…</p>';
  if (r.error && !r.log) return `<div class="err">${esc(r.error)}</div>`;
  const hints = r.ok ? ladderHints(S.status, r.ladderToWu, { nodes: r.nodes }, D.data.overrides) : [];
  return `<div class="row"><h2>${esc(new Date(r.at).toLocaleString())}</h2><span class="muted small">${esc(r.model || "")} · ${r.files ?? "?"} files read</span></div>
    ${r.ok ? "" : `<div class="err">Failed: ${esc(r.error || "")}</div>`}
    ${r.summary ? `<h3>Summary</h3><p>${esc(r.summary)}</p>` : ""}
    <h3>Cost</h3>${costHtml(r.usage) || '<p class="muted small">No usage recorded.</p>'}
    ${r.ok ? `<h3>Against weekly_status</h3>${hints.length ? `<ul class="hints">${hints.map((h) => `<li class="h-${h.kind}">${esc(h.text)} <span class="nls">${h.ids.map((k) => `<button class="link" data-goto-key="${esc(k)}">${esc(k)}</button>`).join(" ")}</span></li>`).join("")}</ul>` : '<p class="muted small">No disagreements between the unit statuses and this guess.</p>'}` : ""}
    <h3>Chain of thought</h3>${logHtml(r.log)}
    ${nodesTableHtml(r)}`;
}

async function pickRun(id) {
  D.run = id;
  drawAll();
  if (id && id !== "live" && !D.runs[id]) {
    try { D.runs[id] = await api(`/api/dag/runs/${encodeURIComponent(id)}`); } catch (e) { D.runs[id] = { error: e.message }; }
    if (D.run === id) drawAll();
  }
}

function planHtml() {
  const groups = lessonPlan(S.ladder, S.status);
  if (!groups.length) return '<p class="muted plan-empty">No U units found in curriculum_ladder.md.</p>';
  return `<div class="plan">${groups.map((g) => `
    <section class="plan-group">${g.title ? `<h3>${esc(g.title)}</h3>` : ""}
      <ol class="plan-list">${g.units.map((u) => `
        <li class="plan-unit s-${u.status}" data-unit="${u.id}">
          <span class="chip s-${u.status}${u.note && u.status === "TAUGHT" ? " partial" : ""}${u.missing.length ? " warn" : ""}">${u.id}</span>
          <div class="plan-body">
            <div class="plan-title"><b>${esc(u.name)}</b> <span class="st s-${u.status}">${STATUS_LABEL[u.status]}</span>${u.stance ? ` <span class="muted small">${esc(u.stance)}</span>` : ""}</div>
            ${u.about ? `<div class="plan-about">${esc(u.about)}</div>` : ""}
            ${u.note ? `<div class="plan-note small">${esc(u.note)}</div>` : ""}
            ${u.needs.length ? `<div class="muted small">Needs ${u.needs.map(esc).join(", ")}${u.missing.length ? ` · <span class="bad-text">${u.missing.map(esc).join(", ")} not taught yet</span>` : ""}</div>` : ""}
          </div>
        </li>`).join("")}</ol>
    </section>`).join("")}</div>`;
}

function runsHtml() {
  return `<div class="h-wrap dag-runs"><aside class="h-list">${runsListHtml()}</aside><div class="h-main run-main">${runDetailHtml()}</div></div>`;
}

// ---------- page ----------

function headHtml() {
  const job = D.data.job, running = job?.running;
  if (D.mode === "plan") {
    const us = lessonPlan(S.ladder, S.status).flatMap((g) => g.units), n = (s) => us.filter((u) => u.status === s).length;
    return `<h2>Progress map <span class="muted">· Lesson plan</span></h2>
      <span class="dag-count"><b>${n("TAUGHT")} of ${us.length} taught</b> · ${n("CURRENT")} current${n("NEXT") ? ` · ${n("NEXT")} next` : ""}</span>
      <span class="spacer"></span><span class="muted small">From curriculum_ladder.md and weekly_status.md · change statuses on Create Homework</span>`;
  }
  const count = D.mode === "runs" ? "" : (() => { const c = counts(curDag(), statesNow()); return `<span class="dag-count"><b>${c.done} of ${c.total} done</b>${c.partial ? ` · ${c.partial} partly` : ""} · ${c.ready} ready</span>`; })();
  return `<h2>Progress map <span class="muted">· ${esc(MODE_LABEL[D.mode])}</span></h2>
    ${count}
    <span class="spacer"></span>
    ${running ? `<span class="muted small"><span class="spin"></span> Claude is reading the homework and notes… ${Math.round((job.elapsed || 0) / 1000)}s${job.tools?.length ? ` · read ${job.tools.length} file${job.tools.length > 1 ? "s" : ""}` : ""}</span><button class="secondary" data-act="stop-guess">Stop</button>`
      : `${job?.error ? `<span class="bad-text small" title="${esc(job.error)}">Last guess failed</span>` : ""}<button class="primary" data-act="guess" title="One ${esc(D.data.guessModel || "")} run over every homework file and your notes, for both boards">${D.data.guess ? "Guess again" : "Guess progress"}</button>`}
    ${D.mode === "runs" ? "" : '<button class="ghost" data-act="fit" title="Fit to screen">⤢</button>'}`;
}

function syncSidebar() {
  for (const b of $$("[data-dag]")) b.classList.toggle("on", b.dataset.dag === D.mode);
}

function drawAll() {
  const d = $("#p-dag");
  syncSidebar();
  if (D.mode === "plan") { d.innerHTML = `<div class="dag-head row">${headHtml()}</div>${planHtml()}`; return; }
  if (!D.data) { d.innerHTML = `<p class="muted">Loading…</p>`; return; }
  if (!curDag()) { d.innerHTML = `<div class="row dag-head"><h2>Progress map</h2></div><p class="err">ui/data/wu_dag.json is missing.</p>`; return; }
  if (D.mode === "runs") {
    const keep = $(".run-main", d)?.scrollTop || 0;
    d.innerHTML = `<div class="dag-head row">${headHtml()}</div>${runsHtml()}`;
    const m = $(".run-main", d); if (m) m.scrollTop = keep;
    return;
  }
  D.view ||= bbox(curDag());
  d.innerHTML = `<div class="dag-head row">${headHtml()}</div>
    <div class="dag-main"><div class="dag-canvas">${svgHtml()}</div>
      <aside class="dag-side"><div class="tabs">${["info", "notes"].map((t) => `<button class="tab${D.side === t ? " on" : ""}" data-side="${t}">${{ info: "Node", notes: `Notes (${(D.data.notes || []).length})` }[t]}</button>`).join("")}</div>
      <div class="side-body">${D.side === "info" ? (D.sel ? nodePanel(D.sel) : '<p class="muted">Click a block to see where the student stands on it.</p>') : notesPanel()}</div></aside></div>
    ${legendHtml()}`;
}
function drawSvgOnly() { const c = $("#p-dag .dag-canvas"); if (c) c.innerHTML = svgHtml(); }

async function load() {
  D.data = await api("/api/dag");
  if (D.mode === "runs" && !D.run) return pickRun(D.data.job?.running ? "live" : D.data.runs?.[0]?.id || null).then(startPoll);
  drawAll();
  startPoll();
}
function startPoll() {
  clearInterval(D.poll);
  if (D.data.job?.running) D.poll = setInterval(async () => {
    const was = D.data.job?.running;
    D.data = await api("/api/dag");
    if (!D.data.job?.running) { clearInterval(D.poll); if (was && D.run === "live") return pickRun(D.data.runs?.[0]?.id || null); }
    if (!$("#p-dag").hidden) drawAll();
  }, 2000);
}

export async function openDag(btn) {
  if (btn?.dataset.dag && btn.dataset.dag !== D.mode) { const wasBoard = D.board; D.mode = btn.dataset.dag; if (D.board !== wasBoard) { D.sel = null; D.view = null; } if (D.mode === "runs") D.run = null; }
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
    const a = t.closest("[data-act]");
    if (a?.dataset.act === "fit") { D.view = bbox(curDag()); return drawSvgOnly(); }
    if (a?.dataset.act === "guess") { try { await api("/api/dag/guess", { method: "POST" }); } catch (err) { alert(err.message); } if (D.mode === "runs") D.run = "live"; return load(); }
    if (a?.dataset.act === "stop-guess") { await api("/api/dag/guess/stop", { method: "POST" }); return setTimeout(load, 500); }
    const rn = t.closest("[data-run]"); if (rn) return pickRun(rn.dataset.run);
    const s = t.closest("[data-set]"); if (s && D.sel) return setNode(keyOf(D.board, D.sel), s.dataset.set);
    const gk = t.closest("[data-goto-key]"); if (gk) { const k = gk.dataset.gotoKey; const mode = k.startsWith("m:") ? "methods" : "content"; if (mode !== D.board || D.mode === "runs") D.view = null; D.mode = mode; D.sel = k.replace(/^m:/, ""); D.side = "info"; log("dag-mode", { mode }); return drawAll(); }
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
