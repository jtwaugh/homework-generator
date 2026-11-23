// Right pane: only the current deliverable and its one primary button (setup → outline → final → done),
// plus the header (progress strip, Next pill) that summarises where the week is.
import { $, $$, esc, api, md, S, log, nextSetDate, STATUSES, parseUnitStatuses, writeUnitStatuses, sectionBounds, parseWeekInput, writeWeekInput, diffHtml } from "./lib.js";
import { app, onRender, render, refresh, send, phaseOf, splitMessages, isCheckpoint, hasTex, currentFinal, compile, compiled, problemsOf, fnameFromDate, updateStatus, flushStatus, casCalls, openWeek, newWeek } from "./state.js";
import { mountTopics, buildSources, historyTopics, serializeTopics, parseTopics } from "./topics.js";
import { composerText, clearComposer } from "./chat.js";

// ======================= status-file helpers =======================

export function sectionItems(mdText, heading) {
  const b = sectionBounds(mdText, heading);
  if (!b) return [];
  return b.lines.slice(b.start + 1, b.end)
    .map((l) => l.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/)?.[1]?.trim())
    .filter((x) => x && !/^\(.*\)$/.test(x)); // skip "(add items as needed)" placeholders
}
const statusOf = (map, id) => map[id]?.status || "FUTURE";
const LABEL = { TAUGHT: "Taught", CURRENT: "Current", NEXT: "Next", FUTURE: "Future" };

// ---- units widget: collapsed to the one weekly decision ("did we move on?") ----
export const unitsUI = { expanded: false, choosing: false, undo: null };

export function unitsModel(mdText) {
  const { map, free } = parseUnitStatuses(mdText);
  const st = (id) => statusOf(map, id);
  const ok = (id) => ["TAUGHT", "CURRENT"].includes(st(id));
  const current = S.units.filter((u) => st(u.id) === "CURRENT");
  const partial = S.units.filter((u) => st(u.id) === "TAUGHT" && map[u.id]?.note);
  // Ready: not started, every prerequisite taught. A partial prerequisite still counts but is flagged.
  const ready = S.units.filter((u) => !ok(u.id) && u.needs.every(ok)).map((u) => ({ ...u, shaky: u.needs.filter((n) => map[n]?.note) }));
  const taught = S.units.filter((u) => st(u.id) === "TAUGHT").length;
  return { map, free, st, current, partial, ready, taught };
}

function unitsWidgetHtml(mdText) {
  const m = unitsModel(mdText);
  const cur = m.current;
  const pct = S.units.length ? Math.round((m.taught / S.units.length) * 100) : 0;
  const head = `
    <div class="u-now">
      <div><div class="k">Teaching now</div>
        <div class="u-title">${cur.length ? cur.map((u) => `<b>${u.id}</b> ${esc(u.name)}`).join(" · ") : '<span class="bad-text">No unit marked current</span>'}</div></div>
      <span class="spacer"></span>
      <div class="u-progress" title="${m.taught} of ${S.units.length} units taught"><div style="width:${pct}%"></div></div>
      <span class="muted small">${m.taught}/${S.units.length} taught</span>
      <button class="link" data-act="expand">${unitsUI.expanded ? "hide units" : "all units"}</button>
    </div>`;
  let decision;
  if (unitsUI.choosing) {
    const opts = [
      ...m.partial.map((u) => `<span class="opt-wrap"><button class="opt" data-act="finish" data-id="${u.id}"><b>Finish ${u.id}</b> ${esc(u.name)}<small>${esc(m.map[u.id].note.replace(/^\(|\)$/g, ""))}</small></button>${quickBtn(u.id)}</span>`),
      ...[...m.ready].sort((x, y) => (x.shaky.length > 0) - (y.shaky.length > 0)).map((u) => `<span class="opt-wrap"><button class="opt${u.shaky.length ? " shaky" : ""}" data-act="start" data-id="${u.id}"><b>${u.id}</b> ${esc(u.name)}${u.shaky.length ? `<small class="warn-text">⚠ not ready: needs the rest of ${u.shaky.join(", ")}</small>` : ""}</button>${quickBtn(u.id)}</span>`),
    ];
    decision = `<div class="u-choose">
      <div class="k">${cur.length ? `${cur.map((u) => u.id).join(", ")} will be marked taught. Now teaching:` : "Now teaching:"}</div>
      <div class="opts">${opts.join("") || '<span class="muted">Nothing is unlocked yet. Use all units.</span>'}</div>
      <button class="link" data-act="cancel">cancel</button></div>`;
  } else if (unitsUI.undo) {
    decision = `<div class="u-decide"><span class="ok-text">✓ ${esc(unitsUI.undo.label)}</span><span class="spacer"></span><button class="link" data-act="undo">undo</button></div>`;
  } else {
    decision = `<div class="u-decide"><span class="muted">${cur.length ? `Still teaching ${cur.length > 1 ? "these" : "this"}? Nothing to change. Finished one?` : `Pick the unit ${S.student || "the student"} is on.`}</span>
      <button class="secondary" data-act="choose">${cur.length ? "We moved on →" : "Choose unit →"}</button></div>`;
  }
  const all = unitsUI.expanded ? `
    <div class="chips">${S.units.map((u) => {
      const s = m.st(u.id), note = m.map[u.id]?.note || "";
      const missing = ["TAUGHT", "CURRENT"].includes(s) ? u.needs.filter((n) => !["TAUGHT", "CURRENT"].includes(m.st(n))) : [];
      const tip = `${u.id} ${u.name}: ${LABEL[s]}${note ? " " + note : ""}${u.needs.length ? `\nNeeds ${u.needs.join(", ")}` : ""}${missing.length ? `\n⚠ ${missing.join(", ")} not taught yet` : ""}`;
      return `<span class="chip s-${s}${note ? " partial" : ""}${missing.length ? " warn" : ""}" title="${esc(tip)}">${u.id}<select data-unit="${u.id}" aria-label="${esc(u.id + " " + u.name)}">${STATUSES.map((x) => `<option value="${x}" ${x === s ? "selected" : ""}>${LABEL[x]}</option>`).join("")}</select></span>`;
    }).join("")}</div>
    <div class="legend"><span class="chip s-TAUGHT mini"></span>Taught <span class="chip s-TAUGHT partial mini"></span>Partly <span class="chip s-CURRENT mini"></span>Current <span class="chip s-NEXT mini"></span>Next <span class="chip s-FUTURE mini"></span>Future <span class="muted">· click a unit to change it, hover for details</span></div>` : "";
  return head + decision + all;
}

