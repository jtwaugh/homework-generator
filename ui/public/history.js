// History › Sessions: a list of sessions on the left (one per generated homework, newest first, grouped by date
// like the Claude app), and the selected session on the right, read-only: the Conversation (the teacher's
// inputs and all of Claude's work: steps, tool calls, replies, cost) and the Homework it produced
// (PDF | Source | Compile log). Old .tex files with no session in the app are listed at the bottom.
// Compiles are cached by content hash on the server, so flipping between sessions is quick after the first time.
// History › Inference (every progress-map guess run) is inference.js; the sidebar sub-items pick which shows.
import { $, $$, esc, api, S, extractBlock } from "./lib.js";
import { app, splitMessages, hasTex, openWeek } from "./state.js";
import { fmtUSD, openCost } from "./cost.js";
import { transcriptHtml } from "./chat.js";
import { isShown, showPage } from "./pages.js";
import { openInference } from "./inference.js";

// sel: "w:<week id>" or "f:<file name>". view: "chat" | "hw". tab: the Homework sub-tab.
// sub: the sub-view, "sessions" | "inference".
const H = { sub: "sessions", sel: null, view: "chat", tab: "pdf", q: "", week: null, weekErr: null, tex: null, texFrom: "", result: null, loading: false, filesOpen: false };

const savedNames = () => new Set(S.weeks.map((w) => w.savedAs).filter(Boolean));
const looseFiles = () => [...S.texFiles].reverse().filter((n) => !savedNames().has(n));
// Sessions are the working-on student's (S.enrollment); loose files belong to no one and show for everyone.
const mine = () => S.weeks.filter((w) => !S.enrollment || w.enrollmentId == null || w.enrollmentId === S.enrollment.id);
const match = (s) => !H.q || s.toLowerCase().includes(H.q.toLowerCase());

const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
function groupOf(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "Older";
  const days = Math.round((dayStart(new Date()) - dayStart(d)) / 864e5);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return d.toLocaleString(undefined, { month: "long", year: "numeric" });
}
const fmtWhen = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// The keys in list order, for ← →.
function order() {
  const ws = mine().filter((w) => match(`${w.title} ${w.savedAs || ""}`)).map((w) => `w:${w.id}`);
  const fs = H.filesOpen || H.q ? looseFiles().filter(match).map((n) => `f:${n}`) : [];
  return [...ws, ...fs];
}

function listHtml() {
  const weeks = mine().filter((w) => match(`${w.title} ${w.savedAs || ""}`));
  const groups = [];
  for (const w of weeks) {
    const g = groupOf(w.createdAt);
    if (groups.at(-1)?.name !== g) groups.push({ name: g, items: [] });
    groups.at(-1).items.push(w);
  }
  const row = (w) => {
    const state = w.done ? "" : app.week?.id === w.id && app.week.running ? '<span class="s-dot run" title="Claude is working"></span>' : '<span class="s-dot open" title="In progress"></span>';
    const sub = [w.done ? esc(w.savedAs || "saved") : "in progress", w.costUSD ? fmtUSD(w.costUSD) : ""].filter(Boolean).join(" · ");
    return `<li data-key="w:${esc(w.id)}" class="${H.sel === `w:${w.id}` ? "on" : ""}"><span class="s-title">${state}${esc(w.title)}</span><small>${sub}</small></li>`;
  };
  const sessions = groups.map((g) => `<h4>${esc(g.name)}</h4><ul class="s-list">${g.items.map(row).join("")}</ul>`).join("")
    || `<p class="muted small s-none">${H.q ? "No sessions match." : `No sessions for ${esc(S.student || "this student")} yet. Each homework you create shows up here.`}</p>`;
  const files = looseFiles().filter(match);
  const open = H.filesOpen || !!H.q;
  const filesHtml = files.length ? `<details class="s-files"${open ? " open" : ""}><summary>Files without a session <span class="muted">(${files.length})</span></summary>
    <ul class="s-list">${files.map((n) => `<li data-key="f:${esc(n)}" class="file${H.sel === `f:${n}` ? " on" : ""}"><span class="s-title">${esc(n)}</span></li>`).join("")}</ul></details>` : "";
  return `<div class="s-search"><input type="search" placeholder="Search sessions" value="${esc(H.q)}" aria-label="Search sessions"></div><div class="s-scroll">${sessions}${filesHtml}</div>`;
}

