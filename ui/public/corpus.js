// Corpus browser: every problem Claude can reuse. A sortable table by default (cards as an option), filters by
// unit, status and source, a search box, ★ (favorite: preferred in the preload) / ✕ (rejected: never offered
// again), and a side chat that answers questions about the corpus (POST /api/corpus/chat; read-only).
import { $, esc, api, S, md, mathify, log } from "./lib.js";

const PAGE = 100;
const C = { items: null, q: "", unit: "", status: "", source: "", ids: null, idsLabel: "", sort: { key: "added", dir: -1 }, view: localStorage.getItem("corpusView") || "table", open: new Set(), limit: PAGE };
const STATUS_LABEL = { candidate: "Candidate", used: "Used", favorite: "★ Favorite", rejected: "✕ Rejected" };
const SOURCE_LABEL = { gold: "Gold set", final: "Past homework", web: "Web", teacher: "Teacher", claude: "Claude" };
const STATUS_ORDER = { favorite: 0, candidate: 1, used: 2, rejected: 3 };

function matches(p) {
  if (C.ids && !C.ids.includes(p.id)) return false;
  if (C.unit && !(p.units || []).includes(C.unit)) return false;
  if (C.status && (p.status || "candidate") !== C.status) return false;
  if (C.source && p.source?.kind !== C.source) return false;
  if (C.q) {
    const hay = [p.id, p.tex, p.answer, p.context, ...(p.tags || []), ...(p.units || []), p.source?.file, p.source?.url].join(" ").toLowerCase();
    if (!C.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}

// Display math and alignment breaks become inline $…$ so mathify can render them in a one-line preview.
const preview = (tex, n = 420) => mathify(esc(String(tex || "")
  .replace(/\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)/g, (_, a, b) => `$${(a ?? b).replace(/\\\\/g, "$, $")}$`)
  .replace(/\$([^$]*)\$/g, (x, m) => "$" + m.replace(/\s*\\\\\s*/g, "$, $") + "$")
  .replace(/\\(item|begin|end)\{?[a-z*]*\}?/g, " ").replace(/\s+/g, " ").trim().slice(0, n)));

const lastUsed = (p) => (p.usedOn?.length ? p.usedOn.at(-1) : "");
const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return u; } };
const whereHtml = (src) => (src.url ? `<a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(hostOf(src.url))}</a>` : esc(src.file || ""));

// Columns: label, sort value (ascending), cell html.
const COLS = [
  { key: "problem", label: "Problem", val: (p) => String(p.tex || "").toLowerCase(), cell: (p) => `<div class="ct-tex">${preview(p.tex, 260)}</div>` },
  { key: "answer", label: "Answer", val: (p) => String(p.answer || "").toLowerCase() || "￿", cell: (p) => `<div class="ct-ans">${mathify(esc(String(p.answer || "").slice(0, 120)))}</div>` },
  { key: "units", label: "Units", val: (p) => (p.units || []).slice().sort().join(",") || "￿", cell: (p) => (p.units || []).map((u) => `<b class="tid" title="${esc(S.units.find((x) => x.id === u)?.name || "")}">${esc(u)}</b>`).join(" ") },
  { key: "status", label: "Status", val: (p) => STATUS_ORDER[p.status || "candidate"], cell: (p) => `<span class="st st-${p.status || "candidate"}">${esc(STATUS_LABEL[p.status || "candidate"] || p.status)}</span>` },
  { key: "used", label: "Used", num: true, val: (p) => p.usedOn?.length || 0, cell: (p) => (p.usedOn?.length ? `<span title="${esc(p.usedOn.join(", "))}">${p.usedOn.length}×</span>` : '<span class="muted">—</span>') },
  { key: "last", label: "Last used", val: (p) => lastUsed(p) || "0", cell: (p) => esc(lastUsed(p)) },
  { key: "source", label: "Source", val: (p) => `${p.source?.kind || ""} ${p.source?.file || p.source?.url || ""}`, cell: (p) => `<span class="muted">${esc(SOURCE_LABEL[p.source?.kind] || p.source?.kind || "")}</span> ${whereHtml(p.source || {})}` },
  { key: "date", label: "Source date", val: (p) => p.source?.date || "0", cell: (p) => esc(p.source?.date || "") },
  { key: "cas", label: "CAS", num: true, val: (p) => (p.casVerified ? 1 : 0), cell: (p) => (p.casVerified ? '<span class="ok-text" title="Answer checked with the CAS">✓</span>' : "") },
  { key: "added", label: "Added", val: (p) => String(p.addedAt || ""), cell: (p) => esc(String(p.addedAt || "").slice(0, 10)) },
];
const colOf = (k) => COLS.find((c) => c.key === k);