const quickBtn = (id) => `<button class="link quick" data-act="quick" data-id="${id}" title="Start ${id} and have Claude write the whole set in one pass">Make a set →</button>`;

// Mark a unit current; whatever was current becomes taught (the "we moved on" decision).
function startUnit(mdText, id) {
  const m = unitsModel(mdText), map = { ...m.map };
  for (const u of m.current) if (u.id !== id) map[u.id] = { status: "TAUGHT", note: map[u.id]?.note || "" };
  map[id] = { status: "CURRENT", note: "" };
  return writeUnitStatuses(mdText, map, m.free);
}


// One click: this unit, the next date, everything else as last week, and Claude writes the final in one pass.
export async function quickSet(id) {
  const u = S.units.find((x) => x.id === id); if (!u) return;
  let mdText = unitsModel(S.status).st(id) === "CURRENT" ? S.status : startUnit(S.status, id);
  const vals = parseWeekInput(mdText);
  vals["Date (for title)"] = nextSetDate(S.texFiles, vals["Date (for title)"]);
  vals["Topics"] = serializeTopics([{ text: u.name, id }]);
  mdText = writeWeekInput(mdText, vals);
  Object.assign(unitsUI, { choosing: false, undo: null });
  updateStatus(mdText);
  log("quick-set", { unit: id, date: vals["Date (for title)"] });
  await startWeek(QUICK_PROMPT);
}
const QUICK_PROMPT = "This is a quick set: the teacher picked the unit and wants the finished set in one pass. " +
  "Don't ask questions and don't send a checkpoint. Treat the unit statuses in the brief as correct for this week. Wherever you would ask, use your default and say so. " +
  "Do the research, then reply directly with the final: the complete .tex, the problem manifest and the status-update block. " +
  "Start the reply with a short **Judgment calls** list of every default or assumption you made, so the teacher can correct any of them in one message.";

function applyUnitAction(act, id) {
  if (act === "quick") return quickSet(id);
  const m = unitsModel(S.status);
  if (act === "choose") unitsUI.choosing = true;
  else if (act === "cancel") unitsUI.choosing = false;
  else if (act === "expand") unitsUI.expanded = !unitsUI.expanded;
  else if (act === "undo") { const prev = unitsUI.undo.prev; unitsUI.undo = null; return updateStatus(prev); }
  else if (act === "start" || act === "finish") {
    const prev = S.status, map = { ...m.map };
    for (const u of m.current) map[u.id] = { status: "TAUGHT", note: map[u.id]?.note || "" };
    map[id] = { status: "CURRENT", note: "" };
    Object.assign(unitsUI, { choosing: false, undo: { prev, label: `${m.current.map((u) => u.id).join(", ") || "Nothing"} → taught, now teaching ${id}` } });
    return updateStatus(writeUnitStatuses(S.status, map, m.free));
  }
  render();
}

const ctxUI = { more: false };
function contextHtml(mdText) {
  const review = sectionItems(mdText, "## Review priority");
  const history = sectionItems(mdText, "## Recent history");
  const bans = sectionItems(mdText, "## Extra bans this week").filter((b) => !/^\(?none\)?$/i.test(b));
  if (!review.length && !bans.length && !history.length) return `<p class="muted small">Nothing carried over yet.</p>`;
  return `
    ${review.length ? `<div class="cur-line"><span class="k">Review</span><div><div class="cap">The mixed-review section draws from these, in order.</div><ol class="review-list">${review.map((r) => `<li title="${esc(r)}">${esc(r.replace(/\s*\(.*$/, ""))}</li>`).join("")}</ol></div></div>` : ""}
    ${bans.length ? `<div class="cur-line"><span class="k">Avoid</span><div><div class="cap">Extra bans for this week.</div>${bans.map(esc).join("; ")}</div></div>` : ""}
    ${history.length ? `<div class="cur-line"><span class="k">Last set</span><div><div class="clamp${ctxUI.more ? " open" : ""}">${esc(history[history.length - 1])}</div><button class="link" data-act="more">${ctxUI.more ? "less" : "more"}</button></div></div>` : ""}`;
}

export function statusChanges(oldMd, newMd) {
  const out = [];
  const a = parseUnitStatuses(oldMd).map, b = parseUnitStatuses(newMd).map;
  for (const u of S.units) {
    const x = statusOf(a, u.id), y = statusOf(b, u.id);
    if (x !== y) out.push({ kind: "unit", html: `<b>${u.id}</b> ${esc(u.name)}: <span class="st s-${x}">${LABEL[x]}</span> → <span class="st s-${y}">${LABEL[y]}</span>` });
    else if ((a[u.id]?.note || "") !== (b[u.id]?.note || "")) out.push({ kind: "unit", html: `<b>${u.id}</b> note: ${esc(b[u.id]?.note || "(removed)")}` });
  }
  const list = (h, label) => {
    const A = sectionItems(oldMd, h), B = sectionItems(newMd, h);
    for (const x of B) if (!A.includes(x)) out.push({ kind: "add", html: `<span class="k">${label}</span> ${esc(x)}` });
    for (const x of A) if (!B.includes(x)) out.push({ kind: "del", html: `<span class="k">${label}</span> ${esc(x)}` });
  };
  list("## Review priority", "Review");
  list("## Extra bans this week", "Ban");
  list("## Defaults for this week", "Default");
  list("## Recent history", "History");
  const wa = parseWeekInput(oldMd), wb = parseWeekInput(newMd);
  if (Object.values(wa).some(Boolean) && !Object.values(wb).some(Boolean)) out.push({ kind: "info", html: "This week's inputs cleared for next time" });
  return out;
}

