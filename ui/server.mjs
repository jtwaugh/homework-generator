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
import { buildBrief, briefText, saveRulings, loadRulings } from "./lib/preflight.mjs";
import { claudeAuth, claudeEnv } from "./lib/auth.mjs";
import { createLogin, validHash } from "./lib/login.mjs";

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
// HW_HOST=0.0.0.0 to listen beyond this machine (for hosting); that requires HW_PASSWORD_HASH (see lib/login.mjs).
const HOST = process.env.HW_HOST || "127.0.0.1";
const PASSWORD_HASH = (process.env.HW_PASSWORD_HASH || "").trim();
const DEFAULT_MODEL = process.env.HW_MODEL || "claude-opus-5-5";
const GUESS_MODEL = process.env.HW_GUESS_MODEL || "claude-sonnet-5-5";
// Past sets sent with every run as style examples (older ones are in the corpus). Each adds ~2k tokens to every turn.
const GOLD_COUNT = Math.max(1, Number(process.env.HW_GOLD_FILES) || 3);
const BUDGET = process.env.HW_BUDGET_USD ? String(Number(process.env.HW_BUDGET_USD)) : null;
const ALLOWED_TOOLS = "WebSearch,WebFetch,mcp__hw__cas,mcp__hw__corpus_search,mcp__hw__corpus_add";