function sorted(list) {
  const col = colOf(C.sort.key) || colOf("added"), d = C.sort.dir;
  const v = new Map(list.map((p) => [p, col.val(p)]));
  return list.slice().sort((a, b) => { const x = v.get(a), y = v.get(b); return (x < y ? -1 : x > y ? 1 : 0) * d || String(b.addedAt || "").localeCompare(String(a.addedAt || "")); });
}

const actions = (st) => `<button class="ghost star${st === "favorite" ? " on" : ""}" data-set="${st === "favorite" ? "candidate" : "favorite"}" title="Favorite: offered first">★</button><button class="ghost rej${st === "rejected" ? " on" : ""}" data-set="${st === "rejected" ? "candidate" : "rejected"}" title="Reject: never offered again">✕</button>`;

function detailHtml(p) {
  const src = p.source || {};
  const row = (k, v) => (v ? `<div><span class="muted">${k}</span> ${v}</div>` : "");
  return `<div class="ct-detail">
    <div class="ct-full">${preview(p.tex, 4000)}</div>
    ${row("Answer", p.answer && mathify(esc(p.answer)))}
    ${row("Context", p.context && esc(p.context))}
    ${row("Tags", (p.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join(""))}
    ${row("Wu nodes", (p.wuNodes || []).map(esc).join(", "))}
    ${row("Used on", (p.usedOn || []).map(esc).join(", "))}
    ${row("Source", [esc(SOURCE_LABEL[src.kind] || src.kind || ""), whereHtml(src), esc(src.date || ""), esc(src.note || "")].filter(Boolean).join(" · "))}
    ${row("Id", `<code>${esc(p.id)}</code>${p.aliases?.length ? ` <span class="muted small">(also ${p.aliases.map(esc).join(", ")})</span>` : ""}`)}
    ${p.needsRetag ? '<div class="small warn-text">Needs retag: some of its tags were split or retired in a newer version of the course.</div>' : p.taggedIn ? `<div class="muted small">Tagged in v${p.taggedIn}</div>` : ""}
    <details><summary class="muted small">LaTeX</summary><pre>${esc(p.tex)}</pre></details>
  </div>`;
}

function tableHtml(hits) {
  const head = COLS.map((c) => {
    const on = C.sort.key === c.key;
    return `<th data-sort="${c.key}" class="${on ? "on" : ""}${c.num ? " num" : ""}" aria-sort="${on ? (C.sort.dir > 0 ? "ascending" : "descending") : "none"}">${esc(c.label)}<span class="arr">${on ? (C.sort.dir > 0 ? "▲" : "▼") : ""}</span></th>`;
  }).join("");
  const rows = hits.slice(0, C.limit).map((p) => {
    const st = p.status || "candidate", open = C.open.has(p.id);
    return `<tr class="ct-row s-${st}${open ? " open" : ""}" data-id="${p.id}"><td class="ct-act">${actions(st)}</td>${COLS.map((c) => `<td class="c-${c.key}${c.num ? " num" : ""}">${c.cell(p)}</td>`).join("")}</tr>`
      + (open ? `<tr class="ct-drow s-${st}" data-id="${p.id}"><td></td><td colspan="${COLS.length}">${detailHtml(p)}</td></tr>` : "");
  }).join("");
  return `<table class="ct"><thead><tr><th class="ct-act"></th>${head}</tr></thead><tbody>${rows || `<tr><td colspan="${COLS.length + 1}" class="muted">Nothing matches.</td></tr>`}</tbody></table>`;
}

