// Entry point: imports every view module (each registers its renderer), wires the header buttons,
// exposes window.__hw for the dev harness, and loads the server state.
import { $, S, parseWeekInput, flushLog } from "./lib.js";
import { app, render, refresh, phaseOf, currentFinal, compiled, problemsOf, casCalls, openWeek } from "./state.js";
import { weekCost, monthCost, openCost } from "./cost.js";
import "./chat.js";
import { unitsModel, unitsUI, topics, loadTopicSources } from "./work.js";
import { openHistory } from "./history.js";
import { openDag, initDag, dagState } from "./dag.js";
import { openCorpus, corpusState } from "./corpus.js";
import { initUiLog, flushPending } from "./uilog.js";

initUiLog();

initDag();
document.addEventListener("click", (e) => {
  const o = e.target.closest("[data-open]"); if (!o) return;
  ({ cost: openCost, history: openHistory, dag: openDag, corpus: openCorpus })[o.dataset.open]?.();
});
// clicking a dialog's backdrop closes it
for (const d of document.querySelectorAll("dialog")) d.addEventListener("mousedown", (e) => { if (e.target === d) d.close(); });

window.__hw = {
  flushLog: () => { flushPending(); return flushLog(); },
  get week() { return app.week; }, S, app, unitsUI, compiled, topics, phaseOf, render, refresh, openWeek,
  summary() {
    const phase = phaseOf();
    const week = app.week;
    const f = ["final", "done"].includes(phase) ? currentFinal() : null;
    const c = f && compiled.get(f.tex);
    const um = S.units?.length ? unitsModel(S.status) : null;
    const wc = weekCost(), mc = monthCost();
    const cas = casCalls();
    return {
      phase,
      week: week && { id: week.id, title: week.title, running: !!week.running, messages: week.messages.map((m) => `${m.role}${m.kind ? ":" + m.kind : ""}${m.error ? " ERROR " + m.error : ""} (${m.text.length} chars${m.tools?.length ? `, ${m.tools.length} tools` : ""})`), live: week.live && { chars: week.live.text.length, tools: week.live.tools.length }, done: !!week.done, savedAs: week.savedAs, sendError: week.sendError, corpusSaved: week.corpusSaved },
      statusDirty: S.status !== S.savedStatus,
      weekInput: S.status ? parseWeekInput(S.status) : null,
      topics: topics.chips,
      units: um && { current: um.current.map((u) => u.id), ready: um.ready.map((u) => u.id), partial: um.partial.map((u) => u.id), taught: um.taught, ui: unitsUI },
      final: f && { texChars: f.tex.length, hasStatus: !!f.status, manifest: f.manifest?.length ?? null, compile: c ? (c.pending ? "pending" : c.ok ? "ok" : "failed") : "not started", problems: c && !c.pending ? problemsOf(f.tex, c, f.status) : null },
      cost: { week: +wc.total.toFixed(4), research: +wc.research.toFixed(4), writing: +wc.writing.toFixed(4), turns: wc.turns, month: +mc.total.toFixed(4), budget: S.budget || null },
      cas: { available: !!S.cas, calls: cas.length, failed: cas.filter((x) => x.ok === false).length },
      corpusSize: S.corpusSize, tectonic: S.tectonic, model: S.model,
      dialogs: [...document.querySelectorAll("dialog[open]")].map((d) => d.id),
      dag: $("#dag-dlg").open ? { board: dagState.board, selected: dagState.sel, side: dagState.side, view: dagState.view && Object.values(dagState.view).map(Math.round).join(" "), notes: dagState.data?.notes?.length ?? null, guessRunning: !!dagState.data?.job?.running } : null,
      corpus: $("#corpus-dlg").open ? { q: corpusState.q, unit: corpusState.unit, status: corpusState.status, source: corpusState.source, shown: document.querySelectorAll("#corpus-dlg .cp").length } : null,
    };
  },
};

refresh().catch((e) => { document.body.insertAdjacentHTML("afterbegin", `<div class="err">Couldn't reach the server: ${e.message}</div>`); });
loadTopicSources().catch(() => {});