// ======================= setup =======================

const FIELD_IDS = { "f-date": "Date (for title)", "f-sections": "Number of sections (default 3-4)", "f-ideas": "Example problem ideas (optional)", "f-emph": "Emphasize or avoid", "f-fact": "Fact sheet or other auxiliary file" };
const setField = (key, v) => { const vals = parseWeekInput(S.status); vals[key] = v; updateStatus(writeWeekInput(S.status, vals)); };

for (const [id, key] of Object.entries(FIELD_IDS)) $("#" + id).addEventListener("input", (e) => setField(key, e.target.value));
// Options dropdown: checkboxes, with small sub-menus for the numbers.
const SECTIONS_KEY = "Number of sections (default 3-4)";
const optsMenu = $("#opts-menu"), optsBtn = $("#opts-btn");
const openOpts = (on) => { optsMenu.hidden = !on; optsBtn.setAttribute("aria-expanded", String(on)); if (!on) $$(".dd-item.open", optsMenu).forEach((x) => x.classList.remove("open")); };
optsBtn.addEventListener("click", () => openOpts(optsMenu.hidden));
document.addEventListener("click", (e) => { if (!optsMenu.hidden && !e.target.closest("#opts")) openOpts(false); });
optsMenu.addEventListener("keydown", (e) => { if (e.key === "Escape") { openOpts(false); optsBtn.focus(); } });
optsMenu.addEventListener("change", (e) => {
  const cb = e.target.closest("input[type=checkbox]"); if (!cb) return;
  // Checking means "yes" (Worked examples: Claude picks how many); the sub-menu sets a count.
  setField(cb.dataset.key, cb.checked ? "yes" : "");
});
optsMenu.addEventListener("click", (e) => {
  const item = e.target.closest(".dd-item.has-sub"); if (!item) return;
  const b = e.target.closest(".dd-sub button");
  if (b) return setField(item.dataset.key, b.dataset.v);
  if (e.target.closest(".dd-sub") || e.target.matches("input")) return;
  // Clicking the row itself opens its sub-menu (for touch, where there is no hover).
  const was = item.classList.contains("open");
  $$(".dd-item.open", optsMenu).forEach((x) => x.classList.remove("open"));
  item.classList.toggle("open", !was);
  if (!was) placeSub(item);
});
// Flyouts open to the left when there is no room on the right.
const placeSub = (item) => { item.classList.remove("flip"); const sub = $(".dd-sub", item), r = item.getBoundingClientRect(); item.classList.toggle("flip", r.right + (sub.offsetWidth || 260) > window.innerWidth - 8); };
optsMenu.addEventListener("mouseover", (e) => { const item = e.target.closest(".dd-item.has-sub"); if (item && !item.contains(e.relatedTarget)) placeSub(item); });
optsMenu.addEventListener("focusin", (e) => { const item = e.target.closest(".dd-item.has-sub"); if (item) placeSub(item); });
const yes = (v) => !!v && !/^(no|none|auto)$/i.test(v.trim());
function optsSummary(vals) {
  const n = (vals[SECTIONS_KEY] || "").trim();
  const bits = [/^\d+$/.test(n) ? `${n} sections` : n ? "custom sections" : "3–4 sections"];
  if (yes(vals["Answer key"])) bits.push("answer key");
  const we = (vals["Worked examples"] || "").trim();
  if (yes(we)) bits.push(/^\d+$/.test(we) ? `${we} worked example${we === "1" ? "" : "s"}` : "worked examples");
  if (yes(vals["Unit circle sheet"])) bits.push("unit circle");
  if (/^y/i.test(vals["Graph paper"] || "")) bits.push("graph paper");
  if (yes(vals["Disclaimer"])) bits.push("disclaimer");
  return bits.join(" · ");
}
function renderOpts(vals) {
  $("#opts-sum").textContent = optsSummary(vals);
  for (const cb of $$("input[type=checkbox]", optsMenu)) cb.checked = cb.dataset.key === "Graph paper" ? /^y/i.test(vals["Graph paper"] || "") : yes(vals[cb.dataset.key]);
  for (const item of $$(".dd-item.has-sub", optsMenu)) {
    const v = (vals[item.dataset.key] || "").trim();
    const btns = $$(".dd-sub button", item);
    btns.forEach((b) => b.classList.toggle("on", b.dataset.v === v || (item.dataset.key === SECTIONS_KEY && !b.dataset.v && !v)));
    const on = btns.find((b) => b.classList.contains("on"));
    if (item.dataset.key === SECTIONS_KEY && document.activeElement !== $("#f-sections") && /^\d*$/.test(v)) $("#f-sections").value = "";
    $(".dd-val", item).textContent = item.dataset.key === SECTIONS_KEY ? (on ? on.textContent : v ? "custom" : "") : yes(v) ? (/^\d+$/.test(v) ? v : "auto") : "";
  }
}
$("#ctx").addEventListener("click", (e) => { if (e.target.closest("[data-act=more]")) { ctxUI.more = !ctxUI.more; render(); } });
$("#topic-suggest").addEventListener("click", (e) => {
  const b = e.target.closest("[data-unit]"); if (!b) return;
  const u = S.units.find((x) => x.id === b.dataset.unit); if (!u) return;
  setField("Topics", serializeTopics([...parseTopics(parseWeekInput(S.status)["Topics"] || ""), { text: u.name, id: u.id }]));
});
$("#units").addEventListener("click", (e) => { const b = e.target.closest("[data-act]"); if (b) applyUnitAction(b.dataset.act, b.dataset.id); });
$("#units").addEventListener("change", (e) => {
  const id = e.target.dataset.unit; if (!id) return;
  const { map, free } = parseUnitStatuses(S.status);
  map[id] = { status: e.target.value, note: map[id]?.note || "" };
  updateStatus(writeUnitStatuses(S.status, map, free));
});
$("#status-raw").addEventListener("input", (e) => updateStatus(e.target.value));
$("#view-md").onclick = () => { const r = $("#raw-wrap"); r.hidden = !r.hidden; $("#view-md").textContent = r.hidden ? "Edit status (Markdown)" : "Close editor"; };
$("#more-opts").addEventListener("toggle", (e) => (e.target.dataset.touched = "1"));

