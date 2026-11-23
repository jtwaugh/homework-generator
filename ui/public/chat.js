// Left pane: the whole conversation with Claude, tool-call chips, per-turn cost, and an always-there composer.
import { $, $$, esc, md, kindOf } from "./lib.js";
import { app, onRender, send, stop, elapsed, phaseOf, splitMessages, isCheckpoint } from "./state.js";
import { costFooter } from "./cost.js";

// ---------- tool chips ----------

const ICON = { WebSearch: "🔎", WebFetch: "🌐", corpus_search: "📚", corpus_add: "📚", cas: "🧮", Read: "📄" };
const short = (n) => String(n || "").replace(/^mcp__hw__/, "");
export function toolLabel(t) {
  const n = short(t.name), i = t.input || {};
  if (n === "WebSearch") return i.query || "search";
  if (n === "WebFetch") { try { const u = new URL(i.url); return u.host.replace(/^www\./, "") + u.pathname.replace(/\/$/, ""); } catch { return i.url || "fetch"; } }
  if (n === "corpus_search") return `corpus: ${[...(i.units || []), i.query || ""].filter(Boolean).join(" ") || "search"}`;
  if (n === "corpus_add") return `saved ${(i.problems || []).length} problem${(i.problems || []).length === 1 ? "" : "s"} to corpus`;
  if (n === "cas") { const lines = String(i.code || "").split("\n").filter((l) => l.trim()).length; return `CAS check (${lines} line${lines === 1 ? "" : "s"})`; }
  if (n === "Read") return i.file_path?.split("/").pop() || "read";
  return n;
}
function toolChip(t, key) {
  const n = short(t.name);
  const status = t.ok === false ? " bad" : t.chars == null ? " pending" : "";
  const meta = [t.chars != null ? `${(t.chars / 1000).toFixed(1)}k chars` : "running…", t.ms != null ? `${(t.ms / 1000).toFixed(1)}s` : ""].filter(Boolean).join(" · ");
  const input = n === "cas" ? t.input?.code : JSON.stringify(t.input, null, 1);
  return `<details class="tool-chip${status}" data-key="${esc(key)}"><summary><span class="ti">${ICON[n] || "🔧"}</span><span class="tl">${esc(toolLabel(t))}</span></summary>
    <div class="tool-body"><div class="muted small">${esc(n)} · ${esc(meta)}</div><pre>${esc(input || "")}</pre>${t.preview ? `<div class="muted small">result</div><pre>${esc(t.preview)}</pre>` : ""}</div></details>`;
}
const chipsHtml = (tools, prefix) => (tools?.length ? `<div class="chips-row">${tools.map((t, i) => toolChip(t, `${prefix}-${i}`)).join("")}</div>` : "");

// ---------- step trace: thinking, narration and tool calls in the order they happened ----------