function homeworkHtml() {
  if (H.loading) return `<p class="muted"><span class="spin"></span> Compiling…</p>`;
  if (!H.tex) return `<div class="h-empty muted">${H.week ? "Claude hasn't written the homework yet in this session." : "Nothing to show."}</div>`;
  const r = H.result;
  const tabs = ["pdf", "source", "log"].map((t) => `<button class="tab${H.tab === t ? " on" : ""}" data-tab="${t}">${{ pdf: "PDF", source: "Source", log: "Compile log" }[t]}</button>`).join("");
  let body;
  if (H.tab === "pdf") body = r?.ok ? `<iframe src="${r.pdf}#view=FitH"></iframe>` : `<div class="err">Did not compile. See the Compile log tab.</div>`;
  else if (H.tab === "source") body = `<pre class="h-src">${esc(H.tex)}</pre>`;
  else body = `<pre class="h-src">${esc(r?.log || "(no log)")}</pre>${r?.warnings?.length ? `<h3>Warnings</h3><pre class="h-src">${esc(r.warnings.join("\n"))}</pre>` : ""}`;
  return `<div class="row h-bar"><span class="muted small">${esc(H.texFrom)}</span>${r?.cached ? '<span class="muted small">· cached</span>' : ""}<span class="spacer"></span><div class="seg">${tabs}</div>
    ${r?.ok ? `<a class="link-btn" href="${r.pdf}" target="_blank" rel="noopener">Open in new tab ↗</a>` : ""}</div><div class="h-body">${body}</div>`;
}

function viewHtml() {
  if (!H.sel) return `<div class="h-empty muted">Pick a session on the left. ← → move between them.</div>`;
  const isFile = H.sel.startsWith("f:");
  const w = H.week;
  let title, meta = "";
  if (isFile) title = H.sel.slice(2);
  else if (H.weekErr) return `<div class="err">Couldn't load this session: ${esc(H.weekErr)}</div>`;
  else if (!w) return `<p class="muted"><span class="spin"></span> Loading…</p>`;
  else {
    title = w.title;
    const turns = w.messages.filter((m) => m.role === "assistant").length;
    const cost = w.messages.reduce((s, m) => s + (m.usage?.costUSD || 0), 0);
    meta = [fmtWhen(w.createdAt), (w.model || "").replace(/^claude-/, ""), `${turns} repl${turns === 1 ? "y" : "ies"}`, cost ? fmtUSD(cost) : "",
      w.running ? "Claude is working" : w.done ? `saved as ${w.savedAs || "?"}` : "in progress"].filter(Boolean).map(esc).join(" · ");
  }
  const resume = !isFile && w && !w.done ? `<button class="primary" data-act="continue" title="Pick this week up where it left off">Continue in Create Homework →</button>` : "";
  const views = isFile ? "" : `<div class="seg">${[["chat", "Conversation"], ["hw", "Homework"]].map(([k, l]) => `<button class="tab${H.view === k ? " on" : ""}" data-view="${k}">${l}</button>`).join("")}</div>`;
  const body = isFile || H.view === "hw" ? `<div class="h-hw">${homeworkHtml()}</div>` : `<div class="h-thread thread">${transcriptHtml(w)}</div>`;
  return `<div class="h-head"><div class="h-titles"><h2>${esc(title)}</h2>${meta ? `<div class="muted small">${meta}</div>` : isFile ? `<div class="muted small">Homework file from before this app kept sessions</div>` : ""}</div><span class="spacer"></span>${views}${resume}</div>${body}`;
}

function drawList() {
  const d = $("#p-history .h-list");
  const focused = document.activeElement?.closest?.(".s-search") ? document.activeElement.selectionStart : null;
  const scroll = $(".s-scroll", d)?.scrollTop || 0;
  d.innerHTML = listHtml();
  $(".s-scroll", d).scrollTop = scroll;
  if (focused != null) { const i = $(".s-search input", d); i.focus(); i.setSelectionRange(focused, focused); }
  $("li.on", d)?.scrollIntoView({ block: "nearest" });
}
function drawView() {
  const v = $("#p-history .h-view");
  const open = new Set($$("details[data-key][open]", v).map((x) => x.dataset.key));
  v.innerHTML = viewHtml();
  for (const x of $$("details[data-key]", v)) if (open.has(x.dataset.key)) x.open = true;
}
const draw = () => { drawList(); drawView(); };