// Extra suggestion sources for topic chips, loaded once in the background.
const extra = { dagNodes: [], tags: [] };
export async function loadTopicSources() {
  const [dag, corpus] = await Promise.all([api("/api/dag").catch(() => null), api("/api/corpus").catch(() => ({ items: [] }))]);
  if (dag) extra.dagNodes = [...(dag.content?.nodes || []).filter((n) => n.kind !== "assumed").map((n) => ({ ...n, board: "content" })), ...(dag.methods?.nodes || []).map((n) => ({ ...n, id: "m:" + n.id, board: "methods" }))];
  const count = new Map();
  for (const p of corpus.items) for (const t of p.tags || []) count.set(t, (count.get(t) || 0) + 1);
  extra.tags = [...count].sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, 200);
}
export const topics = mountTopics($("#f-topics"), {
  get: () => parseWeekInput(S.status)["Topics"] || "",
  set: (v) => setField("Topics", v),
  sources: () => {
    const m = S.units?.length ? unitsModel(S.status) : { current: [], ready: [] };
    const history = sectionItems(S.status || "", "## Recent history").flatMap(historyTopics);
    return buildSources({ units: S.units || [], current: m.current.map((u) => u.id), ready: m.ready.map((u) => u.id), dagNodes: extra.dagNodes, history: [...new Set(history)].reverse(), tags: extra.tags });
  },
});

const DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
function setupChecks() {
  const vals = parseWeekInput(S.status || "");
  return [
    { label: "Date", msg: "a date like 11/28/2026", ok: DATE_RE.test(vals["Date (for title)"] || ""), field: "#f-date" },
    { label: "Topics", msg: "topics", ok: !!vals["Topics"], field: "#f-topics .tinput" },
  ];
}
function setupMissing() { return setupChecks().filter((c) => !c.ok).map((c) => c.msg); }

function renderSetup() {
  const vals = parseWeekInput(S.status);
  // Default the date to the week after the last saved set, so it is a real value rather than a placeholder.
  if (!vals["Date (for title)"] && S.texFiles && document.activeElement !== $("#f-date")) return setField("Date (for title)", nextSetDate(S.texFiles, ""));
  for (const [id, key] of Object.entries(FIELD_IDS)) { const f = $("#" + id); if (document.activeElement !== f) f.value = vals[key] || ""; }
  topics.sync();
  renderOpts(vals);
  $("#date-note").textContent = vals["Date (for title)"] && vals["Date (for title)"] === nextSetDate(S.texFiles || [], "") ? "a week after your last set" : "";
  const chosen = new Set(parseTopics(vals["Topics"] || "").map((c) => c.id).filter(Boolean));
  const sugg = (S.units?.length ? unitsModel(S.status).current : []).filter((u) => !chosen.has(u.id));
  $("#topic-suggest").innerHTML = sugg.length ? `<span class="muted small">Teaching now:</span>${sugg.map((u) => `<button class="sugg" data-unit="${u.id}">+ <b>${u.id}</b> ${esc(u.name)}</button>`).join("")}` : "";
  if (["f-ideas", "f-emph", "f-fact"].some((id) => vals[FIELD_IDS[id]]) && !$("#more-opts").dataset.touched) $("#more-opts").open = true;
  if (!($("#units").contains(document.activeElement) && document.activeElement.tagName === "SELECT")) $("#units").innerHTML = unitsWidgetHtml(S.status);
  $("#ctx").innerHTML = contextHtml(S.status);
  if (document.activeElement !== $("#status-raw")) $("#status-raw").value = S.status;
  const checks = setupChecks();
  $("#setup-check").innerHTML = checks.map((c) => `<span class="${c.ok ? "ok" : "todo"}">${c.ok ? "✓" : "○"} ${c.label}</span>`).join("");
  const ready = checks.every((c) => c.ok);
  for (const b of [$("#generate"), $("#quick-set")]) { b.disabled = starting; b.classList.toggle("not-ready", !ready); }
  $("#generate").title = ready ? `Claude researches${S.corpusSize ? ` (starting from the ${S.corpusSize}-problem corpus)` : ""}, then shows you an outline to approve` : `Add ${setupMissing().join(" and ")} first`;
}

// With something missing, the start buttons point at the missing field instead of doing nothing.
function guardSetup() {
  const miss = setupChecks().find((c) => !c.ok);
  if (!miss) return true;
  const f = $(miss.field), box = f.closest(".field") || f;
  f.focus(); box.classList.remove("flash"); void box.offsetWidth; box.classList.add("flash");
  clearTimeout(guardSetup.t); guardSetup.t = setTimeout(() => box.classList.remove("flash"), 1500);
  return false;
}

