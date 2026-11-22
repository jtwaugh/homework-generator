// Local UI for the weekly homework generator.
// Uses the `claude` CLI (your logged-in Claude account) for generation and
// Tectonic for LaTeX compilation. No npm dependencies.
//
//   node ui/server.mjs          then open http://localhost:4747

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tagProblems, needsTags, TAG_MODEL } from "./lib/tagger.mjs";
import { loadCorpus, saveCorpus, searchCorpus, formatHits, addProblems, patchProblem, dateFromName, tokenize, attachTex } from "./lib/corpus.mjs";

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
// HW_ROOT / HW_DATA point the app at another copy of the files (dev/sandbox.mjs makes one for tests).
const ROOT = process.env.HW_ROOT ? path.resolve(process.env.HW_ROOT) : path.resolve(UI_DIR, "..");
const PUBLIC = path.join(UI_DIR, "public");
const DATA = process.env.HW_DATA ? path.resolve(process.env.HW_DATA) : path.join(UI_DIR, "data");
const WEEKS = path.join(DATA, "weeks");
const BUILD = path.join(DATA, "build");
const BACKUPS = path.join(DATA, "backups");
const MCP_DIR = path.join(DATA, "mcp");
const DEBUG = path.join(DATA, "debug");
const NOTES = path.join(DATA, "notes");
const DAG_STATE = path.join(DATA, "dag_state.json");
const LOGS = path.join(DATA, "logs");
const MCP_SERVER = path.join(UI_DIR, "mcp", "hw-tools.mjs");
const VENV_PY = path.join(DATA, "venv", "bin", "python");
// Claude runs in an empty directory so it picks up no CLAUDE.md or project files.
const CLAUDE_CWD = path.join(DATA, "claude-cwd");
const PORT = Number(process.env.PORT || 4747);
const DEFAULT_MODEL = process.env.HW_MODEL || "claude-opus-5-5";
const GUESS_MODEL = process.env.HW_GUESS_MODEL || "claude-sonnet-5-5";
// Past sets sent with every run as style examples (older ones are in the corpus). Each adds ~2k tokens to every turn.
const GOLD_COUNT = Math.max(1, Number(process.env.HW_GOLD_FILES) || 3);
const BUDGET = process.env.HW_BUDGET_USD ? String(Number(process.env.HW_BUDGET_USD)) : null;
const ALLOWED_TOOLS = "WebSearch,WebFetch,mcp__hw__cas,mcp__hw__corpus_search,mcp__hw__corpus_add";

for (const d of [WEEKS, BUILD, BACKUPS, CLAUDE_CWD, MCP_DIR, DEBUG, NOTES, LOGS]) fs.mkdirSync(d, { recursive: true });

const STATUS_FILE = path.join(ROOT, "weekly_status.md");
const INSTRUCTIONS_FILE = path.join(ROOT, "project_instructions.md");
const LADDER_FILE = path.join(ROOT, "curriculum_ladder.md");
// The student's name, shown in the UI and used in prompts. Set HW_STUDENT=<name>; the default is generic.
const STUDENT = (process.env.HW_STUDENT || "").trim();
// First run: copy the example workflow, ladder and status into the homework folder if they aren't there yet.
for (const f of [INSTRUCTIONS_FILE, LADDER_FILE, STATUS_FILE]) {
  const ex = path.join(UI_DIR, "..", "examples", path.basename(f));
  if (!fs.existsSync(f) && fs.existsSync(ex)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.copyFileSync(ex, f); console.log(`created ${f} from examples/`); }
}

// ---------- event log ----------
// One stream for everything that happens: HTTP requests, claude runs and their tool calls, compiles, the
// progress-map guess, and UI events the browser posts to /api/log. Printed to stdout, appended to
// data/logs/app.jsonl, and kept in memory for GET /api/logs?since=<seq> (the dev harness tails it).
const LOG_FILE = path.join(LOGS, "app.jsonl");
const recentLog = [];
let logSeq = 0;
const QUIET = process.env.HW_LOG_QUIET === "1";
const short = (v, n = 160) => { const t = typeof v === "string" ? v : JSON.stringify(v); return t && t.length > n ? t.slice(0, n) + "…" : t; };
export function logEvent(src, event, data = {}) {
  const e = { seq: ++logSeq, ts: new Date().toISOString(), src, event, ...data };
  recentLog.push(e); if (recentLog.length > 3000) recentLog.shift();
  fs.appendFile(LOG_FILE, JSON.stringify(e) + "\n", () => {});
  if (!QUIET) {
    const rest = Object.entries(data).map(([k, v]) => `${k}=${short(v)}`).join(" ");
    console.log(`[${e.ts.slice(11, 19)}] ${src.padEnd(6)} ${event}${rest ? " " + rest : ""}`);
  }
  return e;
}

// ---------- helpers ----------

// Files may use CRLF line endings; work with \n internally and restore on write.
const read = async (p) => (await fsp.readFile(p, "utf8")).replace(/\r\n/g, "\n");
const readJson = async (p, dflt) => { try { return JSON.parse(await fsp.readFile(p, "utf8")); } catch { return dflt; } };
async function writeLikeOriginal(p, text) {
  const orig = fs.existsSync(p) ? await fsp.readFile(p, "utf8") : "";
  const out = text.replace(/\r\n/g, "\n");
  await fsp.writeFile(p, orig.includes("\r\n") ? out.replace(/\n/g, "\r\n") : out);
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".pdf": "application/pdf",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic", ".svg": "image/svg+xml",
  ".tex": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8" };

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString("utf8");
  return s ? JSON.parse(s) : {};
}

