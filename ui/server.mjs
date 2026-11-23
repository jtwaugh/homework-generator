// Local UI for the weekly homework generator.
// Calls Claude through the Anthropic API (lib/agent.mjs; needs ANTHROPIC_API_KEY) and compiles LaTeX with
// Tectonic. Dependency: @anthropic-ai/sdk (npm install).
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
import { loadCorpus, saveCorpus, searchCorpus, formatHits, addProblems, patchProblem, dateFromName, tokenize, attachTex, problemId, nearDuplicates } from "./lib/corpus.mjs";
import { ctx, loadCorpusDb, saveStatus, latestStatus, statusHistory, recordAssignment, setActiveEnrollment } from "./lib/store.mjs";
import { closeDb, getSetting, setSetting } from "./lib/db.mjs";
import * as Cur from "./lib/curriculum.mjs";
import * as Prog from "./lib/progress.mjs";
import { buildBrief, briefText, saveRulings, loadRulings } from "./lib/preflight.mjs";
import { claudeAuth } from "./lib/auth.mjs";
import { runAgent, makeClient, addUserTurn } from "./lib/agent.mjs";
import { agentTools, casRemote } from "./lib/tools.mjs";
import { createMirror, blobStore, blobConfigured } from "./lib/mirror.mjs";
import { createLogin, validHash } from "./lib/login.mjs";

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
// HW_ROOT / HW_DATA point the app at another copy of the files (dev/sandbox.mjs makes one for tests).
const ROOT = process.env.HW_ROOT ? path.resolve(process.env.HW_ROOT) : path.resolve(UI_DIR, "..");
const PUBLIC = path.join(UI_DIR, "public");
const DATA = process.env.HW_DATA ? path.resolve(process.env.HW_DATA) : path.join(UI_DIR, "data");
const WEEKS = path.join(DATA, "weeks");
const BUILD = path.join(DATA, "build");
const MCP_DIR = path.join(DATA, "mcp");
const DEBUG = path.join(DATA, "debug");
const NOTES = path.join(DATA, "notes");
const LOGS = path.join(DATA, "logs");
const VENV_PY = path.join(DATA, "venv", "bin", "python");
const PORT = Number(process.env.PORT || 4747);
// HW_HOST=0.0.0.0 to listen beyond this machine (for hosting); that requires HW_PASSWORD_HASH (see lib/login.mjs).
const HOST = process.env.HW_HOST || "127.0.0.1";
const PASSWORD_HASH = (process.env.HW_PASSWORD_HASH || "").trim();
const DEFAULT_MODEL = process.env.HW_MODEL || "claude-opus-5-5";
const GUESS_MODEL = process.env.HW_GUESS_MODEL || "claude-sonnet-5-5";
// Past sets sent with every run as style examples (older ones are in the corpus). Each adds ~2k tokens to every turn.
const GOLD_COUNT = Math.max(1, Number(process.env.HW_GOLD_FILES) || 3);
const BUDGET = process.env.HW_BUDGET_USD ? String(Number(process.env.HW_BUDGET_USD)) : null;
// Every turn of a week's conversation declares the same tools (replayed thinking is tied to the tool list);
// each stage's `allowed` list decides which of our tools it may actually run.
const WEEK_TOOLS = ["cas", "corpus_search", "corpus_add"];
const WEEK_SERVER = ["WebSearch", "WebFetch"];
const allowedOf = (st) => st.allowed.split(",").filter(Boolean).map((n) => n.replace(/^mcp__hw__/, ""));
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

const JOBS = path.join(DATA, "jobs");
for (const d of [WEEKS, BUILD, MCP_DIR, DEBUG, NOTES, LOGS, JOBS]) fs.mkdirSync(d, { recursive: true });

const STATUS_FILE = path.join(ROOT, "weekly_status.md");
const INSTRUCTIONS_FILE = path.join(ROOT, "project_instructions.md");
const LADDER_FILE = path.join(ROOT, "curriculum_ladder.md");
// Students, curricula, progress, the corpus and status history live in DATA/hw.db (lib/store.mjs); the first
// open migrates the v0 files. HW_STUDENT names the first student at migration; HW_CURRICULUM overrides the
// sidebar title. weekly_status.md and curriculum_ladder.md at ROOT are exports of the active enrollment.
const STUDENT_ENV = (process.env.HW_STUDENT || "").trim();
const CURRICULUM_ENV = (process.env.HW_CURRICULUM || "").trim();
const C = () => ctx({ dir: DATA });
// The two Wu DAGs ship with the code. With DATA elsewhere (hosted: /tmp), copy them in on every start.
const BUNDLED_DATA = ["wu_dag.json", "wu_methods_dag.json"];
if (path.resolve(DATA) !== path.join(UI_DIR, "data")) for (const f of BUNDLED_DATA) { const src = path.join(UI_DIR, "data", f); if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DATA, f)); }
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

