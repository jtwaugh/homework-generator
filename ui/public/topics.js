// Topic chips with autocomplete. Chips serialize into the weekly_status "Topics:" field as "; "-joined text,
// so the file stays human-readable. A chip tied to a ladder unit or Wu node keeps its id as "Name (U14)",
// which the server's corpus preload already recognises.
// The pure functions (parse/serialize/rank) are exported for ui/scripts/test.mjs and touch no DOM.

const ID_RE = /\s*\(((?:U\d\d|M\d|F\d)|(?:m:)?e\d+)\)\s*$/;

export function parseTopics(text) {
  const s = String(text || "").trim();
  if (!s) return [];
  // "; " is the chip format. Older free text used commas or new lines: split those at the top level.
  const parts = /;/.test(s) ? s.split(/\s*;\s*|\n+/) : splitTopComma(s);
  return parts.map((p) => p.trim()).filter(Boolean).map((p) => {
    const m = p.match(ID_RE);
    return m ? { text: p.slice(0, m.index).trim(), id: m[1] } : { text: p, id: null };
  });
}
function splitTopComma(s) {
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++; else if (ch === ")") depth = Math.max(0, depth - 1);
    if ((ch === "," || ch === "\n") && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}
// Topics in a "Recent history" line ("11/14: graphing systems, mixed review (completing the square, rational
// equations)"): the date is dropped and a parenthesised list counts as its own topics, so no fragment keeps a stray "(" or ")".
export function historyTopics(line) {
  const s = String(line || "").replace(/^[^:]*:\s*/, "");
  const inner = [...s.matchAll(/\(([^()]*)\)/g)].map((m) => m[1]);
  const outer = s.replace(/\([^()]*\)/g, "");
  return [outer, ...inner].flatMap((x) => x.split(/[;,]/)).map((x) => x.replace(/[()]/g, "").trim()).filter((x) => x.length > 2 && x.length < 60);
}
export const serializeTopics = (chips) => chips.map((c) => (c.id ? `${c.text} (${c.id})` : c.text)).join("; ");

// Suggestion sources, best group first: current/ready units, other units, Wu node titles, recent history, corpus tags.
export function buildSources({ units = [], current = [], ready = [], dagNodes = [], history = [], tags = [] }) {
  const out = [], seen = new Set();
  const add = (text, id, group, hint) => {
    const k = (id || "") + "|" + text.toLowerCase();
    if (!text || seen.has(k)) return;
    seen.add(k); out.push({ text, id, group, hint });
  };
  const first = new Set([...current, ...ready]);
  for (const u of units) if (first.has(u.id)) add(u.name, u.id, 0, current.includes(u.id) ? "current" : "ready");
  for (const u of units) if (!first.has(u.id)) add(u.name, u.id, 1, "unit");
  for (const n of dagNodes) if (n.kind !== "word-problem") add(n.title.replace(/^Pre-Algebra:\s*/, ""), n.id, 2, n.board === "methods" ? "method" : "Wu");
  for (const h of history) add(h, null, 3, "recent");
  for (const t of tags) add(t, null, 4, "tag");
  return out;
}

export function rankSuggestions(query, sources, chosen = [], limit = 8) {
  const q = query.trim().toLowerCase();
  const taken = new Set(chosen.map((c) => (c.id || "") + "|" + c.text.toLowerCase()));
  const res = [];
  for (const s of sources) {
    if (taken.has((s.id || "") + "|" + s.text.toLowerCase()) || (s.id && chosen.some((c) => c.id === s.id))) continue;
    const t = s.text.toLowerCase();
    let m;
    if (!q) m = s.group <= 0 ? 0 : -1;
    else if (s.id && s.id.toLowerCase() === q) m = 0;
    else if (t.startsWith(q)) m = 1;
    else if (t.split(/[^a-z0-9]+/).some((w) => w.startsWith(q))) m = 2;
    else if (t.includes(q)) m = 3;
    else if (q.split(/\s+/).every((w) => t.includes(w))) m = 4;
    else m = -1;
    if (m >= 0) res.push({ ...s, score: m * 10 + s.group });
  }
  return res.sort((a, b) => a.score - b.score || a.text.length - b.text.length).slice(0, limit);
}

// ---------- the widget (browser only) ----------

export function mountTopics(root, { get, set, sources }) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  root.classList.add("topics");
  root.innerHTML = `<div class="tchips"></div><input class="tinput" placeholder="Add a topic… (unit, Wu node, anything)" autocomplete="off" aria-label="Topics" /><ul class="tsugg" hidden role="listbox"></ul>`;
  const box = root.querySelector(".tchips"), input = root.querySelector(".tinput"), list = root.querySelector(".tsugg");
  let chips = parseTopics(get()), sel = 0, sugg = [], drag = null, lastText = get();

  const commit = (next) => { chips = next; lastText = serializeTopics(chips); set(lastText); draw(); };
  const draw = () => {
    box.innerHTML = chips.map((c, i) => `<span class="tchip${c.id ? " has-id" : ""}" draggable="true" data-i="${i}">${c.id ? `<b class="tid">${esc(c.id)}</b>` : ""}${esc(c.text)}<button class="tx" data-x="${i}" title="Remove" tabindex="-1">✕</button></span>`).join("");
    input.placeholder = chips.length ? "Add another…" : "Add a topic… (unit, Wu node, anything)";
  };
  const showSugg = () => {
    sugg = rankSuggestions(input.value, sources(), chips);
    const raw = input.value.trim();
    const exact = sugg.some((s) => s.text.toLowerCase() === raw.toLowerCase());
    list.innerHTML = sugg.map((s, i) => `<li role="option" data-i="${i}" class="${i === sel ? "on" : ""}">${s.id ? `<b class="tid">${esc(s.id)}</b>` : ""}<span>${esc(s.text)}</span><small>${esc(s.hint)}</small></li>`).join("")
      + (raw && !exact ? `<li class="new${sel === sugg.length ? " on" : ""}" data-i="${sugg.length}">＋ Add “${esc(raw)}”</li>` : "");
    list.hidden = document.activeElement !== input || !list.innerHTML;
  };
  const accept = (i) => {
    const raw = input.value.trim();
    const s = sugg[i];
    if (s) commit([...chips, { text: s.text, id: s.id || null }]);
    else if (raw) commit([...chips, ...parseTopics(raw.replace(/,\s*$/, ""))]);
    else return false;
    input.value = ""; sel = 0; showSugg();
    return true;
  };

  input.addEventListener("input", () => {
    if (input.value.endsWith(",") || input.value.endsWith(";")) { input.value = input.value.slice(0, -1); sel = sugg.length + 1; accept(-1); return; }
    sel = 0; showSugg();
  });
  input.addEventListener("focus", showSugg);
  input.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 150));
  input.addEventListener("keydown", (e) => {
    const n = list.querySelectorAll("li").length;
    if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(n - 1, sel + 1); showSugg(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); showSugg(); }
    else if (e.key === "Enter" || (e.key === "Tab" && input.value.trim())) {
      // Enter on text with no suggestion picked creates a new chip
      if (accept(list.hidden ? -1 : sel)) e.preventDefault();
    }
    else if (e.key === "Backspace" && !input.value && chips.length) commit(chips.slice(0, -1));
    else if (e.key === "Escape") list.hidden = true;
  });
  list.addEventListener("mousedown", (e) => { const li = e.target.closest("li"); if (li) { e.preventDefault(); accept(+li.dataset.i); } });
  box.addEventListener("click", (e) => { const x = e.target.closest("[data-x]"); if (x) commit(chips.filter((_, i) => i !== +x.dataset.x)); else input.focus(); });
  root.addEventListener("click", (e) => { if (e.target === root) input.focus(); });
  // drag to reorder
  box.addEventListener("dragstart", (e) => { const c = e.target.closest(".tchip"); if (c) { drag = +c.dataset.i; e.dataTransfer.effectAllowed = "move"; c.classList.add("dragging"); } });
  box.addEventListener("dragover", (e) => { if (drag != null) e.preventDefault(); });
  box.addEventListener("drop", (e) => {
    e.preventDefault();
    const c = e.target.closest(".tchip"); if (drag == null || !c) return;
    const to = +c.dataset.i, next = [...chips], [moved] = next.splice(drag, 1);
    next.splice(to, 0, moved); drag = null; commit(next);
  });
  box.addEventListener("dragend", () => { drag = null; draw(); });

  draw();
  return {
    // re-read from the status file when it changed outside the widget (raw MD edit, reload)
    sync() { const t = get(); if (t !== lastText) { lastText = t; chips = parseTopics(t); draw(); } },
    get chips() { return chips; },
    input,
  };
}