const TEX_NAME = /^[A-Za-z0-9_.-]+\.tex$/;
const WEEK_ID = /^[A-Za-z0-9_-]+$/;
const NOTE_NAME = /^[A-Za-z0-9 _.,()-]+\.(tex|md|txt|pdf|png|jpe?g|gif|webp|heic)$/i;
const TEXT_NOTE = /\.(tex|md|txt)$/i;

async function texFiles() {
  const names = (await fsp.readdir(ROOT)).filter((n) => TEX_NAME.test(n));
  const withDates = names.map((n) => {
    const m = n.match(/(\d{1,2})_(\d{1,2})_(\d{4})/);
    const t = m ? new Date(+m[3], +m[1] - 1, +m[2]).getTime() : 0;
    return { name: n, t };
  });
  return withDates.sort((a, b) => a.t - b.t).map((x) => x.name);
}

let tectonicPath;
function findTectonic() {
  if (tectonicPath !== undefined) return tectonicPath;
  for (const c of ["tectonic", "/opt/homebrew/bin/tectonic", "/usr/local/bin/tectonic"]) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return (tectonicPath = c);
  }
  return (tectonicPath = null);
}
let casOk = null;
const casAvailable = () => (casOk ??= fs.existsSync(VENV_PY) && spawnSync(VENV_PY, ["-c", "import sympy"], { timeout: 30000 }).status === 0);

// ---------- weekly_status / ladder parsing (just what the server needs) ----------

function ladderUnits(ladder) {
  return [...ladder.matchAll(/^-\s+(U\d\d|M\d|F\d)\s+([^.]+)\./gm)].map((m) => ({ id: m[1], name: m[2].trim() }));
}
function statusSection(md, heading) {
  const i = md.toLowerCase().indexOf(heading.toLowerCase());
  if (i < 0) return "";
  const rest = md.slice(i + heading.length);
  const j = rest.search(/\n##\s/);
  return j < 0 ? rest : rest.slice(0, j);
}
// Units and query for the corpus preload: units named in Topics, CURRENT units, review priorities.
export function preloadQuery(status, ladder) {
  const units = ladderUnits(ladder);
  const input = statusSection(status, "## This week's input");
  const topics = (input.match(/^Topics:(.*(?:\n {2,}.*)*)/m)?.[1] || "").replace(/\n\s+/g, " ").trim();
  const review = statusSection(status, "## Review priority").split("\n").filter((l) => /^\s*(\d+[.)]|[-*])\s/.test(l)).map((l) => l.replace(/^\s*(\d+[.)]|[-*])\s+/, "").replace(/\(.*$/, "").trim());
  const cur = (status.match(/^CURRENT:(.*)$/m)?.[1] || "").match(/U\d\d|M\d|F\d/g) || [];
  const topicToks = new Set(tokenize(topics));
  const named = units.filter((u) => new RegExp(`\\b${u.id}\\b`).test(topics) || (tokenize(u.name).length && tokenize(u.name).every((w) => topicToks.has(w)))).map((u) => u.id);
  return { units: [...new Set([...named, ...cur])], query: [topics, ...review].join(" "), topics, review };
}

// ---------- weeks (conversation state) ----------

const weekPath = (id) => path.join(WEEKS, `${id}.json`);
const toolsPath = (id) => path.join(WEEKS, `${id}.tools.jsonl`);

