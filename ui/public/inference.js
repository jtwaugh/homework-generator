// History › Inference: every progress-map guess run (newest first) on the left, the selected run on the right.
// Same frame as History › Sessions: a list with a compact header, and a detail pane with a header bar over one
// readable column: summary, a done / partly / not-yet tally per board, disagreements with weekly_status, the
// per-node guesses (filterable by board and state), then the chain of thought and usage folded away.
// A node id links back to that block on the Progress Map. A run in progress shows live and is polled.
import { $, esc, api, S, md } from "./lib.js";
import { fmtUSD } from "./cost.js";
import { ladderHints, focusNode } from "./dag.js";
import { showPage, isShown } from "./pages.js";

// board: "content" | "methods" for the guesses table; filter: "" (all) or a state.
const I = { data: null, run: null, runs: {}, poll: null, board: "content", filter: "" };
const root = () => $("#p-history .h-inf");
const shown = () => isShown("history") && !root().hidden;

const STATES = [["done", "Done"], ["partial", "Partly"], ["not-yet", "Not yet"]];
const fmtDur = (ms) => (ms == null ? "" : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
const kb = (c) => (c == null ? "" : c < 1024 ? `${c} chars` : `${Math.round(c / 1024)}K chars`);
const num = (n) => (n == null ? "–" : Number(n).toLocaleString());
const when = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const day = (iso) => new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const short = (m) => String(m || "").replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/^./, (c) => c.toUpperCase());
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const boardOf = (k) => (k.startsWith("m:") ? "methods" : "content");
const nodeTitle = (k) => I.data[boardOf(k)]?.nodes.find((x) => x.id === k.replace(/^m:/, ""))?.title || "";
const nodeLink = (k) => `<button class="nl-chip" data-goto-key="${esc(k)}" title="Show on the Progress Map"><b>${esc(k)}</b>${nodeTitle(k) ? ` ${esc(nodeTitle(k))}` : ""}</button>`;

// ---------- list ----------

function listHtml() {
  const runs = I.data.runs || [], job = I.data.job;
  const total = runs.reduce((a, r) => a + (r.costUSD || 0), 0);
  const btn = job?.running ? `<button class="small-btn secondary" disabled>Running…</button>`
    : `<button class="small-btn primary" data-act="guess" title="One ${esc(short(I.data.guessModel))} run over every homework file and your notes, for both boards">${runs.length || I.data.guess ? "Guess again" : "Guess progress"}</button>`;
  const live = job?.running ? `<h4>Now</h4><ul class="s-list"><li data-run="live" class="${I.run === "live" ? "on" : ""}">
    <span class="s-title"><span class="s-dot run"></span>Running</span><small>${esc(short(I.data.guessModel))} · ${fmtDur(job.elapsed)}</small></li></ul>` : "";
  const groups = [];
  for (const r of runs) {
    const g = day(r.at);
    if (groups.at(-1)?.name !== g) groups.push({ name: g, items: [] });
    groups.at(-1).items.push(r);
  }
  const row = (r) => {
    const cur = r.id === I.data.guess?.runId;
    const sub = r.ok ? [short(r.model), fmtUSD(r.costUSD), r.ms ? fmtDur(r.ms) : ""].filter(Boolean).join(" · ") : `Failed${r.error ? `: ${esc(r.error)}` : ""}`;
    return `<li data-run="${esc(r.id)}" class="${I.run === r.id ? "on" : ""}${r.ok ? "" : " failed"}">
      <span class="s-title">${new Date(r.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${cur ? '<span class="cur-tag" title="The Progress Map shows this run">on map</span>' : ""}</span><small>${sub}</small></li>`;
  };
  const list = groups.map((g) => `<h4>${esc(g.name)}</h4><ul class="s-list">${g.items.map(row).join("")}</ul>`).join("");
  return `<div class="inf-top"><div class="row"><b>Progress guesses</b><span class="spacer"></span>${btn}</div>
      <div class="muted small">${plural(runs.length, "run")}${runs.length ? ` · ${fmtUSD(total)} in all` : ""}</div></div>
    <div class="s-scroll">${live}${list || (live ? "" : '<p class="muted small s-none">No guesses yet. Each run reads every homework file and your notes and guesses what is done on both boards.</p>')}</div>`;
}

// ---------- detail ----------

