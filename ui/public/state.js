// App state shared by every module, the talk-to-Claude loop, phase logic and the render registry.
// ES modules can't reassign imported bindings, so state lives on mutable exported objects (app, S).
import { $, $$, api, S, parseLadder, extractBlock, lintTex, log } from "./lib.js";
import { applyWeekUpdate, weekUpdateInputs } from "./statusmd.js";

export const app = {
  week: null,              // current week from the server, or null while setting up
  texOverride: null,       // { src: messageAt, text } when the teacher edits the LaTeX by hand
  finishedWhileHidden: false,
  peek: null,              // "outline" while looking back at the outline from the final step (breadcrumb)
};
export const compiled = new Map(); // tex source -> compile result (or { pending: true })

// ---------- render registry ----------
const renderers = [];
export const onRender = (fn) => renderers.push(fn);
let rendering = false, again = false;
let lastPhase = null, lastWeek = null;
export function render() {
  if (rendering) { again = true; return; }
  rendering = true;
  try {
    const phase = phaseOf();
    const ctx = { phase };
    const wk = app.week?.id || null;
    if (phase !== lastPhase || wk !== lastWeek) { if (lastPhase !== null) app.peek = null; log("phase", { from: lastPhase, to: phase, week: wk }); lastPhase = phase; lastWeek = wk; }
    for (const fn of renderers) {
      try { fn(ctx); } catch (e) { console.error("render failed in", fn.name, e); log("render-error", { fn: fn.name, error: String(e.stack || e).slice(0, 500) }); }
    }
  } finally { rendering = false; }
  if (again) { again = false; render(); }
}

// ---------- phase ----------

// The checkpoint format always has these lines; a reply without them is Claude asking questions.
export const isCheckpoint = (text) => /judgment calls|removed in audit|sourced ideas/i.test(text);
export const hasTex = (m) => m.role === "assistant" && !!extractBlock(m.text || "", ["latex", "tex"]);

export function splitMessages(week = app.week) {
  const msgs = week?.messages || [];
  let cut = msgs.findIndex((m) => m.kind === "approve");
  if (cut < 0) { const t = msgs.findIndex(hasTex); cut = t < 0 ? msgs.length : t; }
  return { outline: msgs.slice(0, cut), final: msgs.slice(cut) };
}

// Leave the open week (it stays in History) and show a blank setup. "#new" stops refresh() reopening it.
export async function newWeek() {
  app.week = null; app.texOverride = null; app.peek = null;
  history.replaceState(null, "", "#new");
  await refresh();
}
const clearNewHash = () => { if (location.hash === "#new") history.replaceState(null, "", location.pathname + location.search); };

export function phaseOf() {
  const week = app.week;
  if (!week) return "setup";
  if (week.done) return "done";
  const { final } = splitMessages();
  if (!final.length) return week.running ? "outline-running" : "outline";
  return week.running ? "final-running" : "final";
}

export function currentFinal() {
  const { final } = splitMessages();
  const msg = [...final].reverse().find(hasTex);
  if (!msg) return null;
  const tex = app.texOverride?.src === msg.at ? app.texOverride.text : extractBlock(msg.text, ["latex", "tex"]);
  // Next week's status, as Save & finish will write it: the app applies the week's promotions and the final's
  // status-update block to its own record (the server does the same from the same inputs). null: no change.
  const inputs = weekUpdateInputs(app.week, msg, S.savedStatus);
  const next = applyWeekUpdate(S.savedStatus, inputs);
  const status = next.trimEnd() !== S.savedStatus.trimEnd() ? next : null;
  const manifest = extractBlock(msg.text, ["json"], (b) => { try { return Array.isArray(JSON.parse(b)); } catch { return false; } });
  return { msg, tex, status, update: inputs.update, manifest: manifest ? JSON.parse(manifest) : null };
}

