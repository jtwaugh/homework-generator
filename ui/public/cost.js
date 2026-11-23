// Cost: per-turn figures from the CLI's result event (API-equivalent cost on a subscription),
// a research vs writing split (estimated), the header badge and the cost panel.
import { $, esc, S, kindOf } from "./lib.js";
import { app, onRender } from "./state.js";

// $ per million tokens. Cache writes are 1.25x input. Used only when the CLI gave no cost figure.
export const RATES = {
  opus: { in: 4, out: 20, cacheRead: 0.2 },
  sonnet: { in: 2, out: 10, cacheRead: 0.1 },
  haiku: { in: 0.1, out: 0.5, cacheRead: 0.01 },
  fable: { in: 8, out: 40, cacheRead: 0.8 },
};
export const WEB_SEARCH_USD = 0.01;
export const rateFor = (model = "") => RATES[Object.keys(RATES).find((k) => model.includes(k))] || RATES.opus;

export const fmtUSD = (v) => (v == null ? "—" : v > 0 && v < 0.01 ? "<$0.01" : `$${v.toFixed(2)}`);
export const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n || 0));
export const fmtDur = (ms) => { const s = Math.round((ms || 0) / 1000); return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`; };

export function modelCost(name, u) {
  if (u.costUSD) return u.costUSD;
  const r = rateFor(name);
  return (u.in * r.in + u.out * r.out + u.cacheRead * r.cacheRead + u.cacheWrite * r.in * 1.25) / 1e6 + (u.webSearches || 0) * WEB_SEARCH_USD;
}
export function turnCost(m) {
  const u = m.usage;
  if (!u) return null;
  if (u.costUSD) return u.costUSD;
  return Object.entries(u.models || {}).reduce((s, [n, x]) => s + modelCost(n, x), 0);
}

const RESEARCH_TOOLS = /^(WebSearch|WebFetch|(mcp__hw__)?corpus_search)$/;
// Research estimate (labelled "est."): searches x $0.01 + the fetch summarizer (non-main models)
// + research results re-read as input (chars / 4 tokens at the main model's input rate).
export function researchEstimate(m, mainModel) {
  const u = m.usage;
  if (!u) return 0;
  const searches = u.webSearches || (m.tools || []).filter((t) => t.name === "WebSearch").length;
  const side = Object.entries(u.models || {}).filter(([n]) => n !== mainModel && !n.includes(mainModel)).reduce((s, [n, x]) => s + modelCost(n, x), 0);
  const chars = (m.tools || []).filter((t) => RESEARCH_TOOLS.test(t.name)).reduce((s, t) => s + (t.chars || 0), 0);
  const est = searches * WEB_SEARCH_USD + side + (chars / 4) * rateFor(mainModel).in / 1e6;
  return Math.min(est, turnCost(m) || est);
}

export function weekCost(week = app.week) {
  const turns = (week?.messages || []).filter((m) => m.role === "assistant" && m.usage);
  const total = turns.reduce((s, m) => s + (turnCost(m) || 0), 0);
  const research = turns.reduce((s, m) => s + researchEstimate(m, week.model), 0);
  return { total, research, writing: Math.max(0, total - research), turns: turns.length };
}
export function monthCost(now = new Date()) {
  const ym = now.toISOString().slice(0, 7);
  const weeks = (S.weeks || []).filter((w) => (w.createdAt || "").startsWith(ym));
  return { total: weeks.reduce((s, w) => s + (w.costUSD || 0), 0), weeks: weeks.length, label: now.toLocaleString(undefined, { month: "long" }) };
}

// "research sonnet $0.12 → outline opus $0.80": which model did each part of this turn (server stage routing).
const tier = (model = "") => ["opus", "sonnet", "haiku", "fable"].find((k) => model.includes(k)) || model.replace(/^claude-/, "");
export const stagesLine = (m) => (m.stages || []).length > 1 || (m.stages || [])[0]?.model ? esc(m.stages.map((x) => `${x.stage}${x.auto ? "*" : ""} ${tier(x.model)} ${fmtUSD(x.costUSD)}`).join(" → ")) : "";

// One-line footer under each Claude turn in the chat.
export function costFooter(m) {
  const u = m.usage;
  if (!u) return "";
  const tools = m.tools || [];
  const searches = u.webSearches || tools.filter((t) => t.name === "WebSearch").length;
  const cas = tools.filter((t) => /cas$/.test(t.name)).length;
  const bits = [fmtUSD(turnCost(m)), fmtDur(u.durationMs), searches ? `${searches} search${searches > 1 ? "es" : ""}` : "", cas ? `CAS×${cas}` : "", stagesLine(m)].filter(Boolean);
  return `<button class="cost-foot link" data-open="cost" title="API-equivalent cost of this turn. Click for the cost panel">${bits.join(" · ")}</button>`;
}

const KIND = { start: "Outline", revise: "Revision", approve: "Final", fix: "Fix", "revise-final": "Changes", reply: "Reply", chat: "Chat" };

// The panel shows the open week, or (from History) whichever session it was opened for.
let dlgWeek = null;
function panelHtml(week = dlgWeek || app.week) {
  const msgs = week?.messages || [];
  const rows = [];
  msgs.forEach((m, i) => {
    if (m.role !== "assistant") return;
    const prev = msgs[i - 1];
    const label = esc(KIND[prev ? kindOf(prev) : ""] || "");
    if (!m.usage) return rows.push(`<tr class="muted"><td>${label}</td><td colspan="10">not recorded (before cost tracking)</td></tr>`);
    const u = m.usage;
    const tok = Object.values(u.models || {}).reduce((a, x) => ({ in: a.in + x.in, out: a.out + x.out, cache: a.cache + x.cacheRead + x.cacheWrite }), { in: 0, out: 0, cache: 0 });
    const tools = m.tools || [];
    const count = (re) => tools.filter((t) => re.test(t.name)).length;
    rows.push(`<tr><td>${label}</td>
      <td class="num">${fmtTok(tok.in)}</td><td class="num">${fmtTok(tok.cache)}</td><td class="num">${fmtTok(tok.out)}</td>
      <td class="num">${u.webSearches || count(/^WebSearch$/)}</td><td class="num">${count(/^WebFetch$/)}</td><td class="num">${count(/corpus/)}</td><td class="num">${count(/cas$/)}</td>
      <td class="num">${fmtDur(u.durationMs)}</td><td class="num">${m.usage ? fmtUSD(researchEstimate(m, week.model)) : "—"}</td><td class="num"><b>${fmtUSD(turnCost(m))}</b></td></tr>`);
  });
  const wc = weekCost(week), mc = monthCost();
  const split = wc.total ? Math.round((wc.research / wc.total) * 100) : 0;
  return `
    <div class="row"><h2>Cost</h2><span class="spacer"></span><form method="dialog"><button class="ghost">✕</button></form></div>
    <p class="hint">These are charges to your Anthropic API account, computed from the token counts the API reports. Research is an estimate (web searches at $0.01, the page-fetch summarizer, and research results read as input).${S.budget ? ` Each turn stops at $${S.budget} (HW_BUDGET_USD).` : ""}</p>
    <div class="cost-cards">
      <div class="card"><div class="k">${dlgWeek ? esc(dlgWeek.title) : "This week"}</div><div class="big">${fmtUSD(wc.total)}</div><div class="muted small">${wc.turns} turn${wc.turns === 1 ? "" : "s"}</div></div>
      <div class="card"><div class="k">Research vs writing <span class="est">est.</span></div>
        <div class="split-bar" title="research ${fmtUSD(wc.research)} · writing ${fmtUSD(wc.writing)}"><div style="width:${split}%"></div></div>
        <div class="muted small">research ${fmtUSD(wc.research)} · writing ${fmtUSD(wc.writing)}</div></div>
      <div class="card"><div class="k">${esc(mc.label)}</div><div class="big">${fmtUSD(mc.total)}</div><div class="muted small">${mc.weeks} week${mc.weeks === 1 ? "" : "s"}</div></div>
    </div>
    ${rows.length ? `<table class="cost-table"><thead><tr><th>Turn</th><th>In</th><th>Cached</th><th>Out</th><th title="web searches">🔎</th><th title="page fetches">🌐</th><th title="corpus calls">📚</th><th title="CAS runs">🧮</th><th>Time</th><th>Research <span class="est">est.</span></th><th>Cost</th></tr></thead><tbody>${rows.join("")}</tbody></table>` : `<p class="muted">No turns with cost data yet${week ? "" : " (start a week first)"}.</p>`}`;
}

export function openCost(week = null) {
  dlgWeek = week;
  const d = $("#cost-dlg");
  d.innerHTML = panelHtml();
  if (!d.open) d.showModal();
}

onRender(function costBadge() {
  const b = $("#cost-badge");
  const wc = weekCost(), mc = monthCost();
  b.hidden = !app.week && !mc.total;
  b.textContent = app.week ? fmtUSD(wc.total) : `${mc.label.slice(0, 3)} ${fmtUSD(mc.total)}`;
  b.title = `API cost: ${fmtUSD(wc.total)} this week, ${fmtUSD(mc.total)} in ${mc.label}. Click for details.`;
  if ($("#cost-dlg").open) $("#cost-dlg").innerHTML = panelHtml();
});