const STAGE_NAME = { research: "Research", outline: "Outline", final: "Writing", fix: "Fixing", verify: "Answer check" };
const modelShort = (m) => String(m || "").replace(/^claude-/, "").replace(/-\d{8}$/, "");
function toolStep(t, key) {
  const n = short(t.name);
  const status = t.ok === false ? " bad" : t.chars == null ? " pending" : "";
  const meta = t.chars == null ? "running…" : [t.ms != null ? `${(t.ms / 1000).toFixed(1)}s` : "", `${(t.chars / 1000).toFixed(1)}k`].filter(Boolean).join(" · ");
  const input = n === "cas" ? t.input?.code : JSON.stringify(t.input, null, 1);
  return `<li class="tr-tool${status}"><details data-key="${esc(key)}"><summary><span class="ti">${ICON[n] || "🔧"}</span><span class="tl">${esc(toolLabel(t))}</span><span class="tm">${esc(t.ok === false ? "failed" : meta)}</span></summary>
    <div class="tool-body"><div class="muted small">${esc(n)}</div><pre>${esc(input || "")}</pre>${t.preview ? `<div class="muted small">result</div><pre>${esc(t.preview)}</pre>` : ""}</div></details></li>`;
}
function traceHtml(trace, tools, prefix, live) {
  const byId = new Map((tools || []).map((t) => [t.id, t]));
  const lastThink = live ? trace.findLastIndex((x) => x.k === "think") : -1;
  return `<ol class="trace">${trace.map((x, i) => {
    const key = `${prefix}-${i}`;
    if (x.k === "stage") return `<li class="tr-stage"><span>${esc(STAGE_NAME[x.stage] || x.stage)}</span>${x.model ? `<span class="muted"> · ${esc(modelShort(x.model))}</span>` : ""}</li>`;
    if (x.k === "tool") { const t = byId.get(x.id); return t ? toolStep(t, key) : ""; }
    const text = (x.text || "").trim();
    if (!text || text === "---") return "";
    if (x.k === "think") {
      const current = i === lastThink && i === trace.length - 1;
      return `<li class="tr-think${current ? " now" : ""}"><details data-key="${esc(key)}"${current ? " open" : ""}><summary><span class="ti">💭</span><span class="tl">${esc(text.replace(/\s+/g, " ").slice(0, 600))}</span></summary><div class="think-body">${esc(text)}</div></details></li>`;
    }
    return `<li class="tr-say"><div class="md">${assistantHtml(text)}</div></li>`;
  }).join("")}</ol>`;
}
// A finished turn keeps its steps folded away above the reply; older weeks without a trace fall back to chips.
function stepsHtml(m, prefix) {
  if (!m.trace?.length) return chipsHtml(m.tools, prefix);
  const nTools = m.trace.filter((x) => x.k === "tool").length, nThink = m.trace.filter((x) => x.k === "think" && x.text.trim()).length;
  const bits = [nTools && `${nTools} tool call${nTools === 1 ? "" : "s"}`, nThink && `${nThink} thought${nThink === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
  return `<details class="steps-wrap" data-key="${esc(prefix)}-steps"><summary>Steps${bits ? ` <span class="muted">· ${bits}</span>` : ""}</summary>${traceHtml(m.trace, m.tools, prefix, false)}</details>`;
}

// ---------- messages ----------

// Long fenced blocks (the .tex, weekly_status.md, the manifest) go to the work pane; show a stub here.
const BLOCK_NAME = { latex: "LaTeX source", tex: "LaTeX source", markdown: "weekly_status.md", md: "weekly_status.md", json: "problem manifest" };
function assistantHtml(text) {
  const stubs = [];
  const src = (text || "").replace(/```([a-zA-Z]*)\n([\s\S]*?)\n```/g, (all, lang, body) => {
    const name = BLOCK_NAME[lang.toLowerCase()];
    if (!name || body.split("\n").length < 8) return all;
    stubs.push(`<div class="block-stub">📄 ${name} · ${body.split("\n").length} lines <span class="muted">· shown on the right</span></div>`);
    return `\n@@STUB${stubs.length - 1}@@\n`;
  });
  return md(src).replace(/<p>@@STUB(\d+)@@<\/p>/g, (_, i) => stubs[+i]);
}

function userLabel(m) {
  const t = m.text || "";
  switch (kindOf(m)) {
    case "start": return `📋 Sent this week's status${m.preload ? ` and ${m.preload.count} corpus matches (${esc(m.preload.units.join(", ") || "no units")})` : ""}`;
    case "approve": { const e = t.match(/with these edits:\n([\s\S]*?)\nWrite the final/); return `✓ Approved the outline${e ? `, with edits:<div class="quote">${esc(e[1])}</div>` : ""}`; }
    case "fix": return `🔧 Sent the compile and check results for fixing<details><summary class="muted small">details</summary><pre>${esc(t)}</pre></details>`;
    default: return esc(t.replace(/\n\nSend the complete revised[\s\S]*$/, "").replace(/\n\n(For anything I didn't answer, use|Use) your stated default[\s\S]*$/, "\n\n(use your defaults for the rest)"));
  }
}

function threadHtml() {
  const week = app.week;
  if (!week) return `<div class="chat-empty"><h3>How a week goes</h3><ol class="steps">
    <li><b>Set up</b><span>Pick topics on the right. The rest has defaults.</span></li>
    <li><b>Outline</b><span>Claude researches, may ask a question or two, then proposes sections for you to approve.</span></li>
    <li><b>Final</b><span>Claude writes the set. You check the PDF and save it.</span></li></ol>
    <p class="muted small">This pane is the conversation: Claude's replies, its searches and corpus lookups, CAS checks and the cost of each turn. <b>Quick set</b> skips step 2.</p></div>`;
  const out = [];
  const { outline } = splitMessages();
  // The latest outline reply is shown in full in the work pane, so the chat keeps only its opening line.
  const shownRight = !week.running && !week.done && outline.length === week.messages.length ? [...outline].reverse().find((m) => m.role === "assistant") : null;
  week.messages.forEach((m, i) => {
    if (i === outline.length && i > 0) out.push(`<div class="phase-sep"><span>Final</span></div>`);
    if (m.role === "user") out.push(`<div class="msg user k-${esc(kindOf(m))}">${userLabel(m)}</div>`);
    else if (m === shownRight) out.push(`<div class="msg assistant">${stepsHtml(m, `m${i}`)}<div class="md">${md((m.text || "").split(/\n\s*\n/)[0].slice(0, 400))}</div><div class="block-stub">📋 ${isCheckpoint(m.text) ? "Outline checkpoint" : "Claude's questions"} <span class="muted">· shown on the right</span></div>${m.error ? `<div class="err">Stopped: ${esc(m.error)}</div>` : ""}${costFooter(m)}</div>`);
    else out.push(`<div class="msg assistant">${stepsHtml(m, `m${i}`)}<div class="md">${assistantHtml(m.text)}</div>${m.error ? `<div class="err">Stopped: ${esc(m.error)}</div>` : ""}${costFooter(m)}</div>`);
  });
  if (week.running) {
    const live = week.live || { text: "", tools: [] };
    const body = live.trace ? traceHtml(live.trace, live.tools, "live", true) : `${chipsHtml(live.tools, "live")}<div class="md">${live.text ? assistantHtml(live.text) : ""}</div>`;
    out.push(`<div class="msg assistant live">${body}
      <div class="working-line"><span class="spin"></span>${live.tools.length || live.text ? "Working" : "Starting"} <span class="elapsed">${elapsed()}</span><span class="muted"> · you can leave this page</span></div></div>`);
  }
  if (week.sendError && !week.running) out.push(`<div class="err">Couldn't send: ${esc(week.sendError)}</div>`);
  if (week.lastError && !week.running && !week.messages.some((m) => m.role === "assistant")) out.push(`<div class="err">Last attempt failed: ${esc(week.lastError)}</div>`);
  return out.join("");
}

// ---------- composer ----------

function composerMode(phase) {
  const week = app.week;
  if (!week) return { disabled: true, ph: "Start a week to chat with Claude" };
  if (phase === "done") return { disabled: true, ph: "This week is saved" };
  if (phase.endsWith("running")) return { disabled: true, running: true, ph: "Claude is working…" };
  if (phase === "outline") {
    const lastA = [...splitMessages().outline].reverse().find((m) => m.role === "assistant");
    if (lastA && !isCheckpoint(lastA.text)) return { kind: "revise", ph: "Answer Claude's questions  (⌘↩ to send)" };
    return { kind: "revise", ph: "Ask for changes to the outline, or Approve on the right  (⌘↩)" };
  }
  return { kind: "chat", ph: "Ask for changes; Claude resends the full .tex  (⌘↩)" };
}

let lastSig = "";
onRender(function renderChat({ phase }) {
  const week = app.week;
  const thread = $("#thread");
  const sig = JSON.stringify([week?.id, week?.messages.length, week?.running, week?.live?.text.length, week?.live?.tools.map((t) => t.chars ?? -1), week?.live?.trace?.length, week?.live?.trace?.at(-1)?.text?.length, week?.sendError]);
  if (sig !== lastSig) {
    lastSig = sig;
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
    const open = new Set($$("details[data-key][open]", thread).map((d) => d.dataset.key));
    thread.innerHTML = threadHtml();
    for (const d of $$("details[data-key]", thread)) if (open.has(d.dataset.key)) d.open = true;
    if (nearBottom || !open.size) { thread.scrollTop = thread.scrollHeight; requestAnimationFrame(() => (thread.scrollTop = thread.scrollHeight)); }
  }
  const mode = composerMode(phase);
  const ta = $("#composer");
  $("#composer-wrap").hidden = !week;
  ta.disabled = !!mode.disabled;
  ta.placeholder = mode.ph;
  ta.dataset.kind = mode.kind || "";
  $("#composer-send").hidden = !!mode.running;
  $("#composer-send").disabled = !!mode.disabled || !ta.value.trim();
  $("#composer-stop").hidden = !mode.running;
});

const submit = () => {
  const ta = $("#composer"), t = ta.value.trim();
  if (!t || ta.disabled) return;
  ta.value = "";
  send(ta.dataset.kind || "chat", t);
};
$("#composer").addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); } });
$("#composer").addEventListener("input", () => ($("#composer-send").disabled = !$("#composer").value.trim()));
$("#composer-send").onclick = submit;
$("#composer-stop").onclick = stop;
export const composerText = () => $("#composer").value.trim();
export const clearComposer = () => ($("#composer").value = "");