async function loadWeek(id) {
  if (!WEEK_ID.test(id)) throw new Error("bad week id");
  return JSON.parse(await read(weekPath(id)));
}
async function saveWeek(w) {
  await fsp.writeFile(weekPath(w.id), JSON.stringify(w, null, 2));
}
const weekCost = (w) => w.messages.reduce((s, m) => s + (m.usage?.costUSD || 0), 0);
async function listWeeks() {
  const out = [];
  for (const f of await fsp.readdir(WEEKS)) {
    if (!f.endsWith(".json")) continue;
    try {
      const w = JSON.parse(await read(path.join(WEEKS, f)));
      out.push({ id: w.id, title: w.title, createdAt: w.createdAt, turns: w.messages.length, done: !!w.done, savedAs: w.savedAs || null, model: w.model, costUSD: weekCost(w) });
    } catch {}
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
async function readToolLog(id) {
  try { return (await read(toolsPath(id))).split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { return []; }
}

async function buildSystemPrompt() {
  const [instr, ladder] = await Promise.all([read(INSTRUCTIONS_FILE), read(LADDER_FILE)]);
  const gold = [];
  for (const n of (await texFiles()).slice(-GOLD_COUNT)) gold.push(`<file name="${n}">\n${await read(path.join(ROOT, n))}\n</file>`);
  return [
    instr,
    "\n\n# Project files\n",
    `<file name="curriculum_ladder.md">\n${ladder}\n</file>`,
    ...gold,
    "\n\n# How this app works (overrides the parts of the workflow it covers)",
    "- You are running inside a local app, not a chat. The teacher's weekly_status.md is in the first user message.",
    "- Tools: web search, web fetch, and the app's own tools `cas`, `corpus_search` and `corpus_add`. There is no bash tool. The app compiles your .tex with Tectonic and will send you any errors or overfull-box warnings. In the final step, write \"not compiled (the app will compile it)\".",
    "- Use `cas` (Python with sympy) to verify every answer key entry in the final: substitute solutions back, check for extraneous roots, confirm factorizations. Batch the problems into a few calls that print one line per problem. In the final reply say how many answers you checked with the CAS.",
    "- Problem corpus: the teacher's cache of problems from past sets, earlier research and favorites. The first message includes the best matches for this week. Draw from the corpus first, and adapt rather than copy problems marked used (especially recent ones). Use `corpus_search` for more. Web search only for sections where the corpus has fewer than 3 suitable candidates. Whenever you find good problems on the web, call `corpus_add` with them, including ones you won't use this week. In the checkpoint, say which problems came from the corpus (by id) and which came from the web.",
    "- In the final step put the complete .tex in exactly one ```latex fenced block, and the complete updated weekly_status.md in exactly one ```markdown fenced block. The app extracts both.",
    "- After the .tex and status blocks, add one ```json fenced block: a problem manifest, an array with one object per \\item in the set, in the order they appear in the .tex: {\"part\": 1, \"n\": 3, \"answer\": \"...\", \"units\": [\"U14\"], \"source\": \"corpus:<id>\" or \"web:<url>\" or \"new\", \"casVerified\": true}. Don't repeat the problem text: the app reads it from the .tex. The app saves it to the corpus when the teacher saves the set.",
    "- If the teacher asks for changes after the final, always reply with the complete revised .tex, weekly_status.md and manifest again.",
  ].join("\n");
}

// ---------- running claude ----------

const running = new Map(); // key (weekId or "dag-guess") -> child process
const progress = new Map(); // weekId -> { text, tools, startedAt } for the turn in flight
let debugLogged = fs.existsSync(path.join(DEBUG, "result-event.json"));

const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s);
const resultText = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b.type === "text" ? b.text : b.type === "image" ? "[image]" : JSON.stringify(b)).join("\n") : JSON.stringify(c ?? "");

function summarizeUsage(ev) {
  const models = {};
  let webSearches = 0;
  for (const [name, u] of Object.entries(ev.modelUsage || {})) {
    models[name] = { in: u.inputTokens || 0, out: u.outputTokens || 0, cacheRead: u.cacheReadInputTokens || 0, cacheWrite: u.cacheCreationInputTokens || 0, webSearches: u.webSearchRequests || 0, costUSD: u.costUSD || 0 };
    webSearches += u.webSearchRequests || 0;
  }
  return { costUSD: ev.total_cost_usd || 0, durationMs: ev.duration_ms || 0, numTurns: ev.num_turns || 0, webSearches, models };
}

// Spawn `claude -p` with stream-json output. Collects text, tool calls (with result sizes) and usage.
function spawnClaude({ key, args, prompt, cwd, onEvent = () => {} }) {
  return new Promise((resolve) => {
    // Strip API-key variables so the CLI uses the logged-in Claude account.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    const t0 = Date.now();
    const model = args[args.indexOf("--model") + 1];
    logEvent("claude", "start", { key, model, promptChars: prompt.length });
    const child = spawn("claude", args, { cwd, env });
    running.set(key, child);
    child.stdin.end(prompt);

    const texts = []; // complete assistant text blocks, in order
    const tools = []; // {id, name, input, at, ms, chars, ok, preview}
    let buf = "", stderr = "", resultError = null, usage = null;

    const onLine = (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === "stream_event" && !ev.parent_tool_use_id) {
        const e = ev.event;
        if (e.type === "content_block_delta" && e.delta?.type === "text_delta") onEvent({ type: "text", text: e.delta.text });
        if (e.type === "content_block_start" && e.content_block?.type === "text" && texts.length) onEvent({ type: "text", text: "\n\n" });
      } else if (ev.type === "assistant" && !ev.parent_tool_use_id) {
        for (const b of ev.message.content || []) {
          if (b.type === "text" && b.text) texts.push(b.text);
          if (b.type === "tool_use") {
            const t = { id: b.id, name: b.name, input: b.input, at: Date.now(), textIndex: texts.length };
            tools.push(t);
            logEvent("claude", "tool", { key, name: b.name, input: short(b.input, 200) });
            onEvent({ type: "tool", tool: t });
          }
        }
      } else if (ev.type === "user" && !ev.parent_tool_use_id) {
        for (const b of ev.message?.content || []) {
          if (b.type !== "tool_result") continue;
          const t = tools.find((x) => x.id === b.tool_use_id);
          if (!t) continue;
          const txt = resultText(b.content);
          Object.assign(t, { ms: Date.now() - t.at, chars: txt.length, ok: !b.is_error, preview: clip(txt, 4000) });
          logEvent("claude", "tool-result", { key, name: t.name, ok: t.ok, ms: t.ms, chars: t.chars, ...(t.ok ? {} : { error: short(txt, 300) }) });
          onEvent({ type: "tool_result", tool: t });
        }
      } else if (ev.type === "result") {
        if (!debugLogged) { debugLogged = true; fsp.writeFile(path.join(DEBUG, "result-event.json"), JSON.stringify(ev, null, 2)).catch(() => {}); }
        usage = summarizeUsage(ev);
        logEvent("claude", "result", { key, costUSD: usage?.costUSD, turns: usage?.numTurns, webSearches: usage?.webSearches, error: ev.is_error ? short(ev.result || ev.subtype, 300) : undefined });
        if (ev.is_error) resultError = ev.result || ev.subtype || "Claude returned an error";
      }
    };
    child.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onLine(line); }
    });
    child.stderr.on("data", (d) => { const t = d.toString("utf8"); stderr += t; for (const l of t.split("\n")) if (l.trim()) logEvent("claude", "stderr", { key, line: short(l, 300) }); });
    child.on("error", (err) => { resultError = `Could not start claude: ${err.message}`; });
    child.on("close", (code) => {
      if (buf.trim()) onLine(buf.trim());
      running.delete(key);
      logEvent("claude", "exit", { key, code, ms: Date.now() - t0, chars: texts.join("").length, tools: tools.length, error: resultError ? short(resultError, 300) : undefined });
      const text = texts.join("\n\n");
      const out = { text, usage, tools: tools.map(({ at, ...t }) => t) };
      if (resultError || (code !== 0 && !text)) resolve({ ...out, ok: false, error: resultError || stderr.trim() || `claude exited with code ${code}` });
      else resolve({ ...out, ok: true });
    });
  });
}

