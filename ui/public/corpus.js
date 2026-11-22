// Corpus browser: every problem Claude can reuse, with filters by unit, status and source, a search box,
// and ★ (favorite: preferred in the preload) / ✕ (rejected: never offered again).
import { $, esc, api, S, mathify } from "./lib.js";

const C = { items: null, q: "", unit: "", status: "", source: "", limit: 80 };
const STATUS_LABEL = { candidate: "Candidate", used: "Used", favorite: "★ Favorite", rejected: "✕ Rejected" };
const SOURCE_LABEL = { gold: "Gold set", final: "Past homework", web: "Web", teacher: "Teacher" };

function matches(p) {
  if (C.unit && !(p.units || []).includes(C.unit)) return false;
  if (C.status && (p.status || "candidate") !== C.status) return false;
  if (C.source && p.source?.kind !== C.source) return false;
  if (C.q) {
    const hay = [p.tex, p.answer, p.context, ...(p.tags || []), ...(p.units || []), p.source?.file, p.source?.url].join(" ").toLowerCase();
    if (!C.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}

// Display math and alignment breaks become inline $…$ so mathify can render them in a one-line preview.
const preview = (tex) => mathify(esc(String(tex || "")
  .replace(/\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)/g, (_, a, b) => `$${(a ?? b).replace(/\\\\/g, "$, $")}$`)
  .replace(/\$([^$]*)\$/g, (x, m) => "$" + m.replace(/\s*\\\\\s*/g, "$, $") + "$")
  .replace(/\\(item|begin|end)\{?[a-z*]*\}?/g, " ").replace(/\s+/g, " ").trim().slice(0, 420)));

function cardHtml(p) {
  const st = p.status || "candidate";
  const src = p.source || {};
  const where = src.url ? `<a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(new URL(src.url).host.replace(/^www\./, ""))}</a>` : esc(src.file || "");
  return `<div class="cp s-${st}" data-id="${p.id}">
    <div class="cp-head">${(p.units || []).map((u) => `<b class="tid">${esc(u)}</b>`).join("")}<span class="muted small">${esc(SOURCE_LABEL[src.kind] || src.kind || "")} · ${where}${src.date ? " · " + esc(src.date) : ""}</span>
      <span class="spacer"></span>${p.casVerified ? '<span class="small ok-text" title="Answer checked with the CAS">🧮 verified</span>' : ""}${p.usedOn?.length ? `<span class="muted small" title="${esc(p.usedOn.join(", "))}">used ${p.usedOn.length}×</span>` : ""}
      <button class="ghost star${st === "favorite" ? " on" : ""}" data-set="${st === "favorite" ? "candidate" : "favorite"}" title="Favorite: offered first">★</button>
      <button class="ghost rej${st === "rejected" ? " on" : ""}" data-set="${st === "rejected" ? "candidate" : "rejected"}" title="Reject: never offered again">✕</button></div>
    <div class="cp-tex">${preview(p.tex)}</div>
    ${p.answer ? `<div class="cp-ans muted small">Answer: ${mathify(esc(String(p.answer).slice(0, 160)))}</div>` : ""}
    ${p.tags?.length ? `<div class="cp-tags">${p.tags.slice(0, 8).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
  </div>`;
}

function draw() {
  const d = $("#corpus-dlg");
  if (!C.items) { d.innerHTML = `<p class="muted">Loading…</p>`; return; }
  const hits = C.items.filter(matches);
  const counts = {}; for (const p of C.items) counts[p.status || "candidate"] = (counts[p.status || "candidate"] || 0) + 1;
  const units = [...new Set(C.items.flatMap((p) => p.units || []))].sort();
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(label)}</option>`;
  const focused = document.activeElement?.id === "corpus-q";
  d.innerHTML = `<div class="row"><h2>Problem corpus</h2><span class="muted">${C.items.length} problems · ${counts.favorite || 0} favorite · ${counts.used || 0} used · ${counts.rejected || 0} rejected</span><span class="spacer"></span><form method="dialog"><button class="ghost">✕</button></form></div>
    <p class="hint">Claude starts each week from the best matches here and saves the problems it writes back at the end. ★ moves a problem up the list; ✕ keeps it out.</p>
    <div class="row corpus-filters">
      <input id="corpus-q" type="search" placeholder="Search text, answers, tags…" value="${esc(C.q)}" />
      <select data-f="unit">${opt("", "All units", C.unit)}${units.map((u) => opt(u, `${u} ${S.units.find((x) => x.id === u)?.name || ""}`, C.unit)).join("")}</select>
      <select data-f="status">${opt("", "Any status", C.status)}${Object.entries(STATUS_LABEL).map(([k, v]) => opt(k, `${v} (${counts[k] || 0})`, C.status)).join("")}</select>
      <select data-f="source">${opt("", "Any source", C.source)}${Object.entries(SOURCE_LABEL).map(([k, v]) => opt(k, v, C.source)).join("")}</select>
      <span class="muted small">${hits.length} shown</span>
    </div>
    <div class="cp-list">${hits.slice(0, C.limit).map(cardHtml).join("") || '<p class="muted">Nothing matches.</p>'}
      ${hits.length > C.limit ? `<button class="secondary more" data-more>Show more (${hits.length - C.limit} left)</button>` : ""}</div>`;
  if (focused) { const q = $("#corpus-q"); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}

export async function openCorpus() {
  const d = $("#corpus-dlg");
  if (!d.open) d.showModal();
  draw();
  C.items = (await api("/api/corpus")).items.sort((a, b) => String(b.addedAt || "").localeCompare(String(a.addedAt || "")));
  draw();
}

{
  const d = $("#corpus-dlg");
  let t = null;
  d.addEventListener("input", (e) => { if (e.target.id === "corpus-q") { C.q = e.target.value; C.limit = 80; clearTimeout(t); t = setTimeout(draw, 150); } });
  d.addEventListener("change", (e) => { const f = e.target.dataset.f; if (f) { C[f] = e.target.value; C.limit = 80; draw(); } });
  d.addEventListener("click", async (e) => {
    if (e.target.closest("[data-more]")) { C.limit += 120; return draw(); }
    const b = e.target.closest("[data-set]"); if (!b) return;
    const id = b.closest("[data-id]").dataset.id, status = b.dataset.set;
    const p = C.items.find((x) => x.id === id);
    const was = p.status; p.status = status; draw();
    try { await api(`/api/corpus/${id}`, { method: "PATCH", body: { status } }); }
    catch (err) { p.status = was; draw(); alert(err.message); }
  });
}
export const corpusState = C;