function logHtml(entries, live = false) {
  if (!entries?.length) return `<p class="muted small">${live ? '<span class="spin"></span>Waiting for Claude…' : "No log was kept for this run (it predates inference history)."}</p>`;
  return `<ol class="cot">${entries.map((e) => {
    if (e.t === "tool") return `<li class="cot-tool"><span class="ti">↳</span><b>${esc(e.name)}</b> <code>${esc(e.input || "")}</code> <span class="muted">${e.ok === false ? '<span class="bad-text">failed</span>' : kb(e.chars)}${e.ms != null ? " · " + fmtDur(e.ms) : ""}</span></li>`;
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

function usageHtml(u) {
  if (!u) return '<p class="muted small">No usage recorded.</p>';
  const models = Object.entries(u.models || {});
  const line = (x) => `${num(x.in)} in · ${num(x.out)} out · ${num(x.cacheRead)} cache read · ${num(x.cacheWrite)} cache write`;
  const rows = models.length > 1 ? models.map(([m, x]) => `<tr><td>${esc(short(m))}</td><td>${line(x)}</td><td class="num">${fmtUSD(x.costUSD)}</td></tr>`).join("") : "";
  const one = models.length === 1 ? models[0][1] : null;
  return `<div class="inf-usage"><span>${plural(u.numTurns || 0, "turn")} · ${fmtDur(u.durationMs)}${one ? ` · ${line(one)}` : ""}</span><b>${fmtUSD(u.costUSD)}</b></div>
    ${rows ? `<table class="cost-t">${rows}</table>` : ""}`;
}

function tallyHtml(nodes) {
  const boards = [["content", "Content"], ["methods", "Methods"]].map(([b, label]) => {
    const gs = nodes.filter(([k]) => boardOf(k) === b);
    if (!gs.length) return "";
    const n = Object.fromEntries(STATES.map(([s]) => [s, gs.filter(([, g]) => g.state === s).length]));
    const bar = STATES.map(([s]) => (n[s] ? `<span class="tb d-${s}" style="flex:${n[s]}"></span>` : "")).join("");
    return `<div class="tally"><div class="row"><b>${label}</b><span class="muted small">${plural(gs.length, "node")}</span></div>
      <div class="tbar">${bar}</div>
      <div class="tkeys">${STATES.map(([s, l]) => `<button class="tkey" data-tally="${b}:${s}"><i class="tb d-${s}"></i>${l} <b>${n[s]}</b></button>`).join("")}</div></div>`;
  }).join("");
  return boards ? `<div class="tallies">${boards}</div>` : "";
}

function guessesHtml(nodes) {
  if (!nodes.length) return "";
  const inBoard = nodes.filter(([k]) => boardOf(k) === I.board);
  const rows = inBoard.filter(([, g]) => !I.filter || g.state === I.filter);
  const seg = (attr, val, label, on) => `<button class="${on ? "on" : ""}" data-${attr}="${val}">${label}</button>`;
  const boards = `<div class="seg">${[["content", "Content"], ["methods", "Methods"]].map(([b, l]) => seg("board", b, l, I.board === b)).join("")}</div>`;
  const filters = `<div class="seg">${seg("filter", "", `All ${inBoard.length}`, !I.filter)}${STATES.map(([s, l]) => seg("filter", s, `${l} ${inBoard.filter(([, g]) => g.state === s).length}`, I.filter === s)).join("")}</div>`;
  const label = Object.fromEntries(STATES);
  const body = rows.map(([k, g]) => `<tr>
      <td><span class="np-state d-${esc(g.state || "")}">${esc(label[g.state] || g.state || "")}</span></td>
      <td>${nodeLink(k)}</td>
      <td class="conf">${g.confidence != null ? `<span class="cbar"><i style="width:${Math.round(g.confidence * 100)}%"></i></span>${Math.round(g.confidence * 100)}%` : ""}</td>
      <td class="inf-ev">${(g.evidence || []).map((e) => `<div><span class="ev-f">${esc(e.file || "")}</span>${e.quote ? ` <q>${esc(e.quote)}</q>` : ""}</div>`).join("") || '<span class="muted">–</span>'}</td></tr>`).join("");
  return `<section><div class="row inf-sec"><h3>Guesses</h3><span class="spacer"></span>${boards}${filters}</div>
    ${rows.length ? `<table class="nodes-t"><thead><tr><th>State</th><th>Node</th><th>Sure</th><th>Evidence</th></tr></thead><tbody>${body}</tbody></table>` : '<p class="muted small">None.</p>'}</section>`;
}

function headHtml(title, meta, actions = "") {
  return `<div class="h-head"><div class="h-titles"><h2>${title}</h2><div class="muted small">${meta}</div></div><span class="spacer"></span>${actions}</div>`;
}

function detailHtml() {
  const job = I.data.job;
  if (I.run === "live") {
    if (!job?.running) return '<div class="h-empty muted">The run finished. Pick it on the left.</div>';
    const read = job.tools?.length ? ` · read ${plural(job.tools.length, "file")}` : "";
    return `${headHtml('<span class="spin"></span>Guessing progress', `${esc(short(I.data.guessModel))} · ${fmtDur(job.elapsed)}${read}`, '<button class="secondary" data-act="stop-guess">Stop</button>')}
      <div class="inf-body"><section><h3>Chain of thought</h3>${logHtml(job.log, true)}</section></div>`;
  }
  if (!I.run) return `<div class="h-empty muted">${(I.data.runs || []).length ? "Pick a run on the left." : "No guesses yet. Press <b>Guess progress</b>."}</div>`;
  const r = I.runs[I.run];
  if (!r) return '<div class="h-empty muted"><span class="spin"></span>Loading…</div>';
  if (r.error && !r.at) return `<div class="h-empty"><div class="err">${esc(r.error)}</div></div>`;
  const nodes = Object.entries(r.nodes || {});
  const cur = r.id === I.data.guess?.runId;
  const meta = [esc(short(r.model)), r.files != null ? plural(r.files, "file") + " read" : "", r.usage?.durationMs || r.ms ? fmtDur(r.usage?.durationMs || r.ms) : "", r.usage ? fmtUSD(r.usage.costUSD) : ""].filter(Boolean).join(" · ");
  const actions = cur ? '<button class="secondary small-btn" data-act="map">Open Progress Map</button>' : "";
  const hints = r.ok ? ladderHints(S.status, r.ladderToWu, { nodes: r.nodes }, I.data.overrides) : [];
  const hintsHtml = r.ok ? `<section><h3>Against weekly_status</h3>${hints.length
    ? `<ul class="inf-hints">${hints.map((h) => `<li class="h-${h.kind}"><span class="hk">${h.kind === "ahead" ? "Ahead" : "Behind"}</span><div><div>${esc(h.text)}</div><div class="nls">${h.ids.map(nodeLink).join("")}</div></div></li>`).join("")}</ul>`
    : '<p class="muted small">No disagreements: the unit statuses and this guess agree.</p>'}</section>` : "";
  return `${headHtml(`${esc(when(r.at))}${cur ? ' <span class="cur-tag">on map</span>' : ""}`, meta, actions)}
    <div class="inf-body">
      ${r.ok ? "" : `<div class="err">This run failed${r.error ? `: ${esc(r.error)}` : "."}</div>`}
      ${r.summary ? `<p class="inf-summary">${esc(r.summary)}</p>` : ""}
      ${tallyHtml(nodes)}
      ${hintsHtml}
      ${guessesHtml(nodes)}
      <section><details class="inf-fold"${r.ok ? "" : " open"}><summary>Chain of thought <span class="muted">${r.log?.length ? plural(r.log.length, "step") : "not kept"}</span></summary>${logHtml(r.log)}</details></section>
      <section><h3>Usage</h3>${usageHtml(r.usage)}</section>
    </div>`;
}

function draw() {
  const d = root();
  if (!I.data) { d.innerHTML = `<div class="h-empty muted">Loading…</div>`; return; }
  const keep = $(".inf-body", d)?.scrollTop || 0;
  const fold = $(".inf-fold", d)?.open;
  d.innerHTML = `<div class="h-wrap inf-runs"><aside class="h-list">${listHtml()}</aside><div class="h-main run-main">${detailHtml()}</div></div>`;
  const b = $(".inf-body", d); if (b) b.scrollTop = keep;
  if (fold != null && $(".inf-fold", d)) $(".inf-fold", d).open = fold;
}

async function pickRun(id) {
  if (id !== I.run) I.filter = "";
  I.run = id;
  draw();
  if (id && id !== "live" && !I.runs[id]) {
    try { I.runs[id] = await api(`/api/dag/runs/${encodeURIComponent(id)}`); } catch (e) { I.runs[id] = { error: e.message }; }
    if (I.run === id) draw();
  }
}

function startPoll() {
  clearInterval(I.poll);
  if (I.data.job?.running) I.poll = setInterval(async () => {
    if (!shown()) return clearInterval(I.poll);
    const was = I.data.job?.running;
    I.data = await api("/api/dag");
    if (!I.data.job?.running) { clearInterval(I.poll); if (was && I.run === "live") return pickRun(I.data.runs?.[0]?.id || null); }
    draw();
  }, 2000);
}

async function load() {
  I.data = await api("/api/dag");
  const ids = new Set((I.data.runs || []).map((r) => r.id));
  if (!I.run || (I.run !== "live" && !ids.has(I.run)) || (I.run === "live" && !I.data.job?.running)) await pickRun(I.data.job?.running ? "live" : I.data.runs?.[0]?.id || null);
  else draw();
  startPoll();
}

export function openInference() {
  if (!I.data) draw();
  return load();
}

{
  root().addEventListener("click", async (e) => {
    const t = e.target;
    const a = t.closest("[data-act]");
    if (a?.dataset.act === "guess") { try { await api("/api/dag/guess", { method: "POST" }); } catch (err) { alert(err.message); } I.run = "live"; return load(); }
    if (a?.dataset.act === "stop-guess") { await api("/api/dag/guess/stop", { method: "POST" }); return setTimeout(load, 500); }
    if (a?.dataset.act === "map") return showPage("dag");
    const rn = t.closest("[data-run]"); if (rn) return pickRun(rn.dataset.run);
    const gk = t.closest("[data-goto-key]"); if (gk) { focusNode(gk.dataset.gotoKey); return showPage("dag"); }
    const bd = t.closest("[data-board]"); if (bd) { I.board = bd.dataset.board; return draw(); }
    const fl = t.closest("[data-filter]"); if (fl) { I.filter = fl.dataset.filter; return draw(); }
    const tl = t.closest("[data-tally]");
    if (tl) {
      [I.board, I.filter] = tl.dataset.tally.split(":");
      draw();
      return $(".inf-sec", root())?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
}
export const inferenceState = I;