async function mcpConfigFor(weekId) {
  const file = path.join(MCP_DIR, `${weekId}.json`);
  await fsp.writeFile(file, JSON.stringify({ mcpServers: { hw: { type: "stdio", command: process.execPath, args: [MCP_SERVER], env: { WEEK_ID: weekId, HW_DATA: DATA } } } }, null, 2));
  return file;
}

async function runClaude(week, prompt, systemPrompt, onEvent) {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", week.model || DEFAULT_MODEL,
    "--tools", "WebSearch,WebFetch",
    "--allowedTools", ALLOWED_TOOLS,
    "--mcp-config", await mcpConfigFor(week.id),
    "--strict-mcp-config",
    "--disable-slash-commands",
  ];
  if (BUDGET) args.push("--max-budget-usd", BUDGET);
  if (week.started) args.push("--resume", week.sessionId);
  else args.push("--session-id", week.sessionId, "--system-prompt", systemPrompt);
  return spawnClaude({ key: week.id, args, prompt, cwd: CLAUDE_CWD, onEvent });
}

// ---------- compile (cached by content hash) ----------

const compiling = new Map(); // sha -> Promise
async function compileTex(text) {
  const tec = findTectonic();
  if (!tec) return { ok: false, log: "Tectonic is not installed. Run: brew install tectonic", warnings: [] };
  const sha = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const dir = path.join(BUILD, sha);
  const meta = await readJson(path.join(dir, "meta.json"), null);
  if (meta) return { ...meta, cached: true };
  if (compiling.has(sha)) return compiling.get(sha);
  logEvent("tex", "compile-start", { sha, chars: text.length });
  const t0 = Date.now();
  const job = (async () => {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "hw.tex"), text);
    const r = await new Promise((resolve) => {
      const child = spawn(tec, ["--keep-logs", "--outdir", dir, path.join(dir, "hw.tex")]);
      let log = "";
      const t = setTimeout(() => child.kill("SIGKILL"), 180000);
      child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
      child.on("close", (code) => { clearTimeout(t); resolve({ code, log }); });
      child.on("error", (e) => { clearTimeout(t); resolve({ code: -1, log: e.message }); });
    });
    const warnings = r.log.split("\n").filter((l) => /overfull|underfull|warning/i.test(l));
    const ok = r.code === 0 && fs.existsSync(path.join(dir, "hw.pdf"));
    const out = { ok, sha, pdf: ok ? `/build/${sha}/hw.pdf` : null, log: r.log, warnings };
    await fsp.writeFile(path.join(dir, "meta.json"), JSON.stringify(out));
    logEvent("tex", "compile-done", { sha, ok, ms: Date.now() - t0, warnings: warnings.length, ...(ok ? {} : { error: short(r.log.split("\n").filter((l) => /^!|error/i.test(l)).join(" | ") || r.log.slice(-300), 300) }) });
    return out;
  })();
  compiling.set(sha, job);
  try { return await job; } finally { compiling.delete(sha); }
}

// ---------- corpus: preload + save manifest ----------

async function corpusPreload() {
  const [status, ladder] = await Promise.all([read(STATUS_FILE), read(LADDER_FILE)]);
  const q = preloadQuery(status, ladder);
  const hits = searchCorpus(loadCorpus(), { units: q.units, query: q.query, limit: 15 });
  return { ...q, hits };
}