// starting: a create is in flight, so the start buttons stay disabled through re-renders (no double sessions).
let starting = false;
async function startWeek(instructions, { replace = false } = {}) {
  if (starting) return;
  starting = true; $("#dup-week").hidden = true; render();
  try {
    await flushStatus(true);
    const date = parseWeekInput(S.savedStatus)["Date (for title)"];
    try {
      app.week = await api("/api/weeks", { method: "POST", body: { title: `HW ${date}`, replace } });
    } catch (e) {
      if (e.status === 409) return showDupWeek(e, instructions);
      throw e;
    }
    history.replaceState(null, "", location.pathname);
    // The server appends the brief, rendered from the app's own status record: that is the whole input.
    send("start", "Everything for this week is in the brief below. " + instructions, { overrides: Object.fromEntries([...briefOff].map((k) => [k, false])) });
  } finally { starting = false; render(); }
}

// This date already has an unfinished week: go back to it, or throw it away and start fresh.
function showDupWeek(e, instructions) {
  const el = $("#dup-week"), list = e.data?.existing || [];
  const w = list[0];
  const busy = list.some((x) => x.running);
  log("dup-week", { ids: list.map((x) => x.id), running: busy });
  if (!w) { el.innerHTML = `<span>${esc(e.message)}</span>`; el.hidden = false; return; }
  const when = new Date(w.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const more = list.length > 1 ? ` (and ${list.length - 1} more ${list.length > 2 ? "copies" : "copy"})` : "";
  el.innerHTML = `<span><b>${esc(w.title)}</b> is already in progress: started ${esc(when)}, ${w.turns} message${w.turns === 1 ? "" : "s"}${busy ? ", Claude is working on it now" : ""}${more}.</span>
    <span class="spacer"></span>
    <button class="primary" data-dup="resume">Resume it</button>
    <button class="secondary" data-dup="replace" ${busy ? 'disabled title="Claude is still working on it. Resume it and stop it first"' : `title="Delete ${list.length > 1 ? "them" : "it"} and start this week again"`}>Replace it</button>
    <button class="link" data-dup="cancel">Cancel</button>`;
  el.hidden = false;
  el.querySelector("[data-dup=resume]").onclick = () => { el.hidden = true; log("dup-week-resume", { id: w.id }); openWeek(w.id); };
  el.querySelector("[data-dup=replace]").onclick = () => { log("dup-week-replace", { ids: list.map((x) => x.id) }); startWeek(instructions, { replace: true }); };
  el.querySelector("[data-dup=cancel]").onclick = () => { el.hidden = true; };
}

// ---- brief: what the app settled before calling Claude (promotions, section coverage, which stages run) ----
const briefOff = new Set(); // decision keys the teacher rejected, e.g. "promote:U19"
let briefFor = null, briefData = null, briefTimer = null;
function loadBrief() {
  const sig = S.savedStatus + [...briefOff].join();
  if (briefFor === sig) return;
  briefFor = sig;
  clearTimeout(briefTimer);
  briefTimer = setTimeout(async () => {
    briefData = await api(`/api/brief?off=${encodeURIComponent([...briefOff].join(","))}`).catch(() => null);
    renderBrief();
  }, 400);
}
const COVER = { covered: "✓ corpus", thin: "◐ thin", empty: "○ research" };
function toggleBrief(k) {
  if (briefOff.has(k)) briefOff.delete(k); else briefOff.add(k);
  loadBrief();
}
function renderBrief() {
  const el = $("#brief");
  if (!el) return;
  const b = briefData;
  if (!b || !b.sections?.length) { el.innerHTML = ""; return; }
  const promos = b.promotions.map((p) => `<button class="chip ${p.accepted ? "on" : "off"}" data-key="promote:${esc(p.id)}" title="${esc(p.from)} unit. Click to ${p.accepted ? "keep it out of" : "allow it in"} this week's set">${p.accepted ? "✓" : "✕"} ${esc(p.id)} as CURRENT</button>`).join(" ");
  const secs = b.sections.map((x) => `<span class="chip cov-${esc(x.coverage)}" title="${x.usable} usable corpus problems for about ${x.target}">${esc(x.title)} · ${COVER[x.coverage] || esc(x.coverage)}</span>`).join(" ");
  const plan = (b.stagesPlan || []).map((x) => `${esc(x.stage)}: ${x.skip ? "skipped" : esc((x.model || "").replace(/^claude-/, ""))}`).join(" → ");
  const other = b.decisions.filter((d) => !d.key.startsWith("promote:")).map((d) => `<li>${esc(d.text)}</li>`).join("");
  el.innerHTML = `<div class="small"><b>Decided without asking</b> ${promos || '<span class="muted">nothing to decide</span>'}${other ? `<ul class="muted">${other}</ul>` : ""}</div>
    <div class="small">${secs}</div><div class="small muted">Stages: ${plan}</div>`;
  $$("button[data-key]", el).forEach((btn) => (btn.onclick = () => toggleBrief(btn.dataset.key)));
}
$("#quick-set").onclick = () => { if (guardSetup()) { log("quick-set", { from: "setup" }); startWeek(QUICK_PROMPT); } };
$("#generate").onclick = () => guardSetup() && startWeek("Follow the weekly workflow.");

// ======================= outline =======================

const lastAssistant = (msgs) => [...msgs].reverse().find((m) => m.role === "assistant");

// Looking back at the approved outline from the final step (Outline breadcrumb): read-only, one way back.
function renderOutlinePeek() {
  const el = $("#v-outline");
  const lastA = lastAssistant(splitMessages().outline);
  $(".v-title", el).textContent = "Outline (approved)";
  $(".v-note", el).textContent = "The outline you approved, for reference. Changes now go in the chat.";
  $(".latest", el).innerHTML = lastA ? md(lastA.text) : `<p class="muted">No outline in this week.</p>`;
  $(".latest", el).classList.remove("dim");
  $("#start-over").hidden = true; $(".alt", el).hidden = true;
  const main = $(".main", el); main.hidden = false; main.dataset.act = "back";
  main.textContent = app.week.done ? "Back to saved →" : "Back to final →";
}

function renderOutline(phase) {
  const el = $("#v-outline");
  $("#start-over").hidden = false;
  const { outline } = splitMessages();
  const lastA = lastAssistant(outline);
  const running = phase === "outline-running";
  // A turn that ended on an error (budget, stop, crash) before the checkpoint isn't asking anything.
  const halted = !running && lastA && lastA.error && !isCheckpoint(lastA.text);
  const asking = lastA && !halted && !isCheckpoint(lastA.text);
  const err = !running && (lastA?.error || app.week.sendError || (!lastA && app.week.lastError));
  $(".v-title", el).textContent = !lastA ? "Outline" : halted ? "Claude stopped before the checkpoint" : asking ? "Claude has questions" : "Outline checkpoint";
  $(".v-note", el).innerHTML = running ? `<span class="spin"></span> Claude is ${lastA ? "revising the outline" : "researching and writing the outline"}. Follow along in the chat.`
    : halted ? "Continue picks up where it stopped (re-reading the conversation so far costs extra), or Start over to set the week up again."
    : asking ? "Answer in the chat on the left, or let Claude use its stated defaults."
    : lastA ? "Read it over. Type any changes in the chat, or approve to write the final." : "";
  $(".latest", el).innerHTML = (err ? `<div class="err">Something went wrong: ${esc(err)}</div>` : "") + (lastA ? md(lastA.text) : running || err ? "" : noReply());
  $(".latest", el).classList.toggle("dim", running);

  const main = $(".main", el), alt = $(".alt", el);
  main.hidden = alt.hidden = running;
  if (!lastA) { main.textContent = "Try again"; main.dataset.act = "retry"; alt.hidden = true; }
  else if (halted) { main.textContent = "Continue →"; main.dataset.act = "continue"; alt.hidden = true; }
  else if (asking) { main.textContent = "Use your defaults →"; main.dataset.act = "defaults"; alt.hidden = true; }
  else {
    const t = composerText();
    main.textContent = t ? "Approve with the chat edits →" : "Approve & write final →"; main.dataset.act = "approve";
    alt.hidden = true;
  }
}
$("#v-outline .main").onclick = () => {
  const act = $("#v-outline .main").dataset.act;
  if (act === "back") { app.peek = null; return render(); }
  const { outline } = splitMessages();
  if (act === "retry") { const s = outline.find((m) => m.kind === "start"); app.week.messages = []; return send("start", s.text); }
  const t = composerText(); clearComposer();
  if (act === "continue") return send("revise", (t ? t + "\n\n" : "") + "Continue where you left off: finish the outline and send the checkpoint. Keep any further web research brief.");
  if (act === "defaults") return send("revise", (t ? t + "\n\nFor anything I didn't answer, use" : "Use") + " your stated default choices. Now do the research and send the checkpoint.");
  send("approve", "Approved" + (t ? ", with these edits:\n" + t : ".") + "\nWrite the final .tex, the problem manifest and the status-update block.");
};
$("#composer").addEventListener("input", () => phaseOf() === "outline" && renderOutline("outline"));
$("#start-over").onclick = async () => {
  if (!confirm("Throw away this week's conversation and go back to setup?")) return;
  await api(`/api/weeks/${app.week.id}`, { method: "DELETE" });
  app.week = null; await refresh();
};

// ======================= final =======================

function casRow(f) {
  const calls = casCalls();
  const verified = (f.manifest || []).filter((p) => p.casVerified).length;
  if (calls.length) {
    const failed = calls.filter((c) => c.ok === false).length;
    return `<li class="${failed ? "warn" : "ok"}">CAS ran ${calls.length} time${calls.length > 1 ? "s" : ""}${verified ? `, ${verified} answer${verified > 1 ? "s" : ""} marked verified` : ""}${failed ? ` (${failed} errored)` : ""} <button class="link" data-act="cas-log">view CAS log</button></li>`;
  }
  if (!S.cas) return `<li class="warn">CAS unavailable on this machine, so answers weren't machine-checked <span class="muted small">(see README: sympy venv)</span></li>`;
  return `<li class="warn">CAS never ran on this version <button class="secondary small-btn" data-act="cas-verify">Ask Claude to verify with CAS</button></li>`;
}

function renderFinal(phase) {
  const el = $("#v-final");
  const { final } = splitMessages();
  const lastA = lastAssistant(final);
  const f = currentFinal();
  const running = phase === "final-running";
  const lastUser = [...final].reverse().find((m) => m.role === "user");
  const needsReply = !running && lastA && !hasTex(lastA);
  const what = { fix: "fixing the problems", "revise-final": "making your changes", chat: "making your changes", reply: "working on your reply" }[lastUser?.kind] || "writing the final homework";
  $(".v-note", el).innerHTML = running ? `<span class="spin"></span> Claude is ${what}. Follow along in the chat.` : needsReply ? "Claude replied without a new .tex. Answer it in the chat." : "";
  $(".final-msg", el).hidden = !(needsReply || lastA?.error);
  $(".final-msg", el).innerHTML = (lastA?.error ? `<div class="err">Something went wrong: ${esc(lastA.error)}</div>` : "") + (needsReply ? md(lastA.text) : "");
  const box = $(".final", el);
  box.hidden = !f;
  if (!f) return;
  box.classList.toggle("dim", running);

  const ta = $(".tex", el);
  if (document.activeElement !== ta) ta.value = f.tex;
  const c = compile(f.tex);
  const p = problemsOf(f.tex, c, f.status);

  const checks = [];
  if (c.pending) checks.push(`<li class="pending">Compiling PDF… (first run can take a minute)</li>`);
  else if (!c.ok) checks.push(`<li class="bad">PDF did not compile<details><summary class="muted">view log</summary><pre>${esc((c.log || "").slice(-3000))}</pre></details></li>`);
  else checks.push(`<li class="ok">PDF compiled${c.cached ? ' <span class="muted small">(cached)</span>' : ""}</li>`);
  if (!c.pending && c.ok) checks.push(p.overfull.length ? `<li class="bad">${p.overfull.length} line${p.overfull.length > 1 ? "s" : ""} run past the margin<details><summary class="muted">details</summary><pre>${esc(p.overfull.join("\n"))}</pre></details></li>` : `<li class="ok">Layout fits the page</li>`);
  const bad = p.lint.filter(([k]) => k === "bad"), warn = p.lint.filter(([k]) => k === "warn");
  checks.push(bad.length ? bad.map(([, t]) => `<li class="bad">${esc(t)}</li>`).join("") : `<li class="ok">No banned words, decimals, or untaught topics</li>`);
  checks.push(casRow(f));
  if (f.manifest) {
    const src = { corpus: 0, web: 0, new: 0 };
    for (const x of f.manifest) src[/^corpus:/.test(x.source) ? "corpus" : /^web:/.test(x.source) ? "web" : "new"]++;
    checks.push(`<li class="info">${f.manifest.length} problems: ${src.corpus} from the corpus, ${src.web} from the web, ${src.new} new <span class="muted small">· saved to the corpus on finish</span></li>`);
  }
  checks.push(warn.map(([, t]) => `<li class="warn">${esc(t)}</li>`).join(""));
  $(".checks", el).innerHTML = checks.join("");

  const pdf = $(".pdf", el);
  if (c.pdf && pdf.dataset.src !== c.pdf) { pdf.innerHTML = `<iframe src="${c.pdf}#view=FitH"></iframe>`; pdf.dataset.src = c.pdf; }
  if (!c.pdf && !c.pending) { pdf.innerHTML = ""; pdf.dataset.src = ""; }

  const fname = $(".fname", el);
  if (!fname.value || fname.dataset.week !== app.week.id) { fname.value = fnameFromDate(); fname.dataset.week = app.week.id; }

  const so = $(".status-opt", el), sv = $(".status-view", el);
  so.hidden = sv.hidden = !f.status;
  if (f.status) {
    const ch = statusChanges(S.savedStatus, f.status);
    $(".status-summary", el).innerHTML = ch.length ? ch.map((x) => `<li class="c-${x.kind}">${x.html}</li>`).join("") : `<li class="c-info">No changes to the status</li>`;
    $(".diff", el).innerHTML = diffHtml(S.savedStatus, f.status);
  }

  const main = $(".savebar .main", el), alt = $(".savebar .alt", el);
  const busy = running || c.pending;
  main.disabled = alt.disabled = busy;
  if (p.blocking) { main.textContent = "Ask Claude to fix these →"; main.dataset.act = "fix"; alt.hidden = false; alt.textContent = "Save anyway"; }
  else { main.textContent = "Save & finish ✓"; main.dataset.act = "save"; alt.hidden = true; }
}

{
  const el = $("#v-final");
  $(".tex", el).addEventListener("input", (e) => { const f = currentFinal(); app.texOverride = { src: f.msg.at, text: e.target.value }; });
  $(".recompile", el).onclick = () => { $(".tex", el).blur(); render(); };
  $(".view-status-md", el).onclick = (e) => { const d = $(".diff", el); d.hidden = !d.hidden; e.target.textContent = d.hidden ? "view MD" : "hide MD"; };
  $(".checks", el).addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    if (b.dataset.act === "cas-log") openCasLog();
    if (b.dataset.act === "cas-verify") send("fix", "Before I save: use the cas tool to verify every answer-key entry in the current .tex (substitute each solution back, check for extraneous roots), batching problems into a few calls. Fix any wrong answers, then send the complete .tex, the problem manifest (with casVerified set) and the status-update block again.");
  });
  const save = async () => {
    const f = currentFinal(); const name = $(".fname", el).value.trim();
    const updateStatus = !!f.status && $(".update-status", el).checked;
    try { await api(`/api/weeks/${app.week.id}/finish`, { method: "POST", body: { name, tex: f.tex, updateStatus } }); }
    catch (e) {
      if (e.status !== 409) return alert(e.message);
      if (!confirm(`${name} already exists. Replace it?`)) return;
      await api(`/api/weeks/${app.week.id}/finish`, { method: "POST", body: { name, tex: f.tex, updateStatus, overwrite: true } });
    }
    app.week = await api(`/api/weeks/${app.week.id}`); await refresh(false);
  };
  $(".savebar .main", el).onclick = () => {
    if ($(".savebar .main", el).dataset.act === "save") return save();
    const f = currentFinal(), c = compiled.get(f.tex), p = problemsOf(f.tex, c, f.status);
    const parts = [];
    if (!c.ok) parts.push("It did not compile. End of the log:\n```\n" + (c.log || "").slice(-2500) + "\n```");
    if (p.overfull.length) parts.push("Overfull boxes:\n```\n" + p.overfull.join("\n") + "\n```");
    const bad = p.lint.filter(([k]) => k === "bad");
    if (bad.length) parts.push("Checks against the hard gates flagged:\n" + bad.map(([, t]) => "- " + t).join("\n") + "\n(If a flag is a false positive, say so and leave it.)");
    send("fix", "The app compiled and checked your .tex.\n\n" + parts.join("\n\n") + "\n\nPlease fix these and send the complete corrected .tex, the problem manifest and the status-update block again.");
  };
  $(".savebar .alt", el).onclick = save;
}