// ---------- stage routing: the cheapest model that does each part well ----------
// Taste-critical work (choosing and vetting problems, the checkpoint) stays on the main model. Research, writing
// out an approved outline, answer checking and compile fixes go to cheaper models, escalating one tier on failure.
const MODELS = { opus: DEFAULT_MODEL, sonnet: process.env.HW_SONNET_MODEL || "claude-sonnet-5-5", haiku: process.env.HW_HAIKU_MODEL || "claude-haiku-5-5" };
const NEXT_TIER = { [MODELS.haiku]: MODELS.sonnet, [MODELS.sonnet]: MODELS.opus };
export const STAGES = {
  research: { model: process.env.HW_RESEARCH_MODEL || MODELS.sonnet, tools: "WebSearch,WebFetch", allowed: "WebSearch,WebFetch,mcp__hw__corpus_search", effort: "medium", why: "web research for sections the corpus can't fill" },
  outline: { model: null, tools: "WebSearch,WebFetch", allowed: ALLOWED_TOOLS, why: "choose, adapt and vet problems; write the checkpoint" },
  final: { model: process.env.HW_WRITE_MODEL || MODELS.sonnet, tools: "", allowed: "mcp__hw__cas,mcp__hw__corpus_search", effort: "medium", why: "write the approved outline out as .tex + status + manifest" },
  fix: { model: process.env.HW_FIX_MODEL || MODELS.haiku, tools: "", allowed: "mcp__hw__cas", effort: "low", why: "compile/lint fixes" },
  verify: { model: process.env.HW_CHECK_MODEL || MODELS.haiku, tools: "", allowed: "mcp__hw__cas", effort: "low", why: "check every answer with sympy" },
};
const DRY_STAGES = process.env.HW_DRY_STAGES === "1";
// HW_STAGES_OFF=research,verify turns the extra stages off (e.g. to compare cost).
const STAGES_OFF = new Set((process.env.HW_STAGES_OFF || "").split(",").map((x) => x.trim()).filter(Boolean));
// Which stage handles a teacher message. Outline edits stay on the main model; anything after the final is a rewrite.
export function stageFor(kind, week) {
  if (kind === "start" || kind === "revise" || kind === "reply") return "outline";
  if (kind === "approve" || kind === "revise-final") return "final";
  if (kind === "fix") return "fix";
  return week.messages.some((m) => m.role === "assistant" && /```(latex|tex)\n/.test(m.text || "")) ? "final" : "outline";
}
export function modelFor(stage, week) {
  const base = STAGES[stage].model || week.model || DEFAULT_MODEL;
  // A second fix in a row means the cheap model didn't manage it: go up a tier.
  if (stage === "fix") {
    const lastUsers = week.messages.filter((m) => m.role === "user").slice(-2);
    if (lastUsers.length === 2 && lastUsers.every((m) => m.kind === "fix")) return NEXT_TIER[base] || base;
  }
  return base;
}
const hasBlock = (t) => /```(latex|tex)\n/.test(t || "");
// "**Assumptions**" list items from a checkpoint (one ruling each).
export function assumptionsOf(text) {
  const i = text.search(/\*\*Assumptions:?\*\*|^#+\s*Assumptions/im);
  if (i < 0) return [];
  const rest = text.slice(i).split("\n").slice(1);
  const out = [];
  for (const l of rest) { if (/^\s*[-*]\s+/.test(l)) out.push(l.replace(/^\s*[-*]\s+/, "").trim()); else if (out.length && (!l.trim() || /^\s*(\*\*|#)/.test(l))) break; else if (/^\s*(\*\*|#)/.test(l)) break; }
  return out.filter((t) => t.length > 8).slice(0, 20);
}
const isCheckpointText = (t) => /judgment calls|removed in audit|sourced ideas/i.test(t || "");
function mergeUsage(a, b) {
  if (!a) return b; if (!b) return a;
  const models = { ...a.models };
  for (const [k, v] of Object.entries(b.models || {})) { const o = models[k]; models[k] = o ? Object.fromEntries(Object.keys(v).map((f) => [f, (o[f] || 0) + (v[f] || 0)])) : v; }
  return { costUSD: (a.costUSD || 0) + (b.costUSD || 0), durationMs: (a.durationMs || 0) + (b.durationMs || 0), numTurns: (a.numTurns || 0) + (b.numTurns || 0), webSearches: (a.webSearches || 0) + (b.webSearches || 0), models };
}

for (const d of [WEEKS, BUILD, BACKUPS, CLAUDE_CWD, MCP_DIR, DEBUG, NOTES, LOGS]) fs.mkdirSync(d, { recursive: true });

const STATUS_FILE = path.join(ROOT, "weekly_status.md");
const INSTRUCTIONS_FILE = path.join(ROOT, "project_instructions.md");
const LADDER_FILE = path.join(ROOT, "curriculum_ladder.md");
// The student's name, shown in the UI and used in prompts. Set HW_STUDENT=<name>; the default is generic.
const STUDENT = (process.env.HW_STUDENT || "").trim();
// The curriculum's name, shown in the sidebar header. Set HW_CURRICULUM=<name> to change it.
const CURRICULUM = (process.env.HW_CURRICULUM || "").trim() || "Wu Algebra";
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
    "- You are running inside a local app, not a chat. The teacher's weekly_status.md is in the first user message, followed by the app's brief: decisions already made, standing rulings, a section plan and how well the corpus covers each section, and research notes for the sections it couldn't cover.",
    "- There is no opening question round in this app. Never reply with only questions, and never stop before the checkpoint. Whenever the workflow says to ask the teacher (missing fields, unit confirmations, definitions for a new unit, edge cases), make the most conservative reasonable choice, use it, and list it in the checkpoint: under **Assumptions** (one line each) for choices you made, and under **Needs your call** (at most 5) for the ones the teacher should rule on. For a new unit's definitions, use the standard precise definition in Wu's style, state it in the checkpoint, and avoid its edge cases. The checkpoint is the teacher's only chance to correct you, so make it complete.",
    "- Treat the brief's decisions and standing rulings as the teacher's answers. Never ask about them again.",
    "- Tools: web search, web fetch, and the app's own tools `cas`, `corpus_search` and `corpus_add`. There is no bash tool. The app compiles your .tex with Tectonic and will send you any errors or overfull-box warnings. In the final step, write \"not compiled (the app will compile it)\".",
    "- A separate checker re-verifies every answer with sympy after the final, and sends you any failures. Still use `cas` while vetting candidates for the checkpoint, and to verify every answer key entry in the final: substitute solutions back, check for extraneous roots, confirm factorizations. Batch the problems into a few calls that print one line per problem. In the final reply say how many answers you checked with the CAS.",
    "- Problem corpus: the teacher's cache of problems from past sets, earlier research and favorites. The first message includes the best matches for this week. Draw from the corpus first, and adapt rather than copy problems marked used (especially recent ones). Use `corpus_search` for more. Web search only for sections where the corpus has fewer than 3 suitable candidates. Whenever you find good problems on the web, call `corpus_add` with them, including ones you won't use this week. In the checkpoint, say which problems came from the corpus (by id) and which came from the web.",
    "- In the final step put the complete .tex in exactly one ```latex fenced block, and the complete updated weekly_status.md in exactly one ```markdown fenced block. The app extracts both.",
    "- After the .tex and status blocks, add one ```json fenced block: a problem manifest, an array with one object per \\item in the set, in the order they appear in the .tex: {\"part\": 1, \"n\": 3, \"answer\": \"...\", \"units\": [\"U14\"], \"source\": \"corpus:<id>\" or \"web:<url>\" or \"new\", \"casVerified\": true}. Don't repeat the problem text: the app reads it from the .tex. The app saves it to the corpus when the teacher saves the set.",
    "- If the teacher asks for changes after the final, always reply with the complete revised .tex, weekly_status.md and manifest again.",
  ].join("\n");
}

// ---------- running claude ----------

const running = new Map(); // key (weekId or "dag-guess") -> child process
const stopped = new Set(); // weeks whose teacher pressed Stop during a multi-stage message
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
    // The logged-in Claude subscription; ANTHROPIC_API_KEY only if there is none and HW_ALLOW_API_KEY=1 (lib/auth.mjs).
    const env = claudeEnv();

    const t0 = Date.now();
    const model = args[args.indexOf("--model") + 1];
    logEvent("claude", "start", { key, model, promptChars: prompt.length });
    const child = spawn("claude", args, { cwd, env });
    running.set(key, child);
    child.stdin.end(prompt);

    const texts = []; // complete assistant text blocks, in order
    const tools = []; // {id, name, input, at, ms, chars, ok, preview}
    let buf = "", stderr = "", resultError = null, usage = null, structured = null, sawThinkingDelta = false;

    const onLine = (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === "stream_event" && !ev.parent_tool_use_id) {
        const e = ev.event;
        if (e.type === "content_block_delta" && e.delta?.type === "text_delta") onEvent({ type: "text", text: e.delta.text });
        if (e.type === "content_block_delta" && e.delta?.type === "thinking_delta" && e.delta.thinking) { sawThinkingDelta = true; onEvent({ type: "thinking", text: e.delta.thinking }); }
        if (e.type === "content_block_start" && e.content_block?.type === "text" && texts.length) onEvent({ type: "text", text: "\n\n" });
      } else if (ev.type === "assistant" && !ev.parent_tool_use_id) {
        for (const b of ev.message.content || []) {
          if (b.type === "text" && b.text) texts.push(b.text);
          // Without --include-partial-messages the thinking only arrives here, whole.
          if (b.type === "thinking" && b.thinking && !sawThinkingDelta) onEvent({ type: "thinking", text: b.thinking + "\n\n" });
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
        structured = ev.structured_output ?? null;
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
      const out = { text, usage, structured, tools: tools.map(({ at, ...t }) => t) };
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

async function runClaude(week, prompt, systemPrompt, onEvent, stage = "outline") {
  const st = STAGES[stage];
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", modelFor(stage, week),
    "--tools", st.tools,
    "--allowedTools", st.allowed,
    "--mcp-config", await mcpConfigFor(week.id),
    "--strict-mcp-config",
    "--disable-slash-commands",
  ];
  if (BUDGET) args.push("--max-budget-usd", BUDGET);
  if (st.effort) args.push("--effort", st.effort);
  if (week.started) args.push("--resume", week.sessionId);
  else {
    // A run that died before replying may still have created this session; a retry needs a fresh id.
    week.sessionId = randomUUID();
    args.push("--session-id", week.sessionId, "--system-prompt", systemPrompt);
  }
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

// ---------- stages that run outside the week's session ----------

async function weekBrief(overrides = {}) {
  const [status, ladder] = await Promise.all([read(STATUS_FILE), read(LADDER_FILE)]);
  return buildBrief({ status, ladder, corpus: loadCorpus(), dataDir: DATA, overrides });
}

const RESEARCH_SCHEMA = {
  type: "object", required: ["problems"],
  properties: {
    problems: { type: "array", items: { type: "object", required: ["section", "tex"], properties: {
      section: { type: "string", description: "section key from the plan" }, tex: { type: "string", description: "original problem LaTeX, no \\item" },
      answer: { type: "string" }, units: { type: "array", items: { type: "string" } }, url: { type: "string" }, idea: { type: "string", description: "the source's idea and what you changed" },
      fromSnippet: { type: "boolean" } } } },
    rejected: { type: "array", items: { type: "object", properties: { url: { type: "string" }, reason: { type: "string" } } } },
    searchUnavailable: { type: "boolean" },
  },
};

// Research only the sections the corpus can't fill. Fresh session, cheaper model, structured output; the problems go
// into the corpus as candidates and the outline stage gets them as notes. Escalates one tier if the output is unusable.
async function runResearch(week, brief, onEvent) {
  const secs = brief.sections.filter((s) => brief.needsResearch.includes(s.key));
  if (!secs.length) return null;
  const instr = await read(INSTRUCTIONS_FILE);
  const rules = statusSection(instr, "## Hard gates") + "\n" + statusSection(instr, "## Vetting rubric for researched ideas") + "\n" + statusSection(instr, "## Variables") + "\n" + statusSection(instr, "**Research (every week).**".replace(/\*/g, ""));
  const prompt = [
    "You research problem ideas for a 5th grader's rigorous algebra homework (Wu style). Find good sources, open them, and write ORIGINAL problems based on their ideas. Do not ask questions; there is no one to answer them.",
    `Allowed units: ${brief.allowedUnits.join(", ")}. Everything else is off limits.`,
    "", "## Rules (from the teacher's instructions)", instr.includes("## Hard gates") ? rules : instr,
    "", "## Sections to research (the corpus is thin here)",
    ...secs.map((x) => `- key ${x.key}: ${x.title} [${x.units.join(", ")}] — ${x.kind}, need about ${x.target} problems; corpus has ${x.usable}.`),
    "", "Before searching, call corpus_search once per section to see what exists, so you don't duplicate it.",
    "Budget: about 3 searches per routine section, up to 6 for a rich one. Give 1.5x the needed count per section, each with its answer, its source URL and one line on the idea and what you changed. Mark fromSnippet if you could not open the page.",
    "Return only the structured result.",
  ].join("\n");
  let model = STAGES.research.model;
  for (let attempt = 0; attempt < 2; attempt++) {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", model, "--tools", STAGES.research.tools, "--allowedTools", STAGES.research.allowed,
      "--mcp-config", await mcpConfigFor(week.id), "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
      "--effort", STAGES.research.effort, "--json-schema", JSON.stringify(RESEARCH_SCHEMA)];
    if (BUDGET) args.push("--max-budget-usd", BUDGET);
    const r = await spawnClaude({ key: week.id, args, prompt, cwd: CLAUDE_CWD, onEvent: (e) => e.type !== "text" && onEvent(e) });
    const probs = r.structured?.problems;
    if (r.ok && Array.isArray(probs) && (probs.length || r.structured.searchUnavailable)) {
      const today = new Date().toISOString().slice(0, 10);
      const saved = addProblems(loadCorpus(), probs.map((x) => ({ tex: x.tex, answer: x.answer, units: x.units, status: "candidate", tags: ["research"],
        context: secs.find((s) => s.key === x.section)?.title || "", source: { kind: "web", url: x.url, note: x.idea, date: today, week: week.id, fromSnippet: !!x.fromSnippet } })));
      logEvent("stage", "research-done", { week: week.id, model, problems: probs.length, added: saved.added.length });
      return { model, usage: r.usage, tools: r.tools, result: r.structured, saved };
    }
    logEvent("stage", "research-retry", { week: week.id, model, error: r.error || "no structured problems" });
    if (!NEXT_TIER[model]) return { model, usage: r.usage, tools: r.tools, error: r.error || "research returned nothing" };
    model = NEXT_TIER[model];
  }
}
function researchNotes(res) {
  if (!res) return "";
  if (res.error) return `\n\n## Research notes\nThe research step failed (${res.error}). Do your own research for the thin sections.`;
  const r = res.result;
  return "\n\n## Research notes (from the app's research step; already vetted once, re-vet before adopting; saved to the corpus as candidates)\n" +
    (r.searchUnavailable ? "Web search was unavailable.\n" : "") +
    r.problems.map((x) => `- [${x.section}] ${x.tex.replace(/\s*\n\s*/g, " ")}${x.answer ? ` (answer: ${x.answer})` : ""} — ${x.url || "no url"}${x.fromSnippet ? " (from snippet)" : ""}${x.idea ? ` · ${x.idea}` : ""}`).join("\n") +
    (r.rejected?.length ? "\nRejected: " + r.rejected.map((x) => `${x.url}: ${x.reason}`).join("; ") : "");
}

const VERIFY_SCHEMA = {
  type: "object", required: ["checked", "failures"],
  properties: {
    checked: { type: "number" },
    failures: { type: "array", items: { type: "object", required: ["problem", "reason"], properties: { problem: { type: "string", description: "e.g. P2.3" }, reason: { type: "string" }, expected: { type: "string" } } } },
    unchecked: { type: "array", items: { type: "string" }, description: "problems that can't be checked by computation (proofs, graphs)" },
  },
};
// Independent answer check: a cheap model turns the manifest into one sympy script, runs it with `cas`, and reports.
export async function runVerify(week, text, onEvent) {
  const tex = extractBlocks(text, "latex")[0] || extractBlocks(text, "tex")[0];
  if (!tex) return null;
  const manifest = extractBlocks(text, "json").reverse().find((b) => { try { return Array.isArray(JSON.parse(b)); } catch { return false; } }) || "[]";
  const prompt = [
    "Check the answer key of this homework set by computation. Write ONE Python program (sympy) that, for every problem with a computable answer, re-derives the answer from the printed problem and compares it with the manifest. Print one line per problem: 'P<part>.<n> ok' or 'P<part>.<n> FAIL <why>'. Run it with the cas tool (fix and re-run if it crashes). Do not trust the manifest; work from the problem text. Then return the structured result: failures only for real mismatches.",
    "", "## Manifest", manifest, "", "## The set", "```latex", tex, "```",
  ].join("\n");
  let model = STAGES.verify.model;
  for (let attempt = 0; attempt < 2; attempt++) {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", model, "--tools", "", "--allowedTools", STAGES.verify.allowed,
      "--mcp-config", await mcpConfigFor(week.id), "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
      "--effort", STAGES.verify.effort, "--json-schema", JSON.stringify(VERIFY_SCHEMA)];
    const r = await spawnClaude({ key: week.id, args, prompt, cwd: CLAUDE_CWD, onEvent: (e) => e.type !== "text" && onEvent(e) });
    const usedCas = r.tools.some((t) => /cas$/.test(t.name) && t.ok);
    if (r.ok && r.structured && Array.isArray(r.structured.failures) && usedCas) {
      logEvent("stage", "verify-done", { week: week.id, model, checked: r.structured.checked, failures: r.structured.failures.length });
      return { model, usage: r.usage, tools: r.tools, ...r.structured };
    }
    logEvent("stage", "verify-retry", { week: week.id, model, error: r.error || (usedCas ? "bad output" : "did not run the CAS") });
    if (!NEXT_TIER[model]) return { model, usage: r.usage, tools: r.tools, error: r.error || "checker failed" };
    model = NEXT_TIER[model];
  }
}

// What each stage would do for a message, without running anything (logged; returned by HW_DRY_STAGES=1).
function planStages(kind, week, brief) {
  const stage = stageFor(kind, week);
  const out = [];
  if (kind === "start") out.push({ stage: "research", model: STAGES.research.model, skip: !brief.needsResearch.length, why: brief.needsResearch.length ? `corpus thin for ${brief.needsResearch.join(", ")}` : "corpus covers every section" });
  out.push({ stage, model: modelFor(stage, week), why: STAGES[stage].why });
  if (stage === "final" || stage === "fix") out.push({ stage: "verify", model: STAGES.verify.model, why: STAGES.verify.why });
  return out;
}

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

async function dagState() {
  const st = await readJson(DAG_STATE, { guess: null, overrides: {} });
  // Guesses made before run history existed: keep the last one as a run without a log.
  if (st.guess && !st.runs) {
    const g = st.guess, id = `${Date.parse(g.at) || 0}`;
    g.runId = id;
    st.runs = [{ id, at: g.at, model: g.model, ok: true, files: g.files, usage: g.usage || null, summary: g.summary || "", nodes: g.nodes, ladderToWu: g.ladderToWu || {}, log: [] }];
  }
  return st;
}
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
    "First write your reasoning under a \"## Reasoning\" heading, for the teacher to read later: go through the material in order (a few lines per ladder unit or group of nodes), saying what the homework and notes show and why you chose each state. Call out anything uncertain or where you disagree with weekly_status.md. Keep it under about 700 words.",
    "Then give one ```json fenced block with this shape:",
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

const MAX_RUNS = 50;
// One entry per thinking block, text block or tool call; consecutive deltas merge into one entry.
function guessLogger(log) {
  return (e) => {
    const last = log[log.length - 1];
    if (e.type === "thinking" || e.type === "text") {
      if (last?.t === e.type) last.text += e.text;
      else log.push({ t: e.type, text: e.text, at: Date.now() });
    } else if (e.type === "tool") {
      log.push({ t: "tool", id: e.tool.id, name: e.tool.name, input: e.tool.input?.file_path || short(e.tool.input, 200), at: Date.now() });
    } else if (e.type === "tool_result") {
      const t = log.find((x) => x.t === "tool" && x.id === e.tool.id);
      if (t) Object.assign(t, { ok: e.tool.ok, chars: e.tool.chars, ms: e.tool.ms });
    }
  };
}

async function saveRun(st, run) {
  st.runs = [run, ...(st.runs || [])].slice(0, MAX_RUNS);
  await fsp.writeFile(DAG_STATE, JSON.stringify(st, null, 1));
}

async function runGuess() {
  if (guessJob?.running) return;
  const log = [];
  const startedAt = Date.now();
  guessJob = { running: true, startedAt, tools: [], error: null, log };
  const onLog = guessLogger(log);
  let r = null;
  const files = (await texFiles()).length + (await noteFiles()).length;
  const base = () => ({ id: `${startedAt}`, at: new Date(startedAt).toISOString(), model: GUESS_MODEL, ms: Date.now() - startedAt, files, usage: r?.usage || null, log });
  try {
    const prompt = await buildGuessPrompt();
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", GUESS_MODEL, "--tools", "Read", "--allowedTools", "Read",
      "--add-dir", NOTES, "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"];
    r = await spawnClaude({ key: "dag-guess", args, prompt, cwd: NOTES, onEvent: (e) => { onLog(e); if (e.type === "tool") guessJob.tools.push(`${e.tool.name}: ${e.tool.input?.file_path || ""}`); } });
    if (!r.ok) throw new Error(r.error);
    let parsed = null;
    const candidates = [...extractBlocks(r.text, "json"), r.text.slice(r.text.indexOf("{"), r.text.lastIndexOf("}") + 1)];
    for (const b of candidates) {
      try { const x = JSON.parse(b); if (x?.nodes) { parsed = x; break; } } catch {}
    }
    if (!parsed) throw new Error("Claude's reply had no JSON nodes block");
    const st = await dagState();
    st.guess = { at: new Date().toISOString(), model: GUESS_MODEL, nodes: parsed.nodes, ladderToWu: parsed.ladderToWu || {}, summary: parsed.summary || "", usage: r.usage, files, runId: `${startedAt}` };
    await saveRun(st, { ...base(), ok: true, summary: st.guess.summary, nodes: parsed.nodes, ladderToWu: st.guess.ladderToWu });
    guessJob = { running: false, finishedAt: Date.now(), costUSD: r.usage?.costUSD || 0 };
    logEvent("dag", "guess-done", { nodes: Object.keys(parsed.nodes).length, costUSD: r.usage?.costUSD });
  } catch (e) {
    guessJob = { running: false, error: e.message };
    logEvent("dag", "guess-failed", { error: e.message });
    try { await saveRun(await dagState(), { ...base(), ok: false, error: e.message, summary: "" }); } catch {}
  }
}

const runSummary = (x) => ({ id: x.id, at: x.at, model: x.model, ok: x.ok, error: x.error, costUSD: x.usage?.costUSD || 0, files: x.files, summary: x.summary, ms: x.ms });

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
      curriculum: CURRICULUM,
      weeks: await listWeeks(),
      tectonic: !!findTectonic(),
      model: DEFAULT_MODEL,
      cas: casAvailable(),
      auth: claudeAuth(),
      login: !!PASSWORD_HASH,
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
  if (m === "GET" && p === "/api/brief") {
    // ?off=promote:U19,promote:U21 rejects those promotions.
    const overrides = Object.fromEntries((url.searchParams.get("off") || "").split(",").filter(Boolean).map((k) => [k, false]));
    const b = await weekBrief(overrides);
    return send(res, 200, { ...b, stagesPlan: planStages("start", { messages: [], model: DEFAULT_MODEL }, b), text: briefText(b) });
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
    return send(res, 200, { content, methods, guess: st.guess, overrides: st.overrides || {}, job: guessJob && { ...guessJob, elapsed: guessJob.startedAt ? Date.now() - guessJob.startedAt : 0 }, notes: await noteFiles(), guessModel: GUESS_MODEL, runs: (st.runs || []).map(runSummary) });
  }
  const rm = p.match(/^\/api\/dag\/runs\/(\d+)$/);
  if (m === "GET" && rm) {
    const run = ((await dagState()).runs || []).find((x) => x.id === rm[1]);
    return run ? send(res, 200, run) : send(res, 404, { error: "no such run" });
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
    if (m === "POST" && action === "/stop") { stopped.add(id); running.get(id)?.kill("SIGTERM"); return send(res, 200, { ok: true }); }
    if (m === "POST" && action === "/message") {
      if (running.has(id)) return send(res, 409, { error: "Claude is already working on this week" });
      const { text, kind, overrides } = await body(req);
      const week = await loadWeek(id);
      const sys = week.started ? null : await buildSystemPrompt();
      const userMsg = { role: "user", text, kind: kind || "chat", at: new Date().toISOString() };
      const stage = stageFor(userMsg.kind, week);
      let prompt = text, brief = null;
      if (kind === "start") {
        brief = await weekBrief(overrides || {});
        const corpus = loadCorpus(), byId = new Map(corpus.map((x) => [x.id, x]));
        const ids = [...new Set(brief.sections.flatMap((x) => x.corpusIds.slice(0, 10)))];
        const pre = await corpusPreload();
        for (const h of pre.hits) if (ids.length < 40 && !ids.includes(h.p.id)) ids.push(h.p.id);
        const hits = ids.map((i) => byId.get(i)).filter(Boolean).map((x) => ({ p: x, why: { recent: (x.usedOn || []).some((d) => Date.now() - Date.parse(d) < 42 * 864e5) } }));
        userMsg.preload = { count: hits.length, units: brief.allowedUnits, ids };
        userMsg.brief = { decisions: brief.decisions, sections: brief.sections.map(({ corpusIds, ...x }) => x), needsResearch: brief.needsResearch };
        prompt += `\n\n# Brief from the app (settled before you were called)\n${briefText(brief)}\n\n## Corpus problems for this week (${corpus.length} in the corpus; search for more with corpus_search)\n${formatHits(hits)}`;
      }
      if (DRY_STAGES) {
        const plan = planStages(userMsg.kind, week, brief || (await weekBrief(overrides || {})));
        logEvent("stage", "dry-run", { week: id, kind, plan });
        return send(res, 200, { dryRun: true, plan, promptChars: prompt.length, prompt: clip(prompt, 20000) });
      }
      if (kind === "start" && !week.started) week.messages = []; // a retry replaces the start that got no reply
      week.messages.push(userMsg);
      await saveWeek(week);

      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      // trace: everything in the order it happened: {k:"stage"|"think"|"say"|"tool", ...}. Tools are referenced by id.
      const live = { text: "", tools: [], trace: [], startedAt: Date.now() };
      const addTrace = (k, text) => { const last = live.trace.at(-1); if (last?.k === k) last.text += text; else live.trace.push({ k, text }); };
      progress.set(id, live);
      let clientGone = false;
      res.on("close", () => (clientGone = true));
      const emit = (e) => {
        if (e.type === "text") { live.text += e.text; addTrace("say", e.text); }
        if (e.type === "thinking") addTrace("think", e.text);
        if (e.type === "stage") live.trace.push({ k: "stage", stage: e.stage, model: e.model, at: Date.now() - live.startedAt });
        if (e.type === "tool") { live.tools.push({ id: e.tool.id, name: e.tool.name, input: e.tool.input, textAt: live.text.length }); live.trace.push({ k: "tool", id: e.tool.id }); }
        if (e.type === "tool_result") { const t = live.tools.find((x) => x.id === e.tool.id); if (t) Object.assign(t, { ok: e.tool.ok, chars: e.tool.chars, ms: e.tool.ms }); }
        if (!clientGone) res.write(JSON.stringify(e.tool ? { type: e.type, name: e.tool.name } : e) + "\n");
      };
      stopped.delete(id);
      const stages = []; // [{stage, model, costUSD, ...}] for this message, in order
      let usage = null, tools = [];
      const account = (st, model, r, extra = {}) => { stages.push({ stage: st, model, costUSD: r?.usage?.costUSD || 0, ...extra }); usage = mergeUsage(usage, r?.usage); tools = tools.concat(r?.tools || []); };
      const say = (st, model) => emit({ type: "stage", stage: st, model });

      // 1. Research (start only, and only for sections the corpus can't fill).
      if (brief?.needsResearch.length && !STAGES_OFF.has("research")) {
        say("research", STAGES.research.model);
        const r = await runResearch(week, brief, emit);
        account("research", r.model, r, { sections: brief.needsResearch, problems: r.result?.problems?.length || 0, error: r.error });
        prompt += researchNotes(r);
      }
      // 2. The routed turn in the week's session.
      let model = modelFor(stage, week);
      say(stage, model);
      let result = await runClaude(week, prompt, sys, emit, stage);
      account(stage, model, result);
      let preamble;
      if (result.text || result.ok) week.started = true;
      // 3. Safety net: an outline turn must end at the checkpoint, never at a list of questions.
      if (result.ok && stage === "outline" && !hasBlock(result.text) && !isCheckpointText(result.text) && !stopped.has(id)) {
        logEvent("stage", "auto-continue", { week: id });
        preamble = result.text;
        emit({ type: "text", text: "\n\n---\n\n" });
        say("outline", model);
        const r2 = await runClaude(week, "Nobody can answer questions in this app. For every question above, take the most conservative reasonable default yourself, list it under **Assumptions** (or **Needs your call** if the teacher must rule), and send the full checkpoint now.", null, emit, "outline");
        account("outline", model, r2, { auto: true });
        if (r2.text || r2.ok) result = { ...r2, text: r2.text || result.text };
      }
      // 4. Final-type turns: independent answer check, then one fix turn for real mismatches.
      let verify;
      if (result.ok && (stage === "final" || stage === "fix") && hasBlock(result.text) && !stopped.has(id) && !STAGES_OFF.has("verify")) {
        say("verify", STAGES.verify.model);
        const v = await runVerify(week, result.text, emit);
        if (v) {
          account("verify", v.model, v, { checked: v.checked, failures: v.failures?.length, error: v.error });
          verify = { model: v.model, checked: v.checked, failures: v.failures || [], unchecked: v.unchecked || [], error: v.error };
          if (v.failures?.length) {
            const fixModel = modelFor("final", week);
            say("final", fixModel);
            emit({ type: "text", text: "\n\n---\n\n" });
            const r3 = await runClaude(week, "An independent sympy check of the answer key found these problems:\n" + v.failures.map((f) => `- ${f.problem}: ${f.reason}${f.expected ? ` (expected ${f.expected})` : ""}`).join("\n") + "\nCheck each with cas. Fix the real errors (answer key or problem), ignore false alarms, and resend the full .tex, status and manifest. Say in one line per item what you did.", null, emit, "final");
            account("final", fixModel, r3, { auto: true, reason: "verify" });
            if (r3.ok && hasBlock(r3.text)) { preamble = result.text; result = r3; verify.fixed = true; }
          }
        }
      }
      // 5. On approval, the checkpoint's assumptions become standing rulings.
      if (kind === "approve") {
        const cp = [...week.messages].reverse().find((m) => m.role === "assistant" && isCheckpointText(m.text));
        const add = assumptionsOf(cp?.text || "").map((t) => ({ text: t, week: id }));
        if (add.length) { try { saveRulings(DATA, add); } catch (e) { logEvent("stage", "rulings-error", { error: e.message }); } }
      }
      if (result.text || result.ok) {
        week.messages.push({ role: "assistant", text: result.text, at: new Date().toISOString(), error: result.ok ? undefined : result.error, usage: usage || undefined, tools, trace: live.trace, stage, model, stages, ...(preamble ? { preamble } : {}), ...(verify ? { verify } : {}) });
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
  const loopback = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/.test(HOST);
  if (PASSWORD_HASH && !validHash(PASSWORD_HASH)) { console.error("HW_PASSWORD_HASH isn't a hash from `node ui/scripts/hash-password.mjs`."); process.exit(1); }
  if (!loopback && !PASSWORD_HASH) { console.error(`Refusing to listen on ${HOST} without a login. Set HW_PASSWORD_HASH (node ui/scripts/hash-password.mjs).`); process.exit(1); }
  const login = createLogin({ hash: PASSWORD_HASH, dataDir: DATA, trustProxy: process.env.HW_TRUST_PROXY === "1" });
  http
    .createServer(async (req, res) => {
      const t0 = Date.now();
      try { if (await login.gate(req, res)) return; } catch (e) { if (!res.headersSent) send(res, 500, { error: e.message }); return; }
      const u = req.url.split("?")[0];
      // Static files and the log endpoints themselves would drown everything else out.
      if (u.startsWith("/api/") && u !== "/api/log" && u !== "/api/logs") res.on("finish", () => logEvent("http", `${req.method} ${u}`, { status: res.statusCode, ms: Date.now() - t0 }));
      handle(req, res).catch((e) => { logEvent("server", "error", { path: u, error: e.stack || e.message }); if (!res.headersSent) send(res, 500, { error: e.message }); else res.end(); });
    })
    .listen(PORT, HOST, () => {
      console.log(`Homework UI: http://${loopback ? "localhost" : HOST}:${PORT}  (event log: ${LOG_FILE})`);
      console.log(login.enabled ? "Login: password required" : "Login: off (local only)");
      if (!findTectonic()) console.log("Note: Tectonic not found; PDF compile is disabled until you run `brew install tectonic`.");
      const auth = claudeAuth();
      console.log(auth.mode === "subscription" ? `Claude: subscription (${auth.plan || "logged in"})` : `Claude: ${auth.mode}`);
      if (auth.note) console.log("Note: " + auth.note);
      if (!casAvailable()) console.log("Note: CAS unavailable. Run: uv venv ui/data/venv && uv pip install --python ui/data/venv sympy");
    });
}