function extractBlocks(text, lang) {
  return [...text.matchAll(/```([a-zA-Z]*)\n([\s\S]*?)\n```/g)].filter((m) => m[1].toLowerCase() === lang).map((m) => m[2]);
}
export function manifestFrom(week) {
  const msg = [...week.messages].reverse().find((m) => m.role === "assistant" && /```(latex|tex)\n/.test(m.text));
  if (!msg) return [];
  for (const b of extractBlocks(msg.text, "json").reverse()) {
    try { const a = JSON.parse(b); if (Array.isArray(a)) return a.filter((p) => p && typeof p === "object"); } catch {}
  }
  return [];
}
function saveManifest(week, name, tex) {
  const list = attachTex(manifestFrom(week), tex);
  if (!list.length) return { added: 0, merged: 0, total: 0 };
  const date = dateFromName(name) || new Date().toISOString().slice(0, 10);
  const items = loadCorpus();
  const r = addProblems(items, list.map((p) => ({
    tex: p.tex, answer: p.answer, units: p.units, tags: p.tags, casVerified: p.casVerified, status: "used", usedOn: [date],
    context: p.part ? `Part ${p.part}` : "", source: { kind: "final", file: name, date, week: week.id, origin: p.source },
  })), { file: false });
  // Adapted from a corpus problem: the original counts as used on this date too.
  for (const p of list) {
    const m = String(p.source || "").match(/^corpus:(p[0-9a-f]+)/);
    const orig = m && items.find((x) => x.id === m[1]);
    if (orig) { orig.usedOn = [...new Set([...(orig.usedOn || []), date])].sort(); if (orig.status === "candidate") orig.status = "used"; }
  }
  saveCorpus(items);
  const ids = [...r.added, ...r.merged].filter((id) => needsTags(items.find((x) => x.id === id) || {}));
  return { added: r.added.length, merged: r.merged.length, total: list.length, toTag: ids };
}

// Tag problems with Wu content and methods nodes in the background (one cheap pass), then patch the corpus.
// The corpus is re-read before writing, so edits made meanwhile are kept.
let tagChain = Promise.resolve();
export function tagInBackground(ids, label) {
  if (!ids.length || process.env.HW_NO_TAG) return;
  tagChain = tagChain.then(async () => {
    const probs = loadCorpus().filter((p) => ids.includes(p.id)).map((p) => structuredClone(p));
    logEvent("tag", "start", { label, problems: probs.length, model: TAG_MODEL });
    try {
      const r = await tagProblems(probs, { root: ROOT, data: DATA });
      const items = loadCorpus();
      for (const p of probs) patchProblem(items, p.id, { units: p.units, wuNodes: p.wuNodes, tags: p.tags }, { file: false });
      saveCorpus(items);
      logEvent("tag", "done", { label, tagged: r.tagged, withMethods: probs.filter((p) => p.wuNodes.some((n) => n.startsWith("m:"))).length, costUSD: +r.cost.toFixed(4) });
    } catch (e) { logEvent("tag", "error", { label, error: e.message.slice(0, 300) }); }
  });
}

// ---------- Wu DAG: snapshot + the student's progress ----------

async function dagState() { return readJson(DAG_STATE, { guess: null, overrides: {} }); }
let guessJob = null; // { running, startedAt, tools, error }

async function noteFiles() {
  const out = [];
  for (const n of (await fsp.readdir(NOTES)).sort()) {
    if (!NOTE_NAME.test(n)) continue;
    const st = await fsp.stat(path.join(NOTES, n));
    out.push({ name: n, size: st.size, at: st.mtime.toISOString() });
  }
  return out;
}

async function buildGuessPrompt() {
  const [content, methods, ladder, status] = await Promise.all([
    readJson(path.join(DATA, "wu_dag.json"), { nodes: [], edges: [] }), readJson(path.join(DATA, "wu_methods_dag.json"), { nodes: [], edges: [] }),
    read(LADDER_FILE), read(STATUS_FILE),
  ]);
  const nodeLines = (g, pre) => g.nodes.map((n) => `${pre}${n.id} [${n.kind}] ${n.title}${n.detail ? " — " + n.detail.replace(/\s+/g, " ") : ""}${n.restsOn?.length ? ` (rests on ${n.restsOn.join(", ")})` : ""}`).join("\n");
  const edgeLines = (g, pre) => g.edges.map((e) => `${pre}${e.from} -> ${pre}${e.to}${e.prove ? " (needed to prove)" : ""}`).join("\n");
  const files = [];
  for (const n of await texFiles()) files.push(`<file name="${n}" date="${dateFromName(n) || "?"}">\n${await read(path.join(ROOT, n))}\n</file>`);
  const notes = await noteFiles();
  for (const n of notes.filter((x) => TEXT_NOTE.test(x.name))) files.push(`<file name="notes/${n.name}">\n${await read(path.join(NOTES, n.name))}\n</file>`);
  const binary = notes.filter((x) => !TEXT_NOTE.test(x.name));
  return [
    `You are estimating how far a student${STUDENT ? ` (${STUDENT})` : ""} has got through H. Wu's algebra, using two dependency graphs of the material and the evidence below: every homework set the student was given (with dates), the teacher's weekly_status.md, and any uploaded notes.`,
    "",
    "Return ONLY one ```json fenced block with this shape:",
    '{"nodes": {"e26": {"state": "done", "confidence": 0.9, "evidence": [{"file": "hw_9_11_2026.tex", "date": "2026-09-11", "quote": "short quote"}]}, "m:e46": {...}},',
    ' "ladderToWu": {"U05": ["e64", "m:e46"]},',
    ' "summary": "two sentences"}',
    "- One entry for EVERY node of both graphs. Content node ids are plain (e26); methods node ids carry the m: prefix (m:e46).",
    "- state: done (practised in several sets or clearly taught), partial (appears but thin, or marked partly taught), not-yet. confidence: 0 to 1.",
    "- evidence: up to 3 items, quoting the homework or notes briefly. Empty for not-yet.",
    "- \"assumed\" content nodes are background (number laws) and count as done once any algebra is done.",
    "- Word-problem method nodes are banned in these sets; mark them not-yet unless notes show otherwise.",
    "- ladderToWu: for every ladder unit id, the Wu node ids (both graphs) it covers.",
    "- Treat weekly_status.md unit statuses as the teacher's view, but judge from the homework. Don't fill gaps by assumption.",
    binary.length ? `- Also read these uploaded note files with the Read tool (they are in the current directory): ${binary.map((b) => b.name).join(", ")}` : "",
    "",
    "## Wu content DAG (arrow A -> B: A is used for B)", nodeLines(content, ""), "", edgeLines(content, ""),
    "", "## Wu methods DAG (arrow A -> B: A is used as a sub-step of B; 'rests on' = content node)", nodeLines(methods, "m:"), "", edgeLines(methods, "m:"),
    "", "## Curriculum ladder", ladder, "", "## weekly_status.md", status, "", "## Evidence files", ...files,
  ].join("\n");
}