// CAS log modal: every cas call for this week (from the MCP tool log, which has full code and output).
async function openCasLog() {
  const d = $("#cas-dlg");
  d.innerHTML = `<div class="row"><h2>CAS log</h2><span class="spacer"></span><form method="dialog"><button class="ghost">✕</button></form></div><p class="muted">Loading…</p>`;
  d.showModal();
  const { calls } = await api(`/api/weeks/${app.week.id}/tools`);
  const cas = calls.filter((c) => c.tool === "cas");
  d.innerHTML = `<div class="row"><h2>CAS log</h2><span class="muted">${cas.length} run${cas.length === 1 ? "" : "s"} · sympy, sandboxed, no network</span><span class="spacer"></span><form method="dialog"><button class="ghost">✕</button></form></div>
    <div class="cas-list">${cas.map((c, i) => `<div class="cas-run ${c.ok ? "" : "bad"}"><div class="k">Run ${i + 1} · ${new Date(c.ts).toLocaleTimeString()} · ${(c.ms / 1000).toFixed(1)}s${c.ok ? "" : " · error"}</div>
      <div class="two"><pre>${esc(c.input?.code || "")}</pre><pre>${esc(c.output || "")}</pre></div></div>`).join("") || '<p class="muted">No CAS runs logged for this week.</p>'}</div>`;
}

