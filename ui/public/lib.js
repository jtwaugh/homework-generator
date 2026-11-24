// ES module. Shared helpers: API, parsing of the markdown files, markdown rendering, lint, diff.

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ---- event log: every UI event goes to the console ("[hw] …") and, batched, to the server's log ----
const logQueue = [];
let logTimer = null;
export function log(event, data = {}) {
  try { console.info(`[hw] ${event}`, JSON.stringify(data)); } catch {}
  logQueue.push({ event, data });
  if (!logTimer) logTimer = setTimeout(flushLog, 250);
}
// returns a promise that settles once the batch has reached the server (the dev harness awaits it)
export function flushLog() {
  clearTimeout(logTimer); logTimer = null;
  const sent = [];
  while (logQueue.length) {
    const events = logQueue.splice(0, 200);
    sent.push(fetch("/api/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events }), keepalive: true }).catch(() => {}));
  }
  return Promise.all(sent).then(() => sent.length);
}
if (typeof window !== "undefined") addEventListener("pagehide", flushLog);

// The server's build of these files, from the first response. A different one later means a deploy happened
// after this page loaded: its prompts and checks may be out of date, so it stops sending until reloaded.
let build = null;
function stale() {
  if (document.getElementById("stale-page")) return;
  const d = document.createElement("div");
  d.id = "stale-page";
  d.className = "err";
  d.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:1000;padding:8px;text-align:center";
  d.innerHTML = 'The app was updated. <button class="small-btn">Reload the page</button> to keep working.';
  d.querySelector("button").onclick = () => location.reload();
  document.body.append(d);
}
export async function api(path, opts = {}) {
  if (document.getElementById("stale-page") && (opts.method || "GET") !== "GET") throw new Error("The app was updated. Reload the page to keep working.");
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts, body: opts.body && JSON.stringify(opts.body) });
  const b = r.headers.get("X-Client-Build");
  if (b && build && b !== build) stale();
  build ||= b;
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && j.error === "login required") { location.href = "/login"; throw new Error("login required"); }
  if (!r.ok) {
    log("api-error", { method: opts.method || "GET", path, status: r.status, error: j.error || r.statusText });
    throw Object.assign(new Error(j.error || r.statusText), { status: r.status, data: j });
  }
  return j;
}

// The course the Progress map and Courses pages show when it is not the active student's (S.browse = its id).
export const withCur = (path) => (S.browse ? `${path}${path.includes("?") ? "&" : "?"}curriculum=${encodeURIComponent(S.browse)}` : path);

export const S = { browse: "", student: "", status: "", savedStatus: "", ladder: "", units: [], gated: [], texFiles: [], weeks: [], tectonic: false, model: "" };

// ======================= parsing: curriculum ladder =======================

export function parseLadder(md) {
  const units = [];
  const gated = [];
  let inGated = false;
  for (const line of md.split("\n")) {
    if (/^##\s+Gated terms/i.test(line)) { inGated = true; continue; }
    if (/^##\s/.test(line)) inGated = false;
    if (inGated) {
      const g = line.match(/^-\s+(.+):\s*(U\d\d|M\d|F\d)\s*$/);
      if (g) for (let t of g[1].split(",")) {
        t = t.replace(/\(.*?\)/g, "").trim();
        if (t.length > 1) gated.push({ term: t, unit: g[2] });
      }
      continue;
    }
    const u = line.match(/^-\s+(U\d\d|M\d|F\d)\s+([^.]+)\.(.*)$/);
    if (u) {
      const needs = (u[3].match(/Needs\s+([^.]+)\./) || [, ""])[1].match(/U\d\d|M\d|F\d/g) || [];
      units.push({ id: u[1], name: u[2].trim(), needs });
    }
  }
  return { units, gated };
}

// ======================= parsing: weekly_status.md =======================

export const STATUSES = ["TAUGHT", "CURRENT", "NEXT", "FUTURE"];
export const UNIT_RE = /^(U\d\d|M\d|F\d)\b\s*(\(.*\))?\s*$/;

export function splitTop(s) { // split on commas not inside parentheses
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function parseUnitStatuses(md) {
  const map = {}; const free = {};
  for (const st of STATUSES) free[st] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^(TAUGHT|CURRENT|NEXT|FUTURE):\s*(.*)$/);
    if (!m) continue;
    for (const tok of splitTop(m[2])) {
      const u = tok.match(UNIT_RE);
      if (u) map[u[1]] = { status: m[1], note: u[2] || "" };
      else free[m[1]].push(tok);
    }
  }
  return { map, free };
}

export function writeUnitStatuses(md, map, free) {
  const order = S.units.map((u) => u.id);
  return md.replace(/^(TAUGHT|CURRENT|NEXT|FUTURE):.*$/gm, (_, st) => {
    let ids = order.filter((id) => map[id]?.status === st);
    // "FUTURE: everything else ..." stays implicit
    if (st === "FUTURE" && free.FUTURE.some((f) => /everything else/i.test(f))) ids = [];
    const toks = ids.map((id) => (map[id].note ? `${id} ${map[id].note}` : id)).concat(free[st]);
    return `${st}: ${toks.join(", ")}`;
  });
}

export const WEEK_FIELDS = [
  { key: "Date (for title)", label: "Date", kind: "input", ph: "11/28/2026" },
  { key: "Disclaimer", label: "Disclaimer", kind: "select", opts: ["", "yes", "no"] },
  { key: "Topics", label: "Topics", kind: "textarea" },
  { key: "Number of sections (default 3-4)", label: "Sections", kind: "input", ph: "default 3-4" },
  { key: "Example problem ideas (optional)", label: "Problem ideas", kind: "textarea" },
  { key: "Emphasize or avoid", label: "Emphasize / avoid", kind: "textarea" },
  { key: "Graph paper", label: "Graph paper", kind: "select", opts: ["", "yes", "no", "auto"] },
  { key: "Fact sheet or other auxiliary file", label: "Fact sheet / aux", kind: "textarea", ph: 'paste it, or "none"' },
  { key: "Answer key", label: "Answer key", kind: "select", opts: ["", "yes", "no"] },
  { key: "Worked examples", label: "Worked examples", kind: "input", ph: "yes or a number" },
  { key: "Unit circle sheet", label: "Unit circle sheet", kind: "select", opts: ["", "yes", "no"] },
];
// Template placeholder values that mean "not filled in".
export const PLACEHOLDER = /^(yes \/ no( \/ auto)?|upload, paste, or "none")$/;

export function sectionBounds(md, heading) {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase().startsWith(heading.toLowerCase()));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  return { lines, start, end };
}