async function runGuess() {
  if (guessJob?.running) return;
  guessJob = { running: true, startedAt: Date.now(), tools: [], error: null };
  try {
    const prompt = await buildGuessPrompt();
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", GUESS_MODEL, "--tools", "Read", "--allowedTools", "Read",
      "--add-dir", NOTES, "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"];
    const r = await spawnClaude({ key: "dag-guess", args, prompt, cwd: NOTES, onEvent: (e) => e.type === "tool" && guessJob.tools.push(`${e.tool.name}: ${e.tool.input?.file_path || ""}`) });
    if (!r.ok) throw new Error(r.error);
    let parsed = null;
    const candidates = [...extractBlocks(r.text, "json"), r.text.slice(r.text.indexOf("{"), r.text.lastIndexOf("}") + 1)];
    for (const b of candidates) {
      try { const x = JSON.parse(b); if (x?.nodes) { parsed = x; break; } } catch {}
    }
    if (!parsed) throw new Error("Claude's reply had no JSON nodes block");
    const st = await dagState();
    st.guess = { at: new Date().toISOString(), model: GUESS_MODEL, nodes: parsed.nodes, ladderToWu: parsed.ladderToWu || {}, summary: parsed.summary || "", usage: r.usage, files: (await texFiles()).length + (await noteFiles()).length };
    await fsp.writeFile(DAG_STATE, JSON.stringify(st, null, 1));
    guessJob = { running: false, finishedAt: Date.now(), costUSD: r.usage?.costUSD || 0 };
    logEvent("dag", "guess-done", { nodes: Object.keys(parsed.nodes).length, costUSD: r.usage?.costUSD });
  } catch (e) {
    guessJob = { running: false, error: e.message };
    logEvent("dag", "guess-failed", { error: e.message });
  }
}