// ---------- hosting: durable storage and background work ----------
// When hosted on Vercel (a Blob store connected), ROOT and DATA are /tmp folders mirrored to Blob
// (lib/mirror.mjs): pulled before each API request, pushed after writes and after background work.
// Caches, builds and logs stay local to the instance.
export const mirror = createMirror({
  roots: { root: ROOT, data: DATA },
  store: process.env.VERCEL && blobConfigured() ? blobStore() : null,
  // Production and preview deployments share a store; previews keep their own copy so testing can't touch it.
  base: process.env.HW_BLOB_PREFIX || (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production" ? `hw-${process.env.VERCEL_ENV}` : "hw"),
  skip: (rel, pre) => pre === "data" && (/^(build|logs|debug|mcp|venv|claude-cwd)\//.test(rel) || /^hw\.db-(wal|shm|journal)$/.test(rel) || BUNDLED_DATA.includes(rel)),
  // A pulled hw.db replaces the file under the open connection: close it first, the next ctx() reopens.
  beforeReplace: (f) => { if (path.basename(f) === "hw.db") closeDb(DATA); },
});
// Work that outlives its request (tagging, the progress-map guess). The Vercel entry swaps in waitUntil so
// the instance stays up until it finishes.
let keepAlive = (p) => p;
export const setKeepAlive = (fn) => { keepAlive = fn; };
function background(fn) {
  const p = Promise.resolve().then(fn).catch((e) => logEvent("server", "background-error", { error: e.message })).finally(() => mirror.push().catch((e) => logEvent("mirror", "push-error", { error: e.message })));
  keepAlive(p);
  return p;
}
// Job state other instances can see: data/jobs/<key>.json (state, refreshed while running) and <key>.stop.
// Only used when mirrored; on one machine the in-memory maps are the whole story.
const jobFile = (key, ext = "json") => path.join(JOBS, `${key}.${ext}`);
const shareThrottle = new Map();
async function shareJob(key, state, { force = false } = {}) {
  if (!mirror.enabled) return;
  const now = Date.now();
  if (!force && now - (shareThrottle.get(key) || 0) < 2000) return;
  shareThrottle.set(key, now);
  try {
    await fsp.writeFile(jobFile(key), JSON.stringify({ ...state, sharedAt: now }));
    await mirror.putNow(jobFile(key));
  } catch (e) { logEvent("mirror", "share-error", { key, error: e.message }); }
}
async function remoteJob(key) {
  if (!mirror.enabled) return null;
  try {
    const b = await mirror.fetchNow(jobFile(key));
    const j = b && JSON.parse(b);
    return j && j.running && Date.now() - j.sharedAt < 90000 ? j : null; // a dead instance stops refreshing
  } catch { return null; }
}
async function requestStop(key) {
  if (!mirror.enabled) return;
  await fsp.writeFile(jobFile(key, "stop"), "1");
  await mirror.putNow(jobFile(key, "stop")).catch(() => {});
}
async function clearStop(key) {
  if (!mirror.enabled) return;
  await fsp.rm(jobFile(key, "stop"), { force: true });
  await mirror.delNow(jobFile(key, "stop")).catch(() => {});
}
async function writeLikeOriginal(p, text) {
  const orig = fs.existsSync(p) ? await fsp.readFile(p, "utf8") : "";
  const out = text.replace(/\r\n/g, "\n");
  await fsp.writeFile(p, orig.includes("\r\n") ? out.replace(/\n/g, "\r\n") : out);
}

// ---------- weekly status and lesson plan: hw.db, exported to the root files ----------
// Editing weekly_status.md by hand still works: a file newer than the latest revision becomes a revision.
// The root files belong to the active (working-on) enrollment only. Another enrollment's status and ladder are
// read from and written to hw.db without touching them (a week finished after switching students).
const isActive = (c) => c.enrollmentId === C().enrollmentId;
const weekCtx = (week) => (week?.enrollmentId ? ctx({ dir: DATA, enrollment: week.enrollmentId }) : C());
async function readStatus(c = C()) {
  const last = latestStatus(c);
  if (!isActive(c)) return last?.text ?? "";
  let file = null;
  try { file = await read(STATUS_FILE); } catch {}
  if (file != null && file !== last?.text && (!last || fs.statSync(STATUS_FILE).mtimeMs > Date.parse(last.at) + 1000)) {
    saveStatus(c, file, { source: "file" });
    return file;
  }
  if (last && file !== last.text) await writeLikeOriginal(STATUS_FILE, last.text);
  return last?.text ?? file ?? "";
}
async function writeStatus(text, { source = "teacher", assignmentId = null, c = C() } = {}) {
  const id = saveStatus(c, text, { source, assignmentId });
  if (isActive(c)) await writeLikeOriginal(STATUS_FILE, text);
  return id;
}
// The lesson plan the prompts use is the active enrollment's version. A hand edit of curriculum_ladder.md
// (the file no longer matches what was last exported) goes into the curriculum's draft for review.
const sha = (t) => createHash("sha256").update(t).digest("hex").slice(0, 16);
async function readLadder(c = C()) {
  const md = Cur.ladderFor(c.db, c.versionId);
  if (!isActive(c)) return md;
  let file = null;
  try { file = await read(LADDER_FILE); } catch {}
  const exported = getSetting(c.db, "ladder_export_hash");
  if (file === md) { if (exported !== sha(md)) setSetting(c.db, "ladder_export_hash", sha(md)); return md; }
  // Missing, or still what we last wrote: bring it up to date. Anything else is a hand edit and is never overwritten.
  if (file == null || sha(file) === exported) { await writeLikeOriginal(LADDER_FILE, md); setSetting(c.db, "ladder_export_hash", sha(md)); return md; }
  if (getSetting(c.db, "ladder_drift_hash") !== sha(file)) {
    const d = Cur.createDraft(c.db, c.curriculumId, { origin: "edit", note: "curriculum_ladder.md edited by hand" });
    Cur.editDraft(c.db, d, [{ op: "setLadder", md: file }]);
    setSetting(c.db, "ladder_drift_hash", sha(file));
    logEvent("curriculum", "ladder-drift", { draft: Cur.getVersion(c.db, d).seq });
  }
  return md;
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
// Tectonic downloads TeX support files on demand into its cache; hosted, only /tmp is writable.
const TEX_ENV = process.env.VERCEL ? { PATH: process.env.PATH, HOME: "/tmp", XDG_CACHE_HOME: "/tmp/cache" } : process.env;
function findTectonic() {
  if (tectonicPath !== undefined) return tectonicPath;
  // bin/tectonic: the static Linux build the Vercel build step downloads (scripts/vercel-build.mjs).
  for (const c of [process.env.HW_TECTONIC, path.join(UI_DIR, "..", "bin", "tectonic"), "tectonic", "/opt/homebrew/bin/tectonic", "/usr/local/bin/tectonic"].filter(Boolean)) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8", env: TEX_ENV });
    if (r.status === 0) return (tectonicPath = c);
  }
  return (tectonicPath = null);
}
let casOk = null;
const casAvailable = () => (casOk ??= !!casRemote() || fs.existsSync(VENV_PY) && spawnSync(VENV_PY, ["-c", "import sympy"], { timeout: 30000 }).status === 0);

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
// The API conversation for a week: {system, messages}, with thinking blocks and tool results as the API returned them.
const convoPath = (id) => path.join(WEEKS, `${id}.convo.json`);

async function loadWeek(id) {
  if (!WEEK_ID.test(id)) throw new Error("bad week id");
  return JSON.parse(await read(weekPath(id)));
}
async function saveWeek(w) {
  await fsp.writeFile(weekPath(w.id), JSON.stringify(w, null, 2));
}
const weekCost = (w) => w.messages.reduce((s, m) => s + (m.usage?.costUSD || 0), 0);
// enrollmentId: the student × course a week belongs to (stamped at creation; older weeks: their assignment's,
// else the first enrollment, which is the one the v0 migration created).
async function listWeeks() {
  const { db } = C();
  const owner = new Map(db.prepare("SELECT id, enrollment_id FROM assignment").all().map((r) => [r.id, r.enrollment_id]));
  const first = db.prepare("SELECT MIN(id) id FROM enrollment").get()?.id ?? null;
  const out = [];
  for (const f of await fsp.readdir(WEEKS)) {
    if (!f.endsWith(".json")) continue;
    try {
      const w = JSON.parse(await read(path.join(WEEKS, f)));
      out.push({ id: w.id, title: w.title, createdAt: w.createdAt, turns: w.messages.length, done: !!w.done, savedAs: w.savedAs || null, model: w.model, costUSD: weekCost(w), enrollmentId: w.enrollmentId ?? owner.get(w.id) ?? first });
    } catch {}
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
async function readToolLog(id) {
  try { return (await read(toolsPath(id))).split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { return []; }
}

async function buildSystemPrompt(c = C()) {
  const [instr, ladder] = await Promise.all([read(INSTRUCTIONS_FILE), readLadder(c)]);
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

const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s);

let apiClient = null;
const client = () => (apiClient ??= makeClient());

// One agent run (lib/agent.mjs). Registered in `running` under `key` so Stop can abort it.
async function callAgent({ key, weekId = "", model, system, messages, toolNames = [], allow = null, server = [], effort, schema, binding = false, onEvent = () => {} }) {
  const ac = new AbortController();
  running.set(key, ac);
  const t0 = Date.now();
  // Hosted: Stop may land on another instance; it leaves a flag in Blob that we poll for.
  const poll = mirror.enabled && setInterval(async () => {
    if (await mirror.fetchNow(jobFile(key, "stop")).catch(() => null)) { stopped.add(key); ac.abort(); }
  }, 3000);
  try {
    const r = await runAgent({
      client: client(), model, system, messages, tools: agentTools(weekId, { names: toolNames }), allow, server, effort, schema, binding,
      budgetUSD: BUDGET ? Number(BUDGET) : Infinity, signal: ac.signal, onEvent,
      log: (event, d) => logEvent("claude", event, { key, ...d }),
    });
    logEvent("claude", "exit", { key, ms: Date.now() - t0, chars: r.text.length, tools: r.tools.length, error: r.error ? short(r.error, 300) : undefined });
    return r;
  } catch (e) {
    logEvent("claude", "exit", { key, ms: Date.now() - t0, error: short(e.message, 300) });
    return { ok: false, error: e.message, text: "", usage: null, structured: null, tools: [] };
  } finally {
    if (poll) clearInterval(poll);
    if (running.get(key) === ac) running.delete(key);
  }
}

// A turn in the week's conversation. The system prompt is fixed at the first turn and replayed unchanged.
async function runClaude(week, prompt, systemPrompt, onEvent, stage = "outline") {
  const st = STAGES[stage];
  let convo = week.started ? await readJson(convoPath(week.id), null) : null;
  if (!convo) convo = { system: systemPrompt || (await buildSystemPrompt()), messages: legacyHistory(week) };
  const before = convo.messages.length;
  addUserTurn(convo.messages, prompt);
  const r = await callAgent({
    key: week.id, weekId: week.id, model: modelFor(stage, week), system: convo.system, messages: convo.messages,
    toolNames: WEEK_TOOLS, allow: allowedOf(st), server: WEEK_SERVER, effort: st.effort, binding: true, onEvent,
  });
  // Nothing came back: leave the conversation as it was so a retry starts clean.
  if (!r.ok && !r.text) convo.messages.length = before;
  await fsp.writeFile(convoPath(week.id), JSON.stringify(convo));
  return r;
}

// Weeks started under the old `claude -p` sessions have no saved conversation: rebuild it from the chat text.
function legacyHistory(week) {
  if (!week.started) return [];
  const out = [];
  for (const m of week.messages.slice(0, -1)) if (m.text) pushTurn(out, m.role, m.text);
  return out;
}
function pushTurn(out, role, text) {
  if (role === "user") return addUserTurn(out, text);
  const last = out.at(-1);
  if (!last) return; // a conversation must start with a user turn
  if (last.role === "assistant") last.content.push({ type: "text", text });
  else out.push({ role: "assistant", content: [{ type: "text", text }] });
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
      const child = spawn(tec, ["--keep-logs", "--outdir", dir, path.join(dir, "hw.tex")], { env: TEX_ENV });
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

async function weekBrief(overrides = {}, c = C()) {
  const [status, ladder] = await Promise.all([readStatus(c), readLadder(c)]);
  return buildBrief({ status, ladder, corpus: loadCorpusDb(c), dataDir: DATA, overrides });
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
    const r = await callAgent({ key: week.id, weekId: week.id, model, messages: [{ role: "user", content: prompt }], toolNames: allowedOf(STAGES.research),
      server: STAGES.research.tools.split(",").filter(Boolean), effort: STAGES.research.effort, schema: RESEARCH_SCHEMA, onEvent: (e) => e.type !== "text" && onEvent(e) });
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
    const r = await callAgent({ key: week.id, weekId: week.id, model, messages: [{ role: "user", content: prompt }], toolNames: allowedOf(STAGES.verify),
      effort: STAGES.verify.effort, schema: VERIFY_SCHEMA, onEvent: (e) => e.type !== "text" && onEvent(e) });
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

async function corpusPreload(c = C()) {
  const [status, ladder] = await Promise.all([readStatus(c), readLadder(c)]);
  const q = preloadQuery(status, ladder);
  const hits = searchCorpus(loadCorpusDb(c), { units: q.units, query: q.query, limit: 15 });
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
    tex: p.tex, answer: p.answer, units: p.units, tags: p.tags, casVerified: p.casVerified, status: "used",
    context: p.part ? `Part ${p.part}` : "", source: { kind: "final", file: name, date, week: week.id, origin: p.source },
  })), { file: false });
  // The set's problems become this student's assignment; a corpus problem it was adapted from counts as used too.
  const rows = [];
  for (const p of list) {
    const pid = problemId(p.tex);
    const own = items.find((x) => x.id === pid || (x.aliases || []).includes(pid)) || nearDuplicates(items, p.tex)[0];
    if (own) rows.push({ problemId: own.id, part: p.part, n: p.n, answer: p.answer, sourceRef: p.source || null, casVerified: p.casVerified });
    const m = String(p.source || "").match(/^corpus:(p[0-9a-f]+)/);
    const orig = m && items.find((x) => x.id === m[1]);
    if (orig) { if (orig.status === "candidate") orig.status = "used"; rows.push({ problemId: orig.id, sourceRef: `adapted into ${own?.id || "?"}` }); }
  }
  saveCorpus(items);
  recordAssignment(weekCtx(week), { id: week.id, title: week.title, date, model: week.model, sessionId: week.sessionId, savedAs: name, transcriptPath: `weeks/${week.id}.json`, items: rows });
  const ids = [...r.added, ...r.merged].filter((id) => needsTags(items.find((x) => x.id === id) || {}));
  return { added: r.added.length, merged: r.merged.length, total: list.length, toTag: ids };
}

// Tag problems with Wu content and methods nodes in the background (one cheap pass), then patch the corpus.
// The corpus is re-read before writing, so edits made meanwhile are kept.
let tagChain = Promise.resolve();
export function tagInBackground(ids, label) {
  if (!ids.length || process.env.HW_NO_TAG) return;
  const job = tagChain.then(async () => {
    const probs = loadCorpus().filter((p) => ids.includes(p.id)).map((p) => structuredClone(p));
    logEvent("tag", "start", { label, problems: probs.length, model: TAG_MODEL });
    try {
      const r = await tagProblems(probs);
      const items = loadCorpus();
      for (const p of probs) patchProblem(items, p.id, { units: p.units, wuNodes: p.wuNodes, tags: p.tags }, { file: false });
      saveCorpus(items, null, { source: "tagger" });
      logEvent("tag", "done", { label, tagged: r.tagged, withMethods: probs.filter((p) => p.wuNodes.some((n) => n.startsWith("m:"))).length, costUSD: +r.cost.toFixed(4) });
    } catch (e) { logEvent("tag", "error", { label, error: e.message.slice(0, 300) }); }
  });
  tagChain = job;
  background(() => job);
}

// ---------- Wu DAG: snapshot + the student's progress ----------

// {guess, overrides, runs} for the active enrollment at a version (lib/progress.mjs).
const dagState = (c = C(), versionId = null) => Prog.dagState(c.db, c.enrollmentId, versionId ?? c.versionId);
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
  const c = C();
  const content = Cur.graphFor(c.db, c.versionId, "content"), methods = Cur.graphFor(c.db, c.versionId, "methods");
  const [ladder, status] = await Promise.all([readLadder(c), readStatus(c)]);
  const STUDENT = c.studentName;
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
    binary.length ? `- Also use the uploaded note files attached after this text: ${binary.map((b) => b.name).join(", ")}` : "",
    "",
    "## Wu content DAG (arrow A -> B: A is used for B)", nodeLines(content, ""), "", edgeLines(content, ""),
    "", "## Wu methods DAG (arrow A -> B: A is used as a sub-step of B; 'rests on' = content node)", nodeLines(methods, "m:"), "", edgeLines(methods, "m:"),
    "", "## Curriculum ladder", ladder, "", "## weekly_status.md", status, "", "## Evidence files", ...files,
  ].join("\n");
}

// Uploaded images and PDFs go to Claude as content blocks (it used to open them with the CLI's Read tool).
const MEDIA = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf" };
async function noteAttachments() {
  const out = [];
  for (const n of (await noteFiles()).filter((x) => !TEXT_NOTE.test(x.name))) {
    const type = MEDIA[n.name.split(".").pop().toLowerCase()];
    if (!type) { out.push({ type: "text", text: `(note ${n.name} is in a format Claude can't read; ignore it)` }); continue; }
    const data = (await fsp.readFile(path.join(NOTES, n.name))).toString("base64");
    out.push({ type: "text", text: `Uploaded note: ${n.name}` });
    out.push(type === "application/pdf" ? { type: "document", source: { type: "base64", media_type: type, data }, title: n.name } : { type: "image", source: { type: "base64", media_type: type, data } });
  }
  return out;
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

// Runs are kept per enrollment, against the version the prompt was built from.
function saveRun(c, run) { Prog.saveGuessRun(c.db, c.enrollmentId, { ...run, versionId: c.versionId }); }

async function runGuess() {
  if (guessJob?.running) return;
  const log = [];
  const startedAt = Date.now();
  guessJob = { running: true, startedAt, tools: [], error: null, log };
  await clearStop("dag-guess");
  shareJob("dag-guess", guessJob, { force: true });
  const heartbeat = setInterval(() => shareJob("dag-guess", guessJob), 5000);
  const logLine = guessLogger(log);
  const onLog = (e) => { logLine(e); shareJob("dag-guess", guessJob); };
  let r = null;
  const c = C();
  const files = (await texFiles()).length + (await noteFiles()).length;
  const base = () => ({ id: `${startedAt}`, at: new Date(startedAt).toISOString(), model: GUESS_MODEL, ms: Date.now() - startedAt, files, usage: r?.usage || null, log });
  try {
    const content = [{ type: "text", text: await buildGuessPrompt() }, ...(await noteAttachments())];
    r = await callAgent({ key: "dag-guess", model: GUESS_MODEL, messages: [{ role: "user", content }], onEvent: onLog });
    if (!r.ok) throw new Error(r.error);
    let parsed = null;
    const candidates = [...extractBlocks(r.text, "json"), r.text.slice(r.text.indexOf("{"), r.text.lastIndexOf("}") + 1)];
    for (const b of candidates) {
      try { const x = JSON.parse(b); if (x?.nodes) { parsed = x; break; } } catch {}
    }
    if (!parsed) throw new Error("Claude's reply had no JSON nodes block");
    saveRun(c, { ...base(), ok: true, summary: parsed.summary || "", nodes: parsed.nodes, ladderToWu: parsed.ladderToWu || {} });
    guessJob = { running: false, finishedAt: Date.now(), costUSD: r.usage?.costUSD || 0 };
    logEvent("dag", "guess-done", { nodes: Object.keys(parsed.nodes).length, costUSD: r.usage?.costUSD });
  } catch (e) {
    guessJob = { running: false, error: e.message };
    logEvent("dag", "guess-failed", { error: e.message });
    try { saveRun(c, { ...base(), ok: false, error: e.message, summary: "" }); } catch {}
  } finally {
    clearInterval(heartbeat);
    await shareJob("dag-guess", guessJob, { force: true });
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
    const c = C();
    return send(res, 200, {
      status: await readStatus(c),
      ladder: await readLadder(c),
      texFiles: await texFiles(),
      student: c.studentName || STUDENT_ENV,
      curriculum: CURRICULUM_ENV || c.db.prepare("SELECT title FROM curriculum WHERE id = ?").get(c.curriculumId)?.title || "Wu Algebra",
      enrollment: { id: c.enrollmentId, curriculum: c.curriculumId, version: Cur.getVersion(c.db, c.versionId)?.seq },
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
    const { text } = await body(req);
    if (typeof text !== "string" || !text.trim()) return send(res, 400, { error: "empty status" });
    await writeStatus(text, { source: "teacher" });
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
    // ?version=<id> shows another version of the curriculum (progress carried forward through lineage).
    const c = C();
    const vid = Number(url.searchParams.get("version")) || c.versionId;
    const ver = Cur.getVersion(c.db, vid);
    if (!ver || ver.curriculum_id !== c.curriculumId) return send(res, 404, { error: "no such version" });
    const st = dagState(c, vid);
    const job = guessJob?.running ? guessJob : (await remoteJob("dag-guess")) || guessJob;
    return send(res, 200, {
      content: Cur.graphFor(c.db, vid, "content"), methods: Cur.graphFor(c.db, vid, "methods"), guess: st.guess, overrides: st.overrides || {},
      job: job && { ...job, elapsed: job.startedAt ? Date.now() - job.startedAt : 0 }, notes: await noteFiles(), guessModel: GUESS_MODEL, runs: st.runs.map(runSummary),
      version: { id: ver.id, seq: ver.seq, status: ver.status, enrolled: c.versionId }, versions: Cur.listVersions(c.db, c.curriculumId).map((v) => ({ id: v.id, seq: v.seq, status: v.status })),
      plan: Cur.planFor(c.db, vid),
    });
  }
  const rm = p.match(/^\/api\/dag\/runs\/(\d+)$/);
  if (m === "GET" && rm) {
    const run = Prog.getRun(C().db, rm[1]);
    return run ? send(res, 200, run) : send(res, 404, { error: "no such run" });
  }
  if (m === "PUT" && p === "/api/dag") {
    const { id, state, note } = await body(req);
    const c = C();
    if (!/^[A-Za-z0-9:_-]{1,40}$/.test(id || "") || !Cur.keysOf(c.db, c.versionId).has(id)) return send(res, 400, { error: "bad node id" });
    if (state != null && !Prog.STATES.includes(state)) return send(res, 400, { error: "bad state" });
    return send(res, 200, { overrides: Prog.setOverride(c.db, c.enrollmentId, id, state, note || "") });
  }

  // ---- students and enrollments ----
  if (m === "GET" && p === "/api/students") {
    const c = C();
    return send(res, 200, { students: Prog.listStudents(c.db), enrollments: Prog.listEnrollments(c.db), active: c.enrollmentId, curricula: Cur.listCurricula(c.db) });
  }
  if (m === "POST" && p === "/api/students") {
    const { name, curriculum } = await body(req);
    if (!String(name || "").trim()) return send(res, 400, { error: "name required" });
    const c = C();
    const cur = curriculum || c.curriculumId;
    const v = Cur.latestPublished(c.db, cur);
    if (!v) return send(res, 400, { error: "that curriculum has no published version" });
    const sid = Prog.addStudent(c.db, name);
    return send(res, 200, { student: sid, enrollment: Prog.enroll(c.db, sid, cur, v.id) });
  }
  if (m === "PUT" && p === "/api/enrollment") {
    // Switch the active student/course. The root weekly_status.md and curriculum_ladder.md follow it.
    const { id } = await body(req);
    const c = C();
    if (!Prog.getEnrollment(c.db, Number(id))) return send(res, 404, { error: "no such enrollment" });
    await readStatus(c); // keep any hand edit of the current file with the student it belongs to
    setActiveEnrollment(c.db, Number(id));
    setSetting(c.db, "ladder_export_hash", "");
    const n = C();
    // A student with no status yet starts from a blank one, never from the previous student's file.
    const text = latestStatus(n)?.text ?? `# Weekly status: ${n.studentName}\n\nNothing taught yet.\n`;
    if (!latestStatus(n)) saveStatus(n, text, { source: "teacher" });
    await writeLikeOriginal(STATUS_FILE, text);
    await writeLikeOriginal(LADDER_FILE, Cur.ladderFor(n.db, n.versionId));
    setSetting(n.db, "ladder_export_hash", sha(Cur.ladderFor(n.db, n.versionId)));
    return send(res, 200, { ok: true });
  }
  if (m === "POST" && p === "/api/enrollment/upgrade") {
    const { to } = await body(req);
    const c = C();
    try { return send(res, 200, Prog.upgradeEnrollment(c.db, c.enrollmentId, Number(to))); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (m === "GET" && p === "/api/status/history") return send(res, 200, { revisions: statusHistory(C()) });

  // ---- curriculum versions ----
  if (m === "GET" && p === "/api/versions") {
    const c = C();
    const draft = Cur.draftOf(c.db, c.curriculumId);
    return send(res, 200, {
      curriculum: c.db.prepare("SELECT * FROM curriculum WHERE id = ?").get(c.curriculumId), versions: Cur.listVersions(c.db, c.curriculumId), enrolled: c.versionId,
      enrollments: Prog.listEnrollments(c.db).filter((e) => e.curriculum_id === c.curriculumId),
      draft: draft && { id: draft.id, seq: draft.seq, note: draft.note, unresolved: Cur.unresolvedRemovals(c.db, draft.id), diff: draft.parent_id ? Cur.diffVersions(c.db, draft.parent_id, draft.id) : null },
      retag: c.db.prepare("SELECT COUNT(*) n FROM retag_queue WHERE done_at IS NULL").get().n,
    });
  }
  const vm = p.match(/^\/api\/versions\/(\d+)(\/diff|\/publish)?$/);
  if (vm) {
    const c = C(), vid = Number(vm[1]);
    const ver = Cur.getVersion(c.db, vid);
    if (!ver || ver.curriculum_id !== c.curriculumId) return send(res, 404, { error: "no such version" });
    if (m === "GET" && !vm[2]) return send(res, 200, { ...ver, meta_json: undefined, plan: Cur.planFor(c.db, vid), ladder: Cur.ladderFor(c.db, vid) });
    if (m === "GET" && vm[2] === "/diff") {
      const against = Number(url.searchParams.get("against")) || ver.parent_id;
      return against ? send(res, 200, Cur.diffVersions(c.db, against, vid)) : send(res, 400, { error: "nothing to compare with" });
    }
    if (m === "POST" && vm[2] === "/publish") {
      try {
        const r = Cur.publish(c.db, vid, { exportDir: path.join(DATA, "curricula") });
        logEvent("curriculum", "published", { seq: r.version.seq, lineageTags: r.lineageTags, queued: r.queued });
        return send(res, 200, { version: { id: r.version.id, seq: r.version.seq, status: r.version.status }, lineageTags: r.lineageTags, queued: r.queued });
      } catch (e) { return send(res, e.missing ? 409 : 400, { error: e.message, missing: e.missing }); }
    }
    if (m === "DELETE" && !vm[2]) { try { Cur.discardDraft(c.db, vid); return send(res, 200, { ok: true }); } catch (e) { return send(res, 400, { error: e.message }); } }
  }
  if (m === "POST" && p === "/api/versions/draft") {
    // {ops: [...]} (see editDraft in lib/curriculum.mjs); creates the draft from the latest published version if needed.
    const { ops = [], note } = await body(req);
    const c = C();
    const d = Cur.createDraft(c.db, c.curriculumId, { origin: "edit", note: note || "" });
    try { return send(res, 200, { draft: d, ...Cur.editDraft(c.db, d, ops) }); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (m === "GET" && p === "/api/retag") {
    return send(res, 200, { queue: C().db.prepare("SELECT q.*, cv.seq FROM retag_queue q JOIN curriculum_version cv ON cv.id = q.version_id WHERE q.done_at IS NULL ORDER BY q.at").all() });
  }
  if (m === "POST" && p === "/api/dag/guess") {
    if (guessJob?.running || (await remoteJob("dag-guess"))) return send(res, 409, { error: "already guessing" });
    background(runGuess);
    return send(res, 200, { started: true });
  }
  if (m === "POST" && p === "/api/dag/guess/stop") { running.get("dag-guess")?.abort(); await requestStop("dag-guess"); return send(res, 200, { ok: true }); }

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
    const w = { id, title: title || id, createdAt: new Date().toISOString(), sessionId: randomUUID(), started: false, model: model || DEFAULT_MODEL, enrollmentId: C().enrollmentId, messages: [] };
    await saveWeek(w);
    return send(res, 200, w);
  }

  const wm = p.match(/^\/api\/weeks\/([A-Za-z0-9_-]+)(\/message|\/stop|\/finish|\/tools)?$/);
  if (wm) {
    const [, id, action] = wm;
    if (m === "GET" && !action) {
      const remote = running.has(id) ? null : await remoteJob(id);
      return send(res, 200, { ...(await loadWeek(id)), running: running.has(id) || !!remote, live: progress.get(id) || remote?.live || null });
    }
    if (m === "GET" && action === "/tools") return send(res, 200, { calls: await readToolLog(id) });
    if (m === "DELETE" && !action) {
      for (const f of [weekPath(id), toolsPath(id), convoPath(id), path.join(MCP_DIR, `${id}.json`)]) await fsp.rm(f, { force: true });
      return send(res, 200, { ok: true });
    }
    if (m === "POST" && action === "/finish") {
      // One click: save the .tex into the project, (optionally) the new weekly_status.md, and the problems into the corpus.
      const { name, tex, status, overwrite } = await body(req);
      if (!TEX_NAME.test(name || "")) return send(res, 400, { error: "Filename must look like hw_11_28_2026.tex" });
      const dest = path.join(ROOT, name);
      if (fs.existsSync(dest) && !overwrite) return send(res, 409, { error: `${name} already exists` });
      await fsp.writeFile(dest, tex);
      const week = await loadWeek(id);
      if (status && status.trim()) await writeStatus(status.trimEnd() + "\n", { source: "claude", assignmentId: id, c: weekCtx(week) });
      let corpus = null;
      try { corpus = saveManifest(week, name, tex); tagInBackground(corpus.toTag || [], name); delete corpus.toTag; } catch (e) { corpus = { error: e.message }; }
      Object.assign(week, { done: true, savedAs: name, statusUpdated: !!(status && status.trim()), corpusSaved: corpus });
      await saveWeek(week);
      return send(res, 200, { ok: true, corpus });
    }
    if (m === "POST" && action === "/stop") { stopped.add(id); running.get(id)?.abort(); await requestStop(id); return send(res, 200, { ok: true }); }
    if (m === "POST" && action === "/message") {
      if (running.has(id) || (await remoteJob(id))) return send(res, 409, { error: "Claude is already working on this week" });
      const { text, kind, overrides } = await body(req);
      const week = await loadWeek(id);
      const wc = weekCtx(week);
      const sys = week.started ? null : await buildSystemPrompt(wc);
      const userMsg = { role: "user", text, kind: kind || "chat", at: new Date().toISOString() };
      const stage = stageFor(userMsg.kind, week);
      let prompt = text, brief = null;
      if (kind === "start") {
        brief = await weekBrief(overrides || {}, wc);
        const corpus = loadCorpusDb(wc), byId = new Map(corpus.map((x) => [x.id, x]));
        const ids = [...new Set(brief.sections.flatMap((x) => x.corpusIds.slice(0, 10)))];
        const pre = await corpusPreload(wc);
        for (const h of pre.hits) if (ids.length < 40 && !ids.includes(h.p.id)) ids.push(h.p.id);
        const hits = ids.map((i) => byId.get(i)).filter(Boolean).map((x) => ({ p: x, why: { recent: (x.usedOn || []).some((d) => Date.now() - Date.parse(d) < 42 * 864e5) } }));
        userMsg.preload = { count: hits.length, units: brief.allowedUnits, ids };
        userMsg.brief = { decisions: brief.decisions, sections: brief.sections.map(({ corpusIds, ...x }) => x), needsResearch: brief.needsResearch };
        prompt += `\n\n# Brief from the app (settled before you were called)\n${briefText(brief)}\n\n## Corpus problems for this week (${corpus.length} in the corpus; search for more with corpus_search)\n${formatHits(hits)}`;
      }
      if (DRY_STAGES) {
        const plan = planStages(userMsg.kind, week, brief || (await weekBrief(overrides || {}, wc)));
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
      await clearStop(id);
      const share = (force) => shareJob(id, { running: true, live }, { force });
      share(true);
      const heartbeat = setInterval(() => share(), 5000);
      let clientGone = false;
      res.on("close", () => (clientGone = true));
      const emit = (e) => {
        if (e.type === "text") { live.text += e.text; addTrace("say", e.text); }
        if (e.type === "thinking") addTrace("think", e.text);
        if (e.type === "stage") live.trace.push({ k: "stage", stage: e.stage, model: e.model, at: Date.now() - live.startedAt });
        if (e.type === "tool") { live.tools.push({ id: e.tool.id, name: e.tool.name, input: e.tool.input, textAt: live.text.length }); live.trace.push({ k: "tool", id: e.tool.id }); }
        if (e.type === "tool_result") { const t = live.tools.find((x) => x.id === e.tool.id); if (t) Object.assign(t, { ok: e.tool.ok, chars: e.tool.chars, ms: e.tool.ms }); }
        share();
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
      clearInterval(heartbeat);
      await shareJob(id, { running: false }, { force: true });
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

// The whole app as one request handler: the local server below and the Vercel entry (api/index.mjs) both use it.
let login = null;
export async function app(req, res) {
  login ??= createLogin({ hash: PASSWORD_HASH, dataDir: DATA, trustProxy: process.env.HW_TRUST_PROXY === "1" || !!process.env.VERCEL });
  const t0 = Date.now();
  const u = req.url.split("?")[0];
  const dynamic = !u.startsWith("/") || u.startsWith("/api/") || u.startsWith("/build/") || u === "/";
  if (dynamic) { try { await mirror.pull(); } catch (e) { logEvent("mirror", "pull-error", { error: e.message }); } }
  try {
    try { if (await login.gate(req, res)) return; } catch (e) { if (!res.headersSent) send(res, 500, { error: e.message }); return; }
    // Static files and the log endpoints themselves would drown everything else out.
    if (u.startsWith("/api/") && u !== "/api/log" && u !== "/api/logs") res.on("finish", () => logEvent("http", `${req.method} ${u}`, { status: res.statusCode, ms: Date.now() - t0 }));
    try { await handle(req, res); }
    catch (e) { logEvent("server", "error", { path: u, error: e.stack || e.message }); if (!res.headersSent) send(res, 500, { error: e.message }); else res.end(); }
  } finally {
    // Writes (including a login, which the gate answers itself) go to durable storage before the instance can sleep.
    if (req.method !== "GET" && mirror.enabled) { try { await mirror.push(); } catch (e) { logEvent("mirror", "push-error", { error: e.message }); } }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const loopback = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/.test(HOST);
  if (PASSWORD_HASH && !validHash(PASSWORD_HASH)) { console.error("HW_PASSWORD_HASH isn't a hash from `node ui/scripts/hash-password.mjs`."); process.exit(1); }
  if (!loopback && !PASSWORD_HASH) { console.error(`Refusing to listen on ${HOST} without a login. Set HW_PASSWORD_HASH (node ui/scripts/hash-password.mjs).`); process.exit(1); }
  http
    .createServer((req, res) => { app(req, res); })
    .listen(PORT, HOST, () => {
      console.log(`Homework UI: http://${loopback ? "localhost" : HOST}:${PORT}  (event log: ${LOG_FILE})`);
      console.log(PASSWORD_HASH ? "Login: password required" : "Login: off (local only)");
      if (!findTectonic()) console.log("Note: Tectonic not found; PDF compile is disabled until you run `brew install tectonic`.");
      const auth = claudeAuth();
      console.log(`Claude: ${auth.mode === "api-key" ? "Anthropic API" : "no API key"}`);
      if (auth.note) console.log("Note: " + auth.note);
      if (!casAvailable()) console.log("Note: CAS unavailable. Run: uv venv ui/data/venv && uv pip install --python ui/data/venv sympy");
    });
}