export function parseWeekInput(md) {
  const b = sectionBounds(md, "## This week's input");
  const vals = {};
  if (!b) return vals;
  let cur = null;
  for (const line of b.lines.slice(b.start + 1, b.end)) {
    const f = WEEK_FIELDS.find((f) => line.startsWith(f.key + ":"));
    if (f) { cur = f.key; vals[cur] = line.slice(f.key.length + 1).trim(); }
    else if (cur && line.startsWith("  ")) vals[cur] += "\n" + line.slice(2);
  }
  for (const k in vals) if (PLACEHOLDER.test(vals[k])) vals[k] = "";
  return vals;
}

export function writeWeekInput(md, vals) {
  const b = sectionBounds(md, "## This week's input");
  const body = WEEK_FIELDS.map((f) => {
    const v = (vals[f.key] || "").trim();
    const [first, ...rest] = v.split("\n");
    return `${f.key}: ${first}` + rest.map((r) => "\n  " + r).join("");
  });
  if (!b) return md.trimEnd() + "\n\n## This week's input\n" + body.join("\n") + "\n";
  const tail = b.lines.slice(b.end);
  return [...b.lines.slice(0, b.start + 1), ...body, ...(tail.length ? ["", ...tail] : [""])].join("\n");
}

// ======================= markdown (minimal) =======================

// Light TeX prettifier for Claude's prose: $x \le 2$ -> italic "x ≤ 2". Not a full renderer.
export function mathify(h) {
  const sym = { le: "≤", ge: "≥", ne: "≠", leq: "≤", geq: "≥", neq: "≠", cdot: "·", times: "×", pm: "±", infty: "∞", ell: "ℓ", sqrt: "√", to: "→", dots: "…", ldots: "…" };
  // every Greek letter (an unknown command renders as nothing, which silently drops a variable)
  const greek = "alpha α beta β gamma γ delta δ epsilon ε varepsilon ε zeta ζ eta η theta θ vartheta ϑ iota ι kappa κ lambda λ mu μ nu ν xi ξ pi π rho ρ sigma σ tau τ upsilon υ phi φ varphi φ chi χ psi ψ omega ω Gamma Γ Delta Δ Theta Θ Lambda Λ Xi Ξ Pi Π Sigma Σ Phi Φ Psi Ψ Omega Ω".split(" ");
  for (let i = 0; i < greek.length; i += 2) sym[greek[i]] = greek[i + 1];
  return h.replace(/\$([^$\n]{1,80})\$/g, (_, m) => {
    let t = m.replace(/\\d?frac\{([^{}]*)\}\{([^{}]*)\}/g, "$1⁄$2")
      .replace(/\\([a-zA-Z]+)/g, (x, n) => sym[n] ?? "")
      .replace(/\^2/g, "²").replace(/\^3/g, "³").replace(/[{}]/g, "");
    return `<span class="mathy">${t}</span>`;
  });
}