// ---------- routes ----------

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const m = req.method;

  if (m === "POST" && p === "/api/log") {
    const { events = [] } = await body(req);
    for (const ev of events.slice(0, 200)) logEvent("ui", String(ev.event || "event").slice(0, 40), ev.data && typeof ev.data === "object" ? ev.data : {});
    return send(res, 200, { ok: true });
  }
  if (m === "GET" && p === "/api/logs") {
    const since = Number(url.searchParams.get("since") || 0);
    return send(res, 200, { seq: logSeq, events: recentLog.filter((e) => e.seq > since) });
  }

  if (m === "GET" && p === "/api/state") {
    return send(res, 200, {
      status: await read(STATUS_FILE),
      ladder: await read(LADDER_FILE),
      texFiles: await texFiles(),
      student: STUDENT,
      weeks: await listWeeks(),
      tectonic: !!findTectonic(),
      model: DEFAULT_MODEL,
      cas: casAvailable(),
      budget: BUDGET ? +BUDGET : null,
      corpusSize: loadCorpus().length,
    });
  }

  if (m === "PUT" && p === "/api/status") {
    const { text, backup = true } = await body(req);
    if (typeof text !== "string" || !text.trim()) return send(res, 400, { error: "empty status" });
    if (backup) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await fsp.copyFile(STATUS_FILE, path.join(BACKUPS, `weekly_status.${stamp}.md`));
    }
    await writeLikeOriginal(STATUS_FILE, text);
    return send(res, 200, { ok: true });
  }

  if (m === "GET" && p.startsWith("/api/tex/")) {
    const name = decodeURIComponent(p.slice(9));
    if (!TEX_NAME.test(name)) return send(res, 400, { error: "bad name" });
    return send(res, 200, { text: await read(path.join(ROOT, name)) });
  }

  if (m === "POST" && p === "/api/save-tex") {
    const { name, text, overwrite } = await body(req);
    if (!TEX_NAME.test(name || "")) return send(res, 400, { error: "Filename must look like hw_11_28_2026.tex" });
    const dest = path.join(ROOT, name);
    if (fs.existsSync(dest) && !overwrite) return send(res, 409, { error: `${name} already exists` });
    await fsp.writeFile(dest, text);
    return send(res, 200, { ok: true });
  }

  if (m === "POST" && p === "/api/compile") {
    const { text } = await body(req);
    if (typeof text !== "string") return send(res, 400, { error: "text required" });
    return send(res, 200, await compileTex(text));
  }

  if (m === "GET" && p.startsWith("/build/")) {
    const rel = path.normalize(p.slice(7));
    const f = path.join(BUILD, rel);
    if (!f.startsWith(BUILD + path.sep) || !f.endsWith(".pdf") || !fs.existsSync(f)) return send(res, 404, "not found", "text/plain");
    res.writeHead(200, { "Content-Type": "application/pdf", "Cache-Control": "max-age=31536000, immutable" });
    return res.end(await fsp.readFile(f));
  }

  // ---- corpus ----
  if (m === "GET" && p === "/api/corpus") {
    const items = loadCorpus();
    const q = url.searchParams;
    if (q.get("query") || q.get("units")) {
      const hits = searchCorpus(items, { units: q.get("units") || [], query: q.get("query") || "", limit: +(q.get("limit") || 50) });
      return send(res, 200, { items: hits.map((h) => ({ ...h.p, score: +h.score.toFixed(2) })) });
    }
    return send(res, 200, { items });
  }
  if (m === "GET" && p === "/api/corpus/preload") {
    const x = await corpusPreload();
    return send(res, 200, { ...x, hits: x.hits.map((h) => ({ id: h.p.id, score: +h.score.toFixed(2), why: h.why })) });
  }
  const cm = p.match(/^\/api\/corpus\/(p[0-9a-f]+)$/);
  if (cm && m === "PATCH") {
    const patch = await body(req);
    if (patch.status && !["candidate", "used", "favorite", "rejected"].includes(patch.status)) return send(res, 400, { error: "bad status" });
    const r = patchProblem(loadCorpus(), cm[1], patch);
    return r ? send(res, 200, r) : send(res, 404, { error: "no such problem" });
  }

  // ---- DAG ----
  if (m === "GET" && p === "/api/dag") {
    const [content, methods, st] = await Promise.all([readJson(path.join(DATA, "wu_dag.json"), null), readJson(path.join(DATA, "wu_methods_dag.json"), null), dagState()]);
    return send(res, 200, { content, methods, guess: st.guess, overrides: st.overrides || {}, job: guessJob && { ...guessJob, elapsed: guessJob.startedAt ? Date.now() - guessJob.startedAt : 0 }, notes: await noteFiles(), guessModel: GUESS_MODEL });
  }
  if (m === "PUT" && p === "/api/dag") {
    const { id, state, note } = await body(req);
    if (!/^(m:)?e\d+$/.test(id || "")) return send(res, 400, { error: "bad node id" });
    if (state != null && !["done", "partial", "not-yet"].includes(state)) return send(res, 400, { error: "bad state" });
    const st = await dagState();
    st.overrides ||= {};
    if (state == null) delete st.overrides[id];
    else st.overrides[id] = { state, note: note || "", at: new Date().toISOString() };
    await fsp.writeFile(DAG_STATE, JSON.stringify(st, null, 1));
    return send(res, 200, { overrides: st.overrides });
  }
  if (m === "POST" && p === "/api/dag/guess") {
    if (guessJob?.running) return send(res, 409, { error: "already guessing" });
    runGuess();
    return send(res, 200, { started: true });
  }
  if (m === "POST" && p === "/api/dag/guess/stop") { running.get("dag-guess")?.kill("SIGTERM"); return send(res, 200, { ok: true }); }

  // ---- notes (evidence for the DAG guess) ----
  if (m === "GET" && p === "/api/notes") return send(res, 200, { notes: await noteFiles() });
  if (m === "POST" && p === "/api/notes") {
    const { name, data } = await body(req);
    const clean = String(name || "").replace(/[^A-Za-z0-9 _.,()-]/g, "_");
    if (!NOTE_NAME.test(clean)) return send(res, 400, { error: "Notes must be .tex, .md, .txt, .pdf or an image" });
    const buf = Buffer.from(String(data || ""), "base64");
    if (!buf.length || buf.length > 30 << 20) return send(res, 400, { error: "empty or too large (30 MB max)" });
    await fsp.writeFile(path.join(NOTES, clean), buf);
    return send(res, 200, { notes: await noteFiles() });
  }
  const nm = p.match(/^\/(api\/)?notes\/([^/]+)$/);
  if (nm) {
    const name = decodeURIComponent(nm[2]);
    if (!NOTE_NAME.test(name) || name.includes("/")) return send(res, 400, { error: "bad name" });
    const f = path.join(NOTES, name);
    if (m === "DELETE" && nm[1]) { await fsp.rm(f, { force: true }); return send(res, 200, { notes: await noteFiles() }); }
    if (m === "GET" && !nm[1] && fs.existsSync(f)) return send(res, 200, await fsp.readFile(f), MIME[path.extname(f).toLowerCase()] || "application/octet-stream");
  }

  // ---- weeks ----
  if (m === "POST" && p === "/api/weeks") {
    const { title, model } = await body(req);
    const base = (title || "week").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "week";
    let id = base, n = 2;
    while (fs.existsSync(weekPath(id))) id = `${base}-${n++}`;
    const w = { id, title: title || id, createdAt: new Date().toISOString(), sessionId: randomUUID(), started: false, model: model || DEFAULT_MODEL, messages: [] };
    await saveWeek(w);
    return send(res, 200, w);
  }

  const wm = p.match(/^\/api\/weeks\/([A-Za-z0-9_-]+)(\/message|\/stop|\/finish|\/tools)?$/);
  if (wm) {
    const [, id, action] = wm;
    if (m === "GET" && !action) return send(res, 200, { ...(await loadWeek(id)), running: running.has(id), live: progress.get(id) || null });
    if (m === "GET" && action === "/tools") return send(res, 200, { calls: await readToolLog(id) });
    if (m === "DELETE" && !action) {
      for (const f of [weekPath(id), toolsPath(id), path.join(MCP_DIR, `${id}.json`)]) await fsp.rm(f, { force: true });
      return send(res, 200, { ok: true });
    }
    if (m === "POST" && action === "/finish") {
      // One click: save the .tex into the project, (optionally) the new weekly_status.md, and the problems into the corpus.
      const { name, tex, status, overwrite } = await body(req);
      if (!TEX_NAME.test(name || "")) return send(res, 400, { error: "Filename must look like hw_11_28_2026.tex" });
      const dest = path.join(ROOT, name);
      if (fs.existsSync(dest) && !overwrite) return send(res, 409, { error: `${name} already exists` });
      await fsp.writeFile(dest, tex);
      if (status && status.trim()) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await fsp.copyFile(STATUS_FILE, path.join(BACKUPS, `weekly_status.${stamp}.md`));
        await writeLikeOriginal(STATUS_FILE, status.trimEnd() + "\n");
      }
      const week = await loadWeek(id);
      let corpus = null;
      try { corpus = saveManifest(week, name, tex); tagInBackground(corpus.toTag || [], name); delete corpus.toTag; } catch (e) { corpus = { error: e.message }; }
      Object.assign(week, { done: true, savedAs: name, statusUpdated: !!(status && status.trim()), corpusSaved: corpus });
      await saveWeek(week);
      return send(res, 200, { ok: true, corpus });
    }
    if (m === "POST" && action === "/stop") { running.get(id)?.kill("SIGTERM"); return send(res, 200, { ok: true }); }
    if (m === "POST" && action === "/message") {
      if (running.has(id)) return send(res, 409, { error: "Claude is already working on this week" });
      const { text, kind } = await body(req);
      const week = await loadWeek(id);
      const sys = week.started ? null : await buildSystemPrompt();
      const userMsg = { role: "user", text, kind: kind || "chat", at: new Date().toISOString() };
      let prompt = text;
      if (kind === "start") {
        const pre = await corpusPreload();
        userMsg.preload = { count: pre.hits.length, units: pre.units, ids: pre.hits.map((h) => h.p.id) };
        prompt += `\n\n## Best corpus matches for this week (units ${pre.units.join(", ") || "none"}; ${loadCorpus().length} problems in the corpus)\n${formatHits(pre.hits)}`;
      }
      week.messages.push(userMsg);
      await saveWeek(week);

      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      const live = { text: "", tools: [], startedAt: Date.now() };
      progress.set(id, live);
      let clientGone = false;
      res.on("close", () => (clientGone = true));
      const emit = (e) => {
        if (e.type === "text") live.text += e.text;
        if (e.type === "tool") live.tools.push({ id: e.tool.id, name: e.tool.name, input: e.tool.input, textAt: live.text.length });
        if (e.type === "tool_result") { const t = live.tools.find((x) => x.id === e.tool.id); if (t) Object.assign(t, { ok: e.tool.ok, chars: e.tool.chars, ms: e.tool.ms }); }
        if (!clientGone) res.write(JSON.stringify(e.tool ? { type: e.type, name: e.tool.name } : e) + "\n");
      };
      const result = await runClaude(week, prompt, sys, emit);
      if (result.text || result.ok) {
        week.started = true;
        week.messages.push({ role: "assistant", text: result.text, at: new Date().toISOString(), error: result.ok ? undefined : result.error, usage: result.usage || undefined, tools: result.tools });
      } else {
        week.messages.pop(); // nothing happened; let the teacher retry
        week.lastError = result.error;
      }
      await saveWeek(week);
      progress.delete(id);
      emit(result.ok ? { type: "done" } : { type: "error", error: result.error });
      return res.end();
    }
  }

  // static files
  if (m === "GET") {
    const f = path.join(PUBLIC, p === "/" ? "index.html" : path.normalize(p));
    if (f.startsWith(PUBLIC) && fs.existsSync(f) && fs.statSync(f).isFile()) {
      return send(res, 200, await fsp.readFile(f), MIME[path.extname(f)] || "application/octet-stream");
    }
  }
  send(res, 404, { error: "not found" });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  http
    .createServer((req, res) => {
      const t0 = Date.now();
      const u = req.url.split("?")[0];
      // Static files and the log endpoints themselves would drown everything else out.
      if (u.startsWith("/api/") && u !== "/api/log" && u !== "/api/logs") res.on("finish", () => logEvent("http", `${req.method} ${u}`, { status: res.statusCode, ms: Date.now() - t0 }));
      handle(req, res).catch((e) => { logEvent("server", "error", { path: u, error: e.stack || e.message }); if (!res.headersSent) send(res, 500, { error: e.message }); else res.end(); });
    })
    .listen(PORT, "127.0.0.1", () => {
      console.log(`Homework UI: http://localhost:${PORT}  (event log: ${LOG_FILE})`);
      if (!findTectonic()) console.log("Note: Tectonic not found; PDF compile is disabled until you run `brew install tectonic`.");
      if (!casAvailable()) console.log("Note: CAS unavailable. Run: uv venv ui/data/venv && uv pip install --python ui/data/venv sympy");
    });
}