// ======================= done =======================

function renderDone() {
  const w = app.week, cs = w.corpusSaved;
  $("#v-done .done-text").innerHTML = `Saved <b>${esc(w.savedAs)}</b> to the project folder${w.statusUpdated ? " and updated the status for next week" : ""}.`
    + (cs && !cs.error ? `<br><span class="muted">${cs.total ? `${cs.added} new problem${cs.added === 1 ? "" : "s"} added to the corpus${cs.merged ? `, ${cs.merged} already there marked used` : ""}.` : "No problem manifest came with the final, so the corpus is unchanged."}</span>` : "")
    + (cs?.error ? `<br><span class="warn-text">Corpus not updated: ${esc(cs.error)}</span>` : "");
}
$("#v-done .next-week").onclick = () => newWeek();

// ======================= header =======================

const STEPS = [["setup", "Setup"], ["outline", "Outline"], ["final", "Final"], ["done", "Saved"]];
function renderHeader(phase) {
  const base = phase.replace("-running", "");
  const idx = STEPS.findIndex(([k]) => k === base);
  const shown = app.peek ? STEPS.findIndex(([k]) => k === app.peek) : idx;
  // Setup always starts a fresh week; Outline looks back from final/saved; the current step returns from a look back.
  const clickable = (k, i) => (k === "setup" && app.week) || (k === "outline" && idx > 1 && i !== shown) || (app.peek && i === idx);
  $("#strip").innerHTML = STEPS.map(([k, label], i) => {
    const cls = i === shown ? "on" : i < idx || base === "done" ? "done" : "";
    const busy = i === idx && phase.endsWith("running") ? " busy" : "";
    return `<li class="${cls}${busy}">${clickable(k, i) ? `<button data-step="${k}" title="${k === "setup" ? "Start a new week (this one stays in History)" : k === "outline" ? "Look back at the approved outline" : "Back to this step"}">${label}</button>` : label}</li>`;
  }).join("");

  const n = $("#next");
  let text = "", cls = "";
  const f = phase === "final" ? currentFinal() : null;
  const c = f && compiled.get(f.tex);
  switch (phase) {
    case "setup": {
      const m = setupMissing(), noClaude = S.auth?.mode === "none";
      text = noClaude ? "No Claude API key: set ANTHROPIC_API_KEY and restart" : !S.tectonic ? "Tectonic missing: brew install tectonic" : m.length ? `Next: add ${m.join(" and ")}` : "Next: Generate outline";
      if (noClaude || !S.tectonic) cls = "bad";
      break;
    }
    case "outline-running": case "final-running": text = "Claude is working"; cls = "wait"; break;
    case "outline": {
      const lastA = lastAssistant(splitMessages().outline);
      text = lastA && !isCheckpoint(lastA.text) ? "Next: answer Claude's questions" : "Next: read the outline, then approve";
      break;
    }
    case "final":
      if (!f) text = "Next: answer Claude in the chat";
      else if (!c || c.pending) { text = "Compiling PDF…"; cls = "wait"; }
      else if (problemsOf(f.tex, c, f.status).blocking) { text = "Next: ask Claude to fix the flagged problems"; cls = "bad"; }
      else text = "Next: look over the PDF, then Save & finish";
      break;
    case "done": text = "Done for this week ✓"; break;
  }
  n.textContent = text; n.className = "next " + cls;
  $("#week-name").textContent = app.week ? app.week.title : "";
  const icon = cls === "wait" ? "⏳ " : app.finishedWhileHidden ? "🟢 " : "";
  document.title = icon + (app.week ? app.week.title + " · " : "") + (S.student ? `${S.student} HW` : S.curriculum || "Homework");
}
$("#strip").addEventListener("click", (e) => {
  const b = e.target.closest("[data-step]"); if (!b) return;
  const k = b.dataset.step;
  log("step-click", { step: k, phase: phaseOf() });
  if (k === "setup") return newWeek();
  app.peek = k === "outline" ? "outline" : null;
  render();
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) { app.finishedWhileHidden = false; render(); } });

// ======================= dispatch =======================

onRender(function renderWork({ phase }) {
  if (!S.ladder) return; // not loaded yet
  const real = phase.replace("-running", "");
  if (app.peek && !["final", "done"].includes(real)) app.peek = null;
  const base = app.peek || real;
  for (const v of ["setup", "outline", "final", "done"]) $("#v-" + v).hidden = v !== base;
  if (base === "setup") renderSetup();
  if (app.peek === "outline") renderOutlinePeek();
  else if (base === "outline") renderOutline(phase);
  if (base === "final") renderFinal(phase);
  if (base === "done") renderDone();
  renderHeader(phase);
});

export { openWeek };

// The turn ended but the page has no reply and no error: say what is known instead of a bare "didn't reply".
function noReply() {
  const sent = [...app.week.messages].reverse().find((m) => m.role === "user");
  const when = sent?.at ? new Date(sent.at).toLocaleTimeString() : "?";
  return `<div class="err">The run ended, but no reply reached this page and no error was recorded (week ${esc(app.week.id)}, sent ${esc(when)}). `
    + `Reload to check again. If it's still missing, the server log for ${esc(app.week.id)} from that time shows what Claude did.</div>`;
}
