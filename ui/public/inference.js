// History › Inference: every progress-map guess run (newest first) on the left, the selected run on the right:
// summary, cost, disagreements with weekly_status, chain of thought and tool calls, per-node guesses.
// A node id links back to that block on the Progress Map. A run in progress shows live and is polled.
import { $, esc, api, S, md } from "./lib.js";
import { fmtUSD } from "./cost.js";
import { ladderHints, focusNode } from "./dag.js";
import { showPage, isShown } from "./pages.js";

const I = { data: null, run: null, runs: {}, poll: null };
const root = () => $("#p-history .h-inf");
const shown = () => isShown("history") && !root().hidden;

const fmtDur = (ms) => (ms == null ? "" : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
const kb = (c) => (c == null ? "" : c < 1024 ? `${c} chars` : `${Math.round(c / 1024)}K chars`);

function listHtml() {
  const runs = I.data.runs || [], job = I.data.job;
  const total = runs.reduce((a, r) => a + (r.costUSD || 0), 0);
  const live = job?.running ? `<li data-run="live" class="${I.run === "live" ? "on" : ""}"><span><span class="spin"></span> Running now</span><small>${esc(I.data.guessModel || "")} · ${fmtDur(job.elapsed)}</small></li>` : "";
  const rows = runs.map((r) => `<li data-run="${esc(r.id)}" class="${I.run === r.id ? "on" : ""}${r.ok ? "" : " failed"}">
    <span>${esc(new Date(r.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}${r.id === I.data.guess?.runId ? ' <span class="cur-tag">current</span>' : ""}</span>
    <small>${esc(r.model || "")} · ${r.ok ? fmtUSD(r.costUSD) : "failed"}${r.ms ? " · " + fmtDur(r.ms) : ""}</small></li>`).join("");
  const btn = job?.running ? `<button class="secondary" data-act="stop-guess">Stop</button>`
    : `<button class="primary" data-act="guess" title="One ${esc(I.data.guessModel || "")} run over every homework file and your notes, for both boards">${I.data.guess ? "Guess again" : "Guess progress"}</button>`;
  return `<div class="row inf-head"><h3>Progress guesses</h3><span class="spacer"></span>${btn}</div>
    <p class="muted small">${runs.length} run${runs.length === 1 ? "" : "s"} · ${fmtUSD(total)} in all</p>
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
  const title = (k) => (k.startsWith("m:") ? I.data.methods : I.data.content)?.nodes.find((x) => x.id === k.replace(/^m:/, ""))?.title || "";
  return `<details class="run-nodes"><summary>Per-node guesses (${nodes.length})</summary><table class="nodes-t"><tr><th>Node</th><th>State</th><th>Sure</th><th>Evidence</th></tr>
    ${nodes.map(([k, g]) => `<tr><td><button class="link" data-goto-key="${esc(k)}">${esc(k)}</button> ${esc(title(k))}</td><td class="d-${esc(g.state || "")}">${esc(g.state || "")}</td><td>${g.confidence != null ? Math.round(g.confidence * 100) + "%" : ""}</td>
      <td>${(g.evidence || []).map((e) => `<div><b>${esc(e.file || "")}</b>${e.quote ? ` <q>${esc(e.quote)}</q>` : ""}</div>`).join("")}</td></tr>`).join("")}</table></details>`;
}

function detailHtml() {
  const job = I.data.job;
  if (I.run === "live") {
    if (!job?.running) return '<p class="muted">The run finished. Pick it on the left.</p>';
    return `<div class="row"><h2>Running now</h2><span class="muted small">${esc(I.data.guessModel || "")} · ${fmtDur(job.elapsed)}</span><span class="spacer"></span><button class="secondary" data-act="stop-guess">Stop</button></div>
      <h3>Chain of thought</h3>${logHtml(job.log, true)}`;
  }
  const r = I.runs[I.run];
  if (!I.run) return `<div class="h-empty muted">${(I.data.runs || []).length ? "Pick a run on the left." : "No guesses yet. Press <b>Guess progress</b>."}</div>`;
  if (!r) return '<p class="muted"><span class="spin"></span> Loading…</p>';
  if (r.error && !r.log) return `<div class="err">${esc(r.error)}</div>`;
  const hints = r.ok ? ladderHints(S.status, r.ladderToWu, { nodes: r.nodes }, I.data.overrides) : [];
  return `<div class="row"><h2>${esc(new Date(r.at).toLocaleString())}</h2><span class="muted small">${esc(r.model || "")} · ${r.files ?? "?"} files read</span></div>
    ${r.ok ? "" : `<div class="err">Failed: ${esc(r.error || "")}</div>`}
    ${r.summary ? `<h3>Summary</h3><p>${esc(r.summary)}</p>` : ""}
    <h3>Cost</h3>${costHtml(r.usage) || '<p class="muted small">No usage recorded.</p>'}
    ${r.ok ? `<h3>Against weekly_status</h3>${hints.length ? `<ul class="hints">${hints.map((h) => `<li class="h-${h.kind}">${esc(h.text)} <span class="nls">${h.ids.map((k) => `<button class="link" data-goto-key="${esc(k)}">${esc(k)}</button>`).join(" ")}</span></li>`).join("")}</ul>` : '<p class="muted small">No disagreements between the unit statuses and this guess.</p>'}` : ""}
    <h3>Chain of thought</h3>${logHtml(r.log)}
    ${nodesTableHtml(r)}`;
}

function draw() {
  const d = root();
  if (!I.data) { d.innerHTML = `<p class="muted">Loading…</p>`; return; }
  const keep = $(".run-main", d)?.scrollTop || 0;
  d.innerHTML = `<div class="h-wrap inf-runs"><aside class="h-list">${listHtml()}</aside><div class="h-main run-main">${detailHtml()}</div></div>`;
  const m = $(".run-main", d); if (m) m.scrollTop = keep;
}

async function pickRun(id) {
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
    const rn = t.closest("[data-run]"); if (rn) return pickRun(rn.dataset.run);
    const gk = t.closest("[data-goto-key]"); if (gk) { focusNode(gk.dataset.gotoKey); return showPage("dag"); }
  });
}
export const inferenceState = I;