// The homework a session produced: the saved file if there is one, else the latest .tex Claude wrote.
async function loadHomework(key) {
  H.tex = null; H.result = null; H.texFrom = "";
  if (key.startsWith("f:")) {
    const name = key.slice(2);
    H.tex = (await api(`/api/tex/${encodeURIComponent(name)}`)).text; H.texFrom = name;
  } else {
    const w = H.week;
    if (w.savedAs && S.texFiles.includes(w.savedAs)) { H.tex = (await api(`/api/tex/${encodeURIComponent(w.savedAs)}`)).text; H.texFrom = w.savedAs; }
    else {
      const msg = [...splitMessages(w).final].reverse().find(hasTex);
      if (msg) { H.tex = extractBlock(msg.text, ["latex", "tex"]); H.texFrom = `latest draft · ${fmtWhen(msg.at)}`; }
    }
  }
  if (H.sel !== key || !H.tex) return;
  H.loading = true; drawView();
  try { H.result = await api("/api/compile", { method: "POST", body: { text: H.tex } }); }
  catch (e) { H.result = { ok: false, log: e.message }; }
  if (H.sel === key) H.loading = false;
}

async function select(key) {
  if (H.sel !== key) { H.sel = key; H.week = null; H.weekErr = null; H.tex = null; H.result = null; H.loading = false; }
  if (key.startsWith("f:")) H.view = "hw";
  draw();
  try {
    if (key.startsWith("w:")) {
      const w = await api(`/api/weeks/${encodeURIComponent(key.slice(2))}`);
      if (H.sel !== key) return;
      H.week = w; drawView();
    }
    await loadHomework(key);
  } catch (e) { if (H.sel === key) { if (key.startsWith("w:") && !H.week) H.weekErr = e.message; else H.result = { ok: false, log: e.message }; H.loading = false; } }
  if (H.sel === key) drawView();
}

export function openHistory(btn) {
  if (btn?.dataset.hist) H.sub = btn.dataset.hist;
  for (const b of $$("[data-hist]")) b.classList.toggle("on", b.dataset.hist === H.sub);
  $("#p-history .h-sessions").hidden = H.sub !== "sessions";
  $("#p-history .h-inf").hidden = H.sub !== "inference";
  if (H.sub === "inference") return openInference();
  const keys = order();
  if (!H.sel || (!keys.includes(H.sel) && !H.sel.startsWith("f:"))) { if (keys.length) return select(keys[0]); H.sel = null; return draw(); }
  select(H.sel); // refetch: the session may have moved on since
}

{
  const d = $("#p-history");
  $(".h-sessions", d).addEventListener("click", (e) => {
    const li = e.target.closest("li[data-key]");
    if (li) return select(li.dataset.key);
    const v = e.target.closest("[data-view]");
    if (v) { H.view = v.dataset.view; return drawView(); }
    const t = e.target.closest("[data-tab]");
    if (t) { H.tab = t.dataset.tab; return drawView(); }
    if (e.target.closest("[data-act=continue]") && H.week) { showPage("create"); return openWeek(H.week.id); }
    if (e.target.closest(".cost-foot") && H.week) { e.stopPropagation(); openCost(H.week); }
  });
  d.addEventListener("toggle", (e) => { if (e.target.classList?.contains("s-files")) H.filesOpen = e.target.open; }, true);
  d.addEventListener("input", (e) => { if (e.target.matches(".s-search input")) { H.q = e.target.value; drawList(); } });
  document.addEventListener("keydown", (e) => {
    if (!isShown("history") || H.sub !== "sessions" || document.querySelector("dialog[open]")) return;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    if (e.target.closest?.("input, textarea, select")) return;
    const list = order(); if (!list.length) return;
    e.preventDefault();
    const i = list.indexOf(H.sel);
    const next = i < 0 ? 0 : /Right|Down/.test(e.key) ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1);
    if (list[next] !== H.sel) select(list[next]);
  });
}
export const historyState = H;