export function md(src) {
  const out = []; const lines = src.split("\n"); let i = 0, list = null;
  const inline = (s) => mathify(esc(s)).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>");
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      closeList(); const buf = []; i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`); continue;
    }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) { closeList(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
    else if ((m = l.match(/^\s*[-*]\s+(.*)/))) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = l.match(/^\s*(\d+)[.)]\s+(.*)/))) { if (list !== "ol") { closeList(); out.push(`<ol start="${m[1]}">`); list = "ol"; } out.push(`<li value="${m[1]}">${inline(m[2])}</li>`); }
    else if (!l.trim()) closeList();
    else { closeList(); out.push(`<p>${inline(l)}</p>`); }
    i++;
  }
  closeList();
  return out.join("");
}

export function extractBlock(text, langs, test = () => true) {
  const re = /```([a-zA-Z]*)\n([\s\S]*?)\n```/g; let m, found = null;
  while ((m = re.exec(text))) if (langs.includes(m[1].toLowerCase()) && test(m[2])) found = m[2];
  return found;
}

// ======================= lint =======================

// statusMd: the weekly_status.md this week will save (a unit it starts counts as unlocked)
export function lintTex(tex, statusMd = "") {
  const issues = [];
  let body = tex.split("\\begin{document}")[1] ?? tex;
  body = body.replace(/(^|[^\\])%.*$/gm, "$1"); // drop comments (provenance notes)
  const { map } = parseUnitStatuses(S.savedStatus);
  const next = statusMd ? parseUnitStatuses(statusMd).map : {};
  const allowed = (u) => ["TAUGHT", "CURRENT"].includes(map[u]?.status) || ["TAUGHT", "CURRENT"].includes(next[u]?.status);
  const find = (re) => { const m = body.match(re); return m ? m[0] : null; };

  if (find(/\bFOIL\b/)) issues.push(["bad", 'uses "FOIL" (say "expand")']);
  if (find(/cross[- ]?multipl/i)) issues.push(["bad", 'uses "cross-multiply"']);
  const dec = [...body.matchAll(/\b\d+\.\d+\b(?!\s*(cm|in|pt|em|ex|mm|\\))/g)];
  if (dec.length) issues.push(["bad", `possible decimals: ${[...new Set(dec.map((d) => d[0]))].slice(0, 5).join(", ")}`]);
  for (const { term, unit } of S.gated) {
    if (allowed(unit)) continue;
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]+")}s?\\b`, "i");
    if (re.test(body)) issues.push(["bad", `gated term "${term}" (unlocked by ${unit}, which is ${map[unit]?.status || "FUTURE"})`]);
  }
  // disallowed single-letter variables in math: e i l o v
  const math = [...body.matchAll(/\$\$?([^$]+)\$\$?|\\\[([\s\S]+?)\\\]|\\begin\{(?:align\*?|cases)\}([\s\S]+?)\\end/g)].map((m) => m[1] || m[2] || m[3]);
  const bad = new Set();
  for (const m of math) {
    const clean = m.replace(/\\text\{[^}]*\}/g, "").replace(/\\[a-zA-Z]+/g, " ");
    for (const v of clean.matchAll(/(^|[^A-Za-z])([eilov])(?![A-Za-z])/g)) bad.add(v[2]);
  }
  if (bad.size) issues.push(["warn", `variable letters not on the allowed list: ${[...bad].join(", ")}`]);
  if (!/\\title\{[^}]*HW \d{1,2}\/\d{1,2}\/\d{4}/.test(tex)) issues.push(["warn", 'title isn\'t "<name> HW M/D/YYYY"']);
  return issues;
}

// ======================= diff =======================

export function diffHtml(a, b) {
  const A = a.trimEnd().split("\n"), B = b.trimEnd().split("\n");
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { out.push(`<span class="same">  ${esc(A[i])}</span>`); i++; j++; }
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) out.push(`<span class="add">+ ${esc(B[j++])}</span>`);
    else out.push(`<span class="del">- ${esc(A[i++])}</span>`);
  }
  return out.join("");
}


// Older weeks stored no kind on user messages; recognise the app's own canned messages by their wording.
export const kindOf = (m) => m.kind || (/^Here is this week's weekly_status\.md/.test(m.text) ? "start" : /^Approved[.,]/.test(m.text) ? "approve" : /^The app compiled and checked/.test(m.text) ? "fix" : "chat");

// The next class date: a week after the latest saved set (or the date already entered, if it's later), never in the past.
export function nextSetDate(texFiles, entered, today = new Date()) {
  const parse = (s) => { const m = String(s || "").match(/(\d{1,2})[_/](\d{1,2})[_/](\d{4})/); return m ? new Date(+m[3], +m[1] - 1, +m[2]) : null; };
  const last = texFiles.map(parse).filter(Boolean).sort((a, b) => a - b).pop();
  const typed = parse(entered);
  if (typed && (!last || typed > last)) return entered;
  const d = last ? new Date(last) : new Date(today);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  do d.setDate(d.getDate() + 7); while (d < start);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}
