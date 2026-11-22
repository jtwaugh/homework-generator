// History modal: weeks in the app, then every homework .tex (newest first), each viewable as PDF | Source | Compile log.
// Compiles are cached by content hash on the server, so flipping between files is instant after the first time.
import { $, $$, esc, api, S } from "./lib.js";
import { app, openWeek } from "./state.js";
import { fmtUSD } from "./cost.js";

const H = { file: null, tab: "pdf", text: "", result: null, loading: false };
const files = () => [...S.texFiles].reverse();

function listHtml() {
  const weeks = S.weeks.map((w) => `<li data-id="${esc(w.id)}" class="${app.week?.id === w.id ? "cur" : ""}"><span>${esc(w.title)}</span><small>${w.done ? "saved " + esc(w.savedAs || "") : "in progress"}${w.costUSD ? " · " + fmtUSD(w.costUSD) : ""}</small></li>`).join("") || `<li class="muted">None yet</li>`;
  const fs = files().map((n) => `<li data-name="${esc(n)}" class="${H.file === n ? "on" : ""}">${esc(n)}</li>`).join("");
  return `<h3>Weeks in this app</h3><ul class="h-weeks">${weeks}</ul><h3>Homework files</h3><ul class="h-files">${fs}</ul>`;
}

function viewHtml() {
  if (!H.file) return `<div class="h-empty muted">Pick a homework file on the left. ← → move between files.</div>`;
  const r = H.result;
  const tabs = ["pdf", "source", "log"].map((t) => `<button class="tab${H.tab === t ? " on" : ""}" data-tab="${t}">${{ pdf: "PDF", source: "Source", log: "Compile log" }[t]}</button>`).join("");
  let body;
  if (H.loading) body = `<p class="muted"><span class="spin"></span> Compiling ${esc(H.file)}…</p>`;
  else if (H.tab === "pdf") body = r?.ok ? `<iframe src="${r.pdf}#view=FitH"></iframe>` : `<div class="err">Did not compile. See the Compile log tab.</div>`;
  else if (H.tab === "source") body = `<pre class="h-src">${esc(H.text)}</pre>`;
  else body = `<pre class="h-src">${esc(r?.log || "(no log)")}</pre>${r?.warnings?.length ? `<h3>Warnings</h3><pre class="h-src">${esc(r.warnings.join("\n"))}</pre>` : ""}`;
  return `<div class="row h-bar"><b>${esc(H.file)}</b>${r?.cached ? '<span class="muted small">cached</span>' : ""}<span class="spacer"></span><div class="tabs">${tabs}</div>
    ${r?.ok ? `<a class="link-btn" href="${r.pdf}" target="_blank" rel="noopener">Open in new tab ↗</a>` : ""}</div><div class="h-body">${body}</div>`;
}

function draw() {
  const d = $("#history-dlg");
  $(".h-list", d).innerHTML = listHtml();
  $(".h-view", d).innerHTML = viewHtml();
  $(".h-files li.on", d)?.scrollIntoView({ block: "nearest" });
}

async function show(name) {
  H.file = name; H.loading = true; H.result = null; draw();
  try {
    const { text } = await api(`/api/tex/${encodeURIComponent(name)}`);
    if (H.file !== name) return;
    H.text = text;
    const r = await api("/api/compile", { method: "POST", body: { text } });
    if (H.file !== name) return;
    H.result = r;
  } catch (e) { H.result = { ok: false, log: e.message }; }
  H.loading = false; draw();
}

export function openHistory() {
  const d = $("#history-dlg");
  if (!H.file && files().length) show(files()[0]); else draw();
  if (!d.open) d.showModal();
}

{
  const d = $("#history-dlg");
  d.addEventListener("click", async (e) => {
    if (e.target === d) return d.close(); // backdrop
    const w = e.target.closest("li[data-id]");
    if (w) { d.close(); location.hash = ""; return openWeek(w.dataset.id); }
    const f = e.target.closest("li[data-name]");
    if (f) return show(f.dataset.name);
    const t = e.target.closest("[data-tab]");
    if (t) { H.tab = t.dataset.tab; draw(); }
  });
  d.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (e.target.closest("input, textarea")) return;
    const list = files(); if (!list.length) return;
    e.preventDefault();
    const i = Math.max(0, list.indexOf(H.file));
    const next = /Right|Down/.test(e.key) ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1);
    if (list[next] !== H.file) show(list[next]);
  });
}
export const historyState = H;