function cardHtml(p) {
  const st = p.status || "candidate";
  const src = p.source || {};
  return `<div class="cp s-${st}" data-id="${p.id}">
    <div class="cp-head">${(p.units || []).map((u) => `<b class="tid">${esc(u)}</b>`).join("")}<span class="muted small">${esc(SOURCE_LABEL[src.kind] || src.kind || "")} · ${whereHtml(src)}${src.date ? " · " + esc(src.date) : ""}</span>
      <span class="spacer"></span>${p.needsRetag ? '<span class="small warn-text" title="Some of its tags were split or retired in a newer version of the course; the tagger will retag it">needs retag</span>' : p.taggedIn ? `<span class="muted small" title="Its tags were made against v${p.taggedIn} and are read forward through the course's lineage">tagged in v${p.taggedIn}</span>` : ""}${p.casVerified ? '<span class="small ok-text" title="Answer checked with the CAS">🧮 verified</span>' : ""}${p.usedOn?.length ? `<span class="muted small" title="${esc(p.usedOn.join(", "))}">used ${p.usedOn.length}×</span>` : ""}
      ${actions(st)}</div>
    <div class="cp-tex">${preview(p.tex)}</div>
    ${p.answer ? `<div class="cp-ans muted small">Answer: ${mathify(esc(String(p.answer).slice(0, 160)))}</div>` : ""}
    ${p.tags?.length ? `<div class="cp-tags">${p.tags.slice(0, 8).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
  </div>`;
}

function shell() {
  const d = $("#p-corpus");
  if ($(".cp-wrap", d)) return;
  d.innerHTML = `<div class="cp-wrap"><div class="cp-main"></div>
    <aside class="cp-chat" ${localStorage.getItem("corpusChatOpen") === "1" ? "" : "hidden"}>
      <div class="cc-head"><b>Ask about the corpus</b><span class="spacer"></span><button class="ghost small" data-cc="new" title="Start over">New chat</button><button class="ghost" data-cc="close" title="Close">✕</button></div>
      <div class="cc-log"></div>
      <form class="cc-form"><textarea id="cc-input" rows="3" placeholder="e.g. Which U14 problems haven't been used yet? Do we have word problems about mixtures?"></textarea>
        <div class="row"><span class="muted small">Claude reads the whole corpus; it can't change it. Enter sends.</span><span class="spacer"></span><button type="submit" class="primary small">Ask</button></div></form>
    </aside></div>`;
  drawChat();
}

function draw() {
  shell();
  const d = $("#p-corpus .cp-main");
  if (!C.items) { d.innerHTML = `<p class="muted">Loading…</p>`; return; }
  const hits = sorted(C.items.filter(matches));
  const counts = {}; for (const p of C.items) counts[p.status || "candidate"] = (counts[p.status || "candidate"] || 0) + 1;
  const units = [...new Set(C.items.flatMap((p) => p.units || []))].sort();
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(label)}</option>`;
  const focused = document.activeElement?.id === "corpus-q";
  const scroll = d.scrollTop;
  const chatOpen = !$("#p-corpus .cp-chat").hidden;
  d.innerHTML = `<div class="row page-head"><h2>Problem corpus</h2><span class="muted">${C.items.length} problems · ${counts.favorite || 0} favorite · ${counts.used || 0} used · ${counts.rejected || 0} rejected</span>
      <span class="spacer"></span><span class="seg"><button class="${C.view === "table" ? "on" : ""}" data-view="table">Table</button><button class="${C.view === "cards" ? "on" : ""}" data-view="cards">Cards</button></span>
      ${chatOpen ? "" : '<button class="secondary" data-cc="open">💬 Ask Claude</button>'}</div>
    <p class="hint">Claude starts each week from the best matches here and saves the problems it writes back at the end. ★ moves a problem up the list; ✕ keeps it out. Click a row to see the whole problem; click a column to sort.</p>
    <div class="row corpus-filters">
      <input id="corpus-q" type="search" placeholder="Search text, answers, tags, ids…" value="${esc(C.q)}" />
      <select data-f="unit">${opt("", "All units", C.unit)}${units.map((u) => opt(u, `${u} ${S.units.find((x) => x.id === u)?.name || ""}`, C.unit)).join("")}</select>
      <select data-f="status">${opt("", "Any status", C.status)}${Object.entries(STATUS_LABEL).map(([k, v]) => opt(k, `${v} (${counts[k] || 0})`, C.status)).join("")}</select>
      <select data-f="source">${opt("", "Any source", C.source)}${Object.entries(SOURCE_LABEL).map(([k, v]) => opt(k, v, C.source)).join("")}</select>
      ${C.ids ? `<span class="ids-chip">${esc(C.idsLabel || `${C.ids.length} from the chat`)} <button class="ghost" data-clear-ids title="Show everything again">✕</button></span>` : ""}
      <span class="muted small">${hits.length} shown</span>
    </div>
    ${C.view === "cards" ? `<div class="cp-list">${hits.slice(0, C.limit).map(cardHtml).join("") || '<p class="muted">Nothing matches.</p>'}</div>` : tableHtml(hits)}
    ${hits.length > C.limit ? `<div class="more-row"><button class="secondary more" data-more>Show more (${hits.length - C.limit} left)</button></div>` : ""}`;
  d.scrollTop = scroll;
  if (focused) { const q = $("#corpus-q"); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}

// Shows these problems in the table (and opens a single one).
function showIds(ids, label) {
  C.ids = ids; C.idsLabel = label; C.limit = Math.max(PAGE, ids.length); C.q = ""; C.unit = C.status = C.source = "";
  if (ids.length === 1) C.open.add(ids[0]);
  log("corpus-show", { n: ids.length });
  draw();
  $("#p-corpus .cp-main").scrollTop = 0;
}

// ---------- chat ----------

const CH = { turns: JSON.parse(sessionStorage.getItem("corpusChat") || "[]"), busy: false };
const saveChat = () => sessionStorage.setItem("corpusChat", JSON.stringify(CH.turns));
const linkIds = (h) => h.replace(/\[?\b(p[0-9a-f]{10})\b\]?/g, (_, id) => `<a href="#" class="pid" data-pid="${id}">${id}</a>`);

function drawChat() {
  const el = $("#p-corpus .cc-log");
  if (!el) return;
  el.innerHTML = (CH.turns.length ? "" : `<p class="muted small">Ask anything about the problems here: what a unit is missing, which problems are near-duplicates, what's never been used, where the web problems came from. Ids in the reply link to the table.</p>`)
    + CH.turns.map((t, i) => t.role === "user" ? `<div class="cc-msg me">${esc(t.text)}</div>`
      : `<div class="cc-msg ai${t.error ? " err" : ""}"><div class="md">${linkIds(md(t.text || ""))}</div>${t.error ? `<div class="small warn-text">${esc(t.error)}</div>` : ""}
        <div class="cc-foot">${t.ids?.length > 1 ? `<button class="ghost small" data-show="${i}">Show these ${t.ids.length} in the table</button>` : ""}<span class="spacer"></span>${t.costUSD != null ? `<span class="muted small">$${t.costUSD.toFixed(3)}</span>` : ""}</div></div>`).join("")
    + (CH.busy ? `<div class="cc-msg ai pending muted">Reading the corpus…</div>` : "");
  el.scrollTop = el.scrollHeight;
  const b = $("#p-corpus .cc-form button[type=submit]"); if (b) b.disabled = CH.busy;
}

async function ask(text) {
  text = text.trim();
  if (!text || CH.busy) return;
  CH.turns.push({ role: "user", text }); CH.busy = true; saveChat(); drawChat();
  log("corpus-chat", { chars: text.length });
  try {
    const r = await api("/api/corpus/chat", { method: "POST", body: { messages: CH.turns.filter((t) => t.text).map(({ role, text }) => ({ role, text })) } });
    CH.turns.push({ role: "assistant", text: r.text, ids: r.ids, costUSD: r.costUSD, error: r.error });
  } catch (e) {
    CH.turns.push({ role: "assistant", text: "", error: e.message });
  }
  CH.busy = false; saveChat(); drawChat();
}

function setChatOpen(open) {
  shell();
  $("#p-corpus .cp-chat").hidden = !open;
  localStorage.setItem("corpusChatOpen", open ? "1" : "0");
  draw();
  if (open) $("#cc-input")?.focus();
}

export async function openCorpus() {
  draw();
  C.items = await api("/api/corpus").then((r) => r.items);
  draw();
}

{
  const d = $("#p-corpus");
  let t = null;
  d.addEventListener("input", (e) => { if (e.target.id === "corpus-q") { C.q = e.target.value; C.limit = PAGE; clearTimeout(t); t = setTimeout(draw, 150); } });
  d.addEventListener("change", (e) => { const f = e.target.dataset.f; if (f) { C[f] = e.target.value; C.limit = PAGE; draw(); } });
  d.addEventListener("keydown", (e) => { if (e.target.id === "cc-input" && e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); const v = e.target.value; e.target.value = ""; ask(v); } });
  d.addEventListener("submit", (e) => { if (e.target.closest(".cc-form")) { e.preventDefault(); const i = $("#cc-input"); const v = i.value; i.value = ""; ask(v); } });
  d.addEventListener("click", async (e) => {
    const cc = e.target.closest("[data-cc]")?.dataset.cc;
    if (cc === "open") return setChatOpen(true);
    if (cc === "close") return setChatOpen(false);
    if (cc === "new") { if (CH.busy) return; CH.turns = []; saveChat(); return drawChat(); }
    const pid = e.target.closest("[data-pid]");
    if (pid) { e.preventDefault(); if (!C.items?.some((p) => p.id === pid.dataset.pid)) return; return showIds([pid.dataset.pid], pid.dataset.pid); }
    const sh = e.target.closest("[data-show]");
    if (sh) { const tn = CH.turns[+sh.dataset.show]; return showIds(tn.ids, `${tn.ids.length} from the chat`); }
    if (e.target.closest("[data-clear-ids]")) { C.ids = null; C.limit = PAGE; return draw(); }
    if (e.target.closest("[data-more]")) { C.limit += PAGE; return draw(); }
    const v = e.target.closest("[data-view]");
    if (v) { C.view = v.dataset.view; localStorage.setItem("corpusView", C.view); return draw(); }
    const th = e.target.closest("th[data-sort]");
    if (th) {
      const k = th.dataset.sort;
      // Dates and counts start newest/most first; text columns start A→Z.
      C.sort = C.sort.key === k ? { key: k, dir: -C.sort.dir } : { key: k, dir: ["used", "last", "date", "cas", "added"].includes(k) ? -1 : 1 };
      return draw();
    }
    const b = e.target.closest("[data-set]");
    if (b) {
      const id = b.closest("[data-id]").dataset.id, status = b.dataset.set;
      const p = C.items.find((x) => x.id === id);
      const was = p.status; p.status = status; draw();
      try { await api(`/api/corpus/${id}`, { method: "PATCH", body: { status } }); }
      catch (err) { p.status = was; draw(); alert(err.message); }
      return;
    }
    const row = e.target.closest("tr.ct-row");
    if (row && !e.target.closest("a, button") && !getSelection().toString()) {
      const id = row.dataset.id;
      C.open.has(id) ? C.open.delete(id) : C.open.add(id);
      draw();
    }
  });
}
export const corpusState = C;