export function fnameFromDate() {
  const d = (app.week?.title || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return d ? `hw_${+d[1]}_${+d[2]}_${d[3]}.tex` : "hw_new.tex";
}

// ---------- compile + checks ----------

export function compile(tex) {
  if (!compiled.has(tex)) {
    compiled.set(tex, { pending: true });
    api("/api/compile", { method: "POST", body: { text: tex } })
      .then((r) => compiled.set(tex, r))
      .catch((e) => compiled.set(tex, { ok: false, log: e.message, warnings: [] }))
      .finally(render);
  }
  return compiled.get(tex);
}

export function problemsOf(tex, c, statusMd) {
  const lint = lintTex(tex, statusMd);
  const overfull = (c.warnings || []).filter((w) => /overfull/i.test(w));
  return { lint, overfull, blocking: !c.pending && (!c.ok || overfull.length > 0 || lint.some(([k]) => k === "bad")) };
}

// CAS calls since the outline was approved (the answer-key checks).
export const isCas = (t) => /(^|__)cas$/.test(t.name || "");
export function casCalls(week = app.week) {
  const { final } = splitMessages(week);
  const done = final.flatMap((m) => (m.tools || []).filter(isCas));
  const live = week?.running ? (week.live?.tools || []).filter(isCas) : [];
  return [...done, ...live];
}

// ---------- weekly_status.md editing (debounced save) ----------

let saveTimer = null;
export function updateStatus(text) {
  S.status = text;
  const s = $("#save-state"); if (s) s.textContent = "Saving…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushStatus, 600);
  render();
}
export async function flushStatus(backup = false) {
  clearTimeout(saveTimer);
  if (S.status === S.savedStatus) return;
  await api("/api/status", { method: "PUT", body: { text: S.status, backup } });
  S.savedStatus = S.status;
  const s = $("#save-state"); if (s) s.textContent = "Saved";
}

// ---------- talking to Claude ----------

let pollTimer = null, tickTimer = null;
let sending = null; // id of the week whose POST /message is still open: until it answers, the server may not know the turn is running yet

export async function send(kind, text, extra = {}) {
  const week = app.week;
  if (!week || week.running) return;
  week.messages.push({ role: "user", text, kind, at: new Date().toISOString() });
  week.running = true;
  week.sendError = null;
  week.live = { text: "", tools: [], startedAt: Date.now() };
  sending = week.id;
  render();
  fetch(`/api/weeks/${week.id}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, kind, ...extra }) })
    .then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); const rd = r.body.getReader(); while (!(await rd.read()).done); })
    .catch((e) => { if (app.week?.id === week.id) app.week.sendError = e.message; })
    .finally(() => { sending = null; poll(); });
  startPolling();
}
export const stop = () => app.week && api(`/api/weeks/${app.week.id}/stop`, { method: "POST" });

export function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, 1200);
  clearInterval(tickTimer);
  tickTimer = setInterval(() => $$(".elapsed").forEach((el) => (el.textContent = elapsed())), 1000);
}
async function poll() {
  if (!app.week) return;
  const was = app.week.running, sendError = app.week.sendError, id = app.week.id;
  const w = await api(`/api/weeks/${id}`).catch(() => null);
  if (!w || app.week?.id !== id) return;
  if (!w.running && sending === id) Object.assign(w, { running: true, live: app.week.live, messages: app.week.messages }); // the turn hasn't been registered yet
  app.week = w;
  if (sendError && !w.running) w.sendError = sendError;
  if (w.running && !pollTimer) startPolling();
  if (!w.running) {
    clearInterval(pollTimer); clearInterval(tickTimer); pollTimer = tickTimer = null;
    if (was) { await refresh(false); if (document.hidden) app.finishedWhileHidden = true; }
  }
  render();
}
export const elapsed = (from = app.week?.live?.startedAt) => { const s = Math.floor((Date.now() - (from || Date.now())) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

export async function openWeek(id) {
  app.week = id ? await api(`/api/weeks/${id}`) : null;
  app.texOverride = null; app.peek = null;
  if (app.week) clearNewHash();
  if (app.week?.running) startPolling();
  render();
}

// ---------- server state ----------

export async function refresh(pickWeek = true) {
  const st = await api("/api/state");
  const dirty = S.status !== S.savedStatus;
  Object.assign(S, { savedStatus: st.status, ladder: st.ladder, texFiles: st.texFiles, student: st.student, curriculum: st.curriculum, enrollment: st.enrollment, weeks: st.weeks, tectonic: st.tectonic, model: st.model, cas: st.cas, auth: st.auth, budget: st.budget, corpusSize: st.corpusSize }, parseLadder(st.ladder));
  document.getElementById("logout").hidden = !st.login;
  if (st.curriculum) document.getElementById("curriculum").textContent = st.curriculum;
  if (!dirty) S.status = st.status;
  if (pickWeek && !app.week) {
    const open = location.hash === "#new" ? null : st.weeks.find((w) => !w.done);
    if (open) { app.week = await api(`/api/weeks/${open.id}`); if (app.week.running) startPolling(); }
  }
  render();
}
