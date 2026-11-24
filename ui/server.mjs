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
import { loadCorpus, saveCorpus, searchCorpus, formatHits, addProblems, patchProblem, dateFromName, tokenize, attachTex, problemId, nearDuplicates, sameAnswer } from "./lib/corpus.mjs";
import { ctx, loadCorpusDb, saveStatus, latestStatus, statusHistory, recordAssignment, setActiveEnrollment } from "./lib/store.mjs";
import { closeDb, getSetting, setSetting, tx } from "./lib/db.mjs";
import * as Cur from "./lib/curriculum.mjs";
import * as Prog from "./lib/progress.mjs";
import { buildBrief, briefText, statusDigest, commentLines, mapBlocks } from "./lib/preflight.mjs";
import { mapUpdateFrom, resolveMapUpdate, mapUpdateOps } from "./lib/mapupdate.mjs";
import { applyWeekUpdate, weekUpdateInputs, checkStatusUpload } from "./public/statusmd.js";
import { exportBoardMd, parseBoardMd } from "./public/progressmd.js";
import { claudeAuth } from "./lib/auth.mjs";
import { runAgent, makeClient, addUserTurn } from "./lib/agent.mjs";
import { CHAT_MODEL, corpusChatSystem, citedIds } from "./lib/corpuschat.mjs";
import { agentTools, casRemote } from "./lib/tools.mjs";
import { checksFrom, stripChecks } from "./lib/check.mjs";
import { createMirror, storeFromEnv } from "./lib/mirror.mjs";
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
const WEEK_TOOLS = ["cas", "check_answers", "corpus_search", "corpus_add"];
const WEEK_SERVER = ["WebSearch", "WebFetch"];
// Web limits per API call in the week's conversation. The research stage (Sonnet) does the broad searching; the
// outline only fills a gap. Part of the tool definitions, so they stay the same for every turn of a week.
const WEEK_WEB = { maxSearches: 3, maxFetches: 3 };
const allowedOf = (st) => st.allowed.split(",").filter(Boolean).map((n) => n.replace(/^mcp__hw__/, ""));
const ALLOWED_TOOLS = "WebSearch,WebFetch,mcp__hw__cas,mcp__hw__check_answers,mcp__hw__corpus_search,mcp__hw__corpus_add";

// ---------- stage routing: the cheapest model that does each part well ----------
// Taste-critical work (choosing and vetting problems, the checkpoint) stays on the main model. Research, writing
// out an approved outline, answer checking and compile fixes go to cheaper models, escalating one tier on failure.
// The final stays on the week's model: it follows the checkpoint within minutes, so it reads the outline's prompt
// cache (caches are per model), and that saves more than a cheaper model's lower output price. No effort of its own:
// the outline sends none, and a different effort would miss the cache too (Opus defaults to medium).
const MODELS = { opus: DEFAULT_MODEL, sonnet: process.env.HW_SONNET_MODEL || "claude-sonnet-5-5", haiku: process.env.HW_HAIKU_MODEL || "claude-haiku-5-5" };
const NEXT_TIER = { [MODELS.haiku]: MODELS.sonnet, [MODELS.sonnet]: MODELS.opus };
export const STAGES = {
  research: { model: process.env.HW_RESEARCH_MODEL || MODELS.sonnet, tools: "WebSearch,WebFetch", allowed: "WebSearch,WebFetch,mcp__hw__corpus_search", effort: "medium", why: "web research for sections the corpus can't fill" },
  outline: { model: null, tools: "WebSearch,WebFetch", allowed: ALLOWED_TOOLS, why: "choose, adapt and vet problems; write the checkpoint" },
  final: { model: process.env.HW_WRITE_MODEL || null, tools: "", allowed: "mcp__hw__cas,mcp__hw__check_answers,mcp__hw__corpus_search", why: "write the approved outline out as .tex + status + manifest" },
  fix: { model: process.env.HW_FIX_MODEL || MODELS.haiku, tools: "", allowed: "mcp__hw__cas,mcp__hw__check_answers", effort: "low", why: "compile/lint fixes" },
};
const DRY_STAGES = process.env.HW_DRY_STAGES === "1";
// HW_STAGES_OFF=research turns the extra stages off (e.g. to compare cost).
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
const isCheckpointText = (t) => /judgment calls|removed in audit|sourced ideas/i.test(t || "");
function mergeUsage(a, b) {
  if (!a) return b; if (!b) return a;
  const models = { ...a.models };
  for (const [k, v] of Object.entries(b.models || {})) { const o = models[k]; models[k] = o ? Object.fromEntries(Object.keys(v).map((f) => [f, (o[f] || 0) + (v[f] || 0)])) : v; }
  return { costUSD: (a.costUSD || 0) + (b.costUSD || 0), durationMs: (a.durationMs || 0) + (b.durationMs || 0), numTurns: (a.numTurns || 0) + (b.numTurns || 0), webSearches: (a.webSearches || 0) + (b.webSearches || 0), models };
}

const JOBS = path.join(DATA, "jobs");
for (const d of [WEEKS, BUILD, MCP_DIR, DEBUG, NOTES, LOGS, JOBS]) fs.mkdirSync(d, { recursive: true });

const STATUS_EXAMPLE = path.join(UI_DIR, "..", "examples", "weekly_status.md");
const INSTRUCTIONS_FILE = path.join(ROOT, "project_instructions.md");
const LADDER_FILE = path.join(ROOT, "curriculum_ladder.md");
// Students, curricula, progress, the corpus and status history live in DATA/hw.db (lib/store.mjs); the first
// open migrates the v0 files. HW_STUDENT names the first student at migration; HW_CURRICULUM overrides the
// sidebar title. curriculum_ladder.md at ROOT is an export of the active enrollment. The student's weekly status
// lives only in hw.db (export/upload it as status.md on the Progress map); a weekly_status.md at ROOT is not read.
const STUDENT_ENV = (process.env.HW_STUDENT || "").trim();
const CURRICULUM_ENV = (process.env.HW_CURRICULUM || "").trim();
const C = () => ctx({ dir: DATA });
// The course a request is about: the active enrollment's, or another one picked on the Progress map (X-Curriculum
// header or ?curriculum=). Another course shows its draft, else its latest published version, with no progress.
function CB(req, url) {
  const c = C(), want = String(req.headers["x-curriculum"] || url.searchParams.get("curriculum") || "");
  if (!want || want === c.curriculumId) return c;
  if (!c.db.prepare("SELECT 1 FROM curriculum WHERE id = ?").get(want)) return null;
  const v = Cur.draftOf(c.db, want) || Cur.latestPublished(c.db, want);
  return { ...c, curriculumId: want, versionId: v?.id ?? null, browsing: true };
}
const noCourse = (res) => send(res, 404, { error: "no such curriculum" });
// The two Wu DAGs ship with the code. With DATA elsewhere (hosted: /tmp), copy them in on every start.
const BUNDLED_DATA = ["wu_dag.json", "wu_methods_dag.json"];
if (path.resolve(DATA) !== path.join(UI_DIR, "data")) for (const f of BUNDLED_DATA) { const src = path.join(UI_DIR, "data", f); if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DATA, f)); }
// First run: copy the example workflow and ladder into the homework folder if they aren't there yet.
for (const f of [INSTRUCTIONS_FILE, LADDER_FILE]) {
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
// When hosted on Vercel (an R2 bucket or Blob store configured), ROOT and DATA are /tmp folders mirrored to it
// (lib/mirror.mjs): pulled before each API request, pushed after writes and after background work.
// Caches, builds and logs stay local to the instance.
export const mirror = createMirror({
  roots: { root: ROOT, data: DATA },
  store: process.env.VERCEL ? storeFromEnv() : null,
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

// ---------- weekly status and Scope and Sequence: hw.db ----------
// The status is the app's own record (status_revision): edited on Create Homework, updated by Save & finish,
// exported or replaced by upload on the Progress map. Nothing outside hw.db is read or written for it.
const isActive = (c) => c.enrollmentId === C().enrollmentId;
const weekCtx = (week) => (week?.enrollmentId ? ctx({ dir: DATA, enrollment: week.enrollmentId }) : C());
async function readStatus(c = C()) {
  const last = latestStatus(c);
  if (last) return last.text;
  // A student with no status yet starts from the example template.
  let text = `# Weekly status: ${c.studentName || "student"}\n\nTAUGHT: (none)\nCURRENT: (none)\nNEXT: (none)\n`;
  try { text = await read(STATUS_EXAMPLE); } catch {}
  saveStatus(c, text, { source: "teacher" });
  return text;
}
async function writeStatus(text, { source = "teacher", assignmentId = null, c = C() } = {}) {
  return saveStatus(c, text, { source, assignmentId });
}
// The Scope and Sequence the prompts use is the active enrollment's version. A hand edit of curriculum_ladder.md
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
    Cur.editDraft(c.db, d, [{ op: "setLadder", md: file }], { source: "file" });
    setSetting(c.db, "ladder_drift_hash", sha(file));
    logEvent("curriculum", "ladder-drift", { draft: Cur.getVersion(c.db, d).seq });
  }
  return md;
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".pdf": "application/pdf",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic", ".svg": "image/svg+xml",
  ".tex": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8" };

// A hash of the page's own files. Every response carries it, so a page loaded before a deploy can tell it's stale
// (and stop sending prompts the new server no longer writes).
const CLIENT_BUILD = (() => {
  const h = createHash("sha1");
  try { for (const f of fs.readdirSync(PUBLIC).sort()) { const p = path.join(PUBLIC, f); if (fs.statSync(p).isFile()) h.update(f).update(fs.readFileSync(p)); } } catch {}
  return h.digest("hex").slice(0, 12);
})();

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Client-Build": CLIENT_BUILD });
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
const creating = new Set(); // week titles mid-create, so a double click can't make two
async function createWeek(base, title, model) {
  let id = base, n = 2;
  while (fs.existsSync(weekPath(id))) id = `${base}-${n++}`;
  const w = { id, title: title || id, createdAt: new Date().toISOString(), sessionId: randomUUID(), started: false, model: model || DEFAULT_MODEL, enrollmentId: C().enrollmentId, messages: [] };
  await saveWeek(w);
  return w;
}
async function deleteWeekFiles(id) {
  for (const f of [weekPath(id), toolsPath(id), convoPath(id), turnPath(id), path.join(MCP_DIR, `${id}.json`)]) await fsp.rm(f, { force: true });
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
    // <id>.convo.json (the saved Claude conversation) sits beside <id>.json and isn't a week.
    if (!f.endsWith(".json") || f.endsWith(".convo.json")) continue;
    try {
      const w = JSON.parse(await read(path.join(WEEKS, f)));
      if (!w.id) continue;
      out.push({ id: w.id, title: w.title, createdAt: w.createdAt, turns: w.messages.length, done: !!w.done, savedAs: w.savedAs || null, model: w.model, costUSD: weekCost(w), enrollmentId: w.enrollmentId ?? owner.get(w.id) ?? first });
    } catch {}
  }
  // A week missing createdAt (hand-edited, or an old format) sorts last instead of breaking the list.
  return out.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
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
    "- You are running inside a local app, not a chat. The first user message carries the app's brief, which is this week's whole input: the inputs (date, topics, options, fact sheet), unit statuses and allowed units, review priority, bans, the teacher's standing conventions, recent sets, decisions already made, a section plan with corpus coverage, and research notes for sections the corpus couldn't cover. Wherever the workflow mentions weekly_status.md, read it as the brief. There is no status file to read or reconcile.",
    "- There is no opening question round in this app. Never reply with only questions, and never stop before the checkpoint. Whenever the workflow says to ask the teacher (missing fields, unit confirmations, definitions for a new unit, edge cases), make the most conservative reasonable choice, use it, and list it in the checkpoint: under **Assumptions** (one line each) for choices you made, and under **Needs your call** (at most 5) for the ones the teacher should rule on. For a new unit's definitions, use the standard precise definition in Wu's style, state it in the checkpoint, and avoid its edge cases. The checkpoint is the teacher's only chance to correct you, so make it complete.",
    "- Treat the brief's decisions and standing conventions as the teacher's answers. Never ask about them again. Assumptions you list in a checkpoint apply to this set only.",
    "- The brief's **teacher's comments** are notes the teacher left on units and blocks of the progress map: how the student is doing with them, what to stress or avoid, how they want them taught. Read each one as a direct instruction for every problem that touches that unit or block, and let it shape which problems you pick, how you phrase them and how hard they are. Those marked [this week] are on this week's topics and matter most. A comment outranks the workflow's soft defaults and your own preferences; only the hard gates outrank it (if one conflicts, follow the gate and say so). In the checkpoint, and at the top of the final when there was no checkpoint, include a **Your comments** list: one line per comment saying concretely what in this set follows it (which section or problems), or why it couldn't.",
    "- Tools: web search, web fetch, and the app's own tools `cas`, `check_answers`, `corpus_search` and `corpus_add`. There is no bash tool. The app compiles your .tex with Tectonic and will send you any errors or overfull-box warnings. In the final step, write \"not compiled (the app will compile it)\".",
    "- Answer checks: the app checks answer keys itself, with no model involved. End every reply that states answers (the checkpoint, and every reply with a .tex) with one ```json fenced block {\"checks\": [...]}: one item per problem whose answer can be checked mechanically, in the shape `check_answers` takes ({\"id\", \"kind\", \"expr\", \"vars\", \"claimed\", \"form\"}). In a reply with a .tex, use ids P<part>.<n> to match the manifest. After your reply the app runs the block through sympy and sends you only what failed. This replaces the workflow's verification steps (working every candidate by hand, substituting back, using Python): work each answer out once and don't re-check it, by hand or with a tool. Answers the app has already checked (the checkpoint's, once it passed) are settled: when you write the .tex, copy them as they are; work out only answers to problems you changed or added. If you need an answer you don't know yet, get it from `check_answers` with claimed left out, with every such problem in one call. Use `cas` only for what check_answers can't express (randomized sets, searching for numbers that give integer roots), and print only failures and a count. Leave out of the block corpus problems marked `cas ✓` that you use verbatim (same text, same answer), and problems with no mechanical answer (explanations, proofs, graphs). The teacher doesn't see the block.",
    "- Problem corpus: the teacher's cache of problems from past sets, earlier research and favorites. The first message includes the best matches for this week. Draw from the corpus first, and adapt rather than copy problems marked used (especially recent ones). Use `corpus_search` for more. Web search only for sections where the corpus and the research notes together have fewer than 3 suitable candidates, and keep it brief: a few targeted searches, not a second research pass. When code processes search or fetch results, print only the parts you need (a problem's text, a short excerpt), never whole result objects or page contents: everything printed stays in the conversation and is paid for on every later call. Whenever you find good problems on the web, call `corpus_add` with them, including ones you won't use this week. In the checkpoint, say which problems came from the corpus (by id) and which came from the web.",
    "- In the final step put the complete .tex in exactly one ```latex fenced block. Do not write a weekly_status.md: the app keeps the status and updates it itself.",
    "- After the .tex, add one ```json fenced block: a problem manifest, an array with one object per \\item in the set, in the order they appear in the .tex: {\"part\": 1, \"n\": 3, \"answer\": \"...\", \"units\": [\"U14\"], \"source\": \"corpus:<id>\" or \"web:<url>\" or \"new\", \"casVerified\": true}. casVerified is true for a `cas ✓` corpus problem used verbatim and for every problem in your checks block (the app clears it for any that fail). Don't repeat the problem text: the app reads it from the .tex. The app saves it to the corpus when the teacher saves the set.",
    "- Then one more ```json fenced block, an object with your proposed changes to the status for next week: {\"history\": \"one line for Recent history: what this set covered and anything to follow up\", \"review\": [\"the full updated Review priority list, most important first\"], \"conventions\": [\"a new standing convention, only if the teacher stated a lasting rule this week\"]}. Omit review to keep the current list; conventions is usually empty. The app moves promoted units to CURRENT and clears the week's input itself.",
    "- The brief's **Progress map** lists the blocks (facts and methods) of the units in play and where the student is on each: done, partial, NOT YET, or no evidence. A unit being TAUGHT doesn't mean every skill a problem needs is on the map. When you pick problems for the checkpoint, note the skills each one needs beyond the obvious unit (for example a compound inequality a < x < b inside an absolute-value problem, or completing the square inside a graphing problem). If a skill has no block on the map, or its block is NOT YET, list it in the checkpoint under **Map gaps** (at most 4, one line each): the skill, the problems that rely on it, and the choice for the teacher: teach it in this set (a worked example or a scaffolded first problem), avoid it, or add it to the map as not yet known. Make the conservative choice yourself (scaffold or avoid) and carry on; never stop for it. Leave the heading out when there are none.",
    "- Then, only when the set relies on a skill the map lacks, or the teacher told you something about what the student does or doesn't know, add one more ```json fenced block: {\"mapUpdate\": [...]}, one item per change, each with a one-line \"why\" naming the problems. To add a block: {\"add\": {\"layer\": \"methods\" or \"content\", \"title\": \"short name, like the map's\", \"detail\": \"one line\", \"restsOn\": [content keys, for a method], \"uses\": [keys of the same layer it builds on], \"neededBy\": [keys that need it], \"units\": [\"the unit it belongs to\"]}, \"state\": \"not-yet\", \"why\": \"...\"}. To change the student's state on a block that's there: {\"key\": \"m:e38\", \"state\": \"partial\", \"why\": \"...\"}. Use keys exactly as the brief's Progress map gives them. The teacher approves each item at Save & finish; new blocks go into a draft of the map. Leave the block out when there's nothing to change.",
    "- If the teacher asks for changes after the final, always reply with the complete revised .tex, the manifest, the status-update block, the map-update block if there was one, and the checks block again.",
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
// budgetUSD: what this call may still spend (a turn's stages share HW_BUDGET_USD); defaults to the whole budget.
async function callAgent({ key, weekId = "", model, system, messages, toolNames = [], allow = null, server = [], webLimits, effort, schema, binding = false, onEvent = () => {}, deadline, hardDeadline, budgetUSD }) {
  const ac = new AbortController();
  running.set(key, ac);
  const t0 = Date.now();
  // Hosted: Stop may land on another instance; it leaves a flag in Blob that we poll for.
  const poll = mirror.enabled && setInterval(async () => {
    if (await mirror.fetchNow(jobFile(key, "stop")).catch(() => null)) { stopped.add(key); ac.abort(); }
  }, 3000);
  try {
    const r = await runAgent({
      client: client(), model, system, messages, tools: agentTools(weekId, { names: toolNames }), allow, server, webLimits, effort, schema, binding,
      budgetUSD: budgetUSD ?? (BUDGET ? Number(BUDGET) : Infinity), budgetLabel: BUDGET ? `$${BUDGET}` : undefined, signal: ac.signal, onEvent, deadline, hardDeadline,
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
// prompt null resumes a turn that paused at a deadline (lim): the saved conversation already ends where it stopped.
async function runClaude(week, prompt, systemPrompt, onEvent, stage = "outline", lim = {}) {
  const st = STAGES[stage];
  let convo = week.started || prompt == null ? await readJson(convoPath(week.id), null) : null;
  if (!convo) convo = { system: systemPrompt || (await buildSystemPrompt()), messages: legacyHistory(week) };
  const before = convo.messages.length;
  if (prompt != null) addUserTurn(convo.messages, prompt);
  const r = await callAgent({
    key: week.id, weekId: week.id, model: modelFor(stage, week), system: convo.system, messages: convo.messages,
    toolNames: WEEK_TOOLS, allow: allowedOf(st), server: WEEK_SERVER, webLimits: WEEK_WEB, effort: st.effort, binding: true, onEvent, ...lim,
  });
  // Nothing came back: leave the conversation as it was so a retry starts clean.
  if (!r.ok && !r.paused && !r.text && prompt != null) convo.messages.length = before;
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
  const brief = buildBrief({ status, ladder, corpus: loadCorpusDb(c), comments: Cur.nodeComments(c.db, c.curriculumId, c.versionId), dataDir: DATA, overrides });
  const inPlay = new Set([...brief.allowedUnits, ...brief.sections.flatMap((x) => x.units)]);
  const order = ladderUnits(ladder).map((u) => u.id);
  const units = [...inPlay].sort((a, b) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9));
  brief.map = mapBlocks({ covers: Cur.coversFor(c.db, c.versionId), nodes: mapNodes(c.db, c.versionId), progress: studentProgress(c), units });
  return brief;
}

// key -> {layer, title, x, y, w, h} for every block and unit of a version
function mapNodes(db, v) {
  const m = new Map();
  for (const layer of ["content", "methods", "unit"]) for (const r of Cur.revisionsOf(db, v, layer)) m.set(r.node_key, { layer, title: r.title, x: r.x, y: r.y, w: r.w, h: r.h });
  return m;
}
// The student's state per key: the teacher's mark, else the guess.
function studentProgress(c) {
  const st = dagState(c), out = {};
  for (const [k, x] of Object.entries(st.guess?.nodes || {})) out[k] = { state: x.state, confidence: x.confidence, source: "guess" };
  for (const [k, x] of Object.entries(st.overrides || {})) out[k] = { state: x.state, source: "teacher" };
  return out;
}
// The latest final's proposed map changes, checked against the student's map: {at, items} or null.
function weekMapUpdate(week) {
  const fin = [...(week?.messages || [])].reverse().find((x) => x.role === "assistant" && /```(latex|tex)\n/.test(x.text || ""));
  const items = fin && mapUpdateFrom(fin.text);
  if (!items?.length) return null;
  const c = weekCtx(week);
  return { at: fin.at, items: resolveMapUpdate(items, mapNodes(c.db, c.versionId)) };
}
// Applies the approved items (indexes into weekMapUpdate's items): new blocks into the draft, states as teacher marks.
function applyMapUpdate(week, accept) {
  const mu = weekMapUpdate(week);
  if (!mu || !accept?.length) return null;
  const c = weekCtx(week), take = mu.items.filter((r) => accept.includes(r.i) && !r.error);
  if (!take.length) return null;
  const adds = take.some((r) => r.kind === "add");
  const draft = adds ? Cur.createDraft(c.db, c.curriculumId, { origin: "edit", note: `From ${week.title || week.id}` }) : null;
  const { ops, marks } = mapUpdateOps(take, { newKey: Cur.newKey, draftNodes: mapNodes(c.db, draft ?? c.versionId), covers: draft ? Cur.coversFor(c.db, draft) : {}, note: week.title || week.id });
  if (ops.length) Cur.editDraft(c.db, draft, ops, { source: "claude" });
  for (const x of marks) Prog.recordEvent(c.db, c.enrollmentId, { key: x.key, versionId: x.isNew ? draft : undefined, state: x.state, note: x.note, source: "teacher" });
  return { added: take.filter((r) => r.kind === "add").map((r) => r.add.title), marked: marks.length, draft: draft ? Cur.getVersion(c.db, draft).seq : null };
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
async function researchPrompt(brief) {
  const secs = brief.sections.filter((s) => brief.needsResearch.includes(s.key));
  const instr = await read(INSTRUCTIONS_FILE);
  const rules = statusSection(instr, "## Hard gates") + "\n" + statusSection(instr, "## Vetting rubric for researched ideas") + "\n" + statusSection(instr, "## Variables") + "\n" + statusSection(instr, "**Research (every week).**".replace(/\*/g, ""));
  return [
    "You research problem ideas for a 5th grader's rigorous algebra homework (Wu style). Find good sources, open them, and write ORIGINAL problems based on their ideas. Do not ask questions; there is no one to answer them.",
    `Allowed units: ${brief.allowedUnits.join(", ")}. Everything else is off limits.`,
    "", "## Rules (from the teacher's instructions)", instr.includes("## Hard gates") ? rules : instr,
    ...commentLines((brief.comments || []).filter((x) => x.units.some((u) => secs.some((sec) => sec.units.includes(u))))),
    ...((brief.comments || []).some((x) => x.units.some((u) => secs.some((sec) => sec.units.includes(u)))) ? ["Choose sources and write problems that follow these comments: they are the teacher's instructions for these units."] : []),
    "", "## Sections to research (the corpus is thin here)",
    ...secs.map((x) => `- key ${x.key}: ${x.title} [${x.units.join(", ")}] — ${x.kind}, need about ${x.target} problems; corpus has ${x.usable}.`),
    "", "Before searching, call corpus_search once per section to see what exists, so you don't duplicate it.",
    "Budget: about 3 searches per routine section, up to 6 for a rich one. Give 1.5x the needed count per section, each with its answer, its source URL and one line on the idea and what you changed. Mark fromSnippet if you could not open the page.",
    "Return only the structured result.",
  ].join("\n");
}
// One slice of research. R = {model, attempt, messages, usage, tools} carries a paused run to the next slice.
// Returns null while it isn't finished, else {model, usage, tools, result, saved} or {..., error}.
async function researchSlice(week, brief, R, onEvent, lim) {
  R.messages ||= [{ role: "user", content: await researchPrompt(brief) }];
  const r = await callAgent({ key: week.id, weekId: week.id, model: R.model, messages: R.messages, toolNames: allowedOf(STAGES.research),
    server: STAGES.research.tools.split(",").filter(Boolean), effort: STAGES.research.effort, schema: RESEARCH_SCHEMA, onEvent: (e) => e.type !== "text" && onEvent(e), ...lim });
  R.usage = mergeUsage(R.usage, r.usage); R.tools = (R.tools || []).concat(r.tools || []);
  if (r.paused) return null;
  const probs = r.structured?.problems;
  if (r.ok && Array.isArray(probs) && (probs.length || r.structured.searchUnavailable)) {
    const secs = brief.sections.filter((s) => brief.needsResearch.includes(s.key));
    const today = new Date().toISOString().slice(0, 10);
    const saved = addProblems(loadCorpus(), probs.map((x) => ({ tex: x.tex, answer: x.answer, units: x.units, status: "candidate", tags: ["research"],
      context: secs.find((s) => s.key === x.section)?.title || "", source: { kind: "web", url: x.url, note: x.idea, date: today, week: week.id, fromSnippet: !!x.fromSnippet } })));
    logEvent("stage", "research-done", { week: week.id, model: R.model, problems: probs.length, added: saved.added.length });
    return { model: R.model, usage: R.usage, tools: R.tools, result: r.structured, saved };
  }
  logEvent("stage", "research-retry", { week: week.id, model: R.model, error: r.error || "no structured problems" });
  if (R.attempt > 0 || !NEXT_TIER[R.model] || stopped.has(week.id)) return { model: R.model, usage: R.usage, tools: R.tools, error: r.error || "research returned nothing" };
  Object.assign(R, { model: NEXT_TIER[R.model], attempt: R.attempt + 1, messages: null });
  return null;
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

// ---------- a week turn, run in slices ----------
// A teacher message is a turn: research (start only) → the routed turn → auto-continue → wrap up. Its state is
// data/jobs/<id>.turn.json, so a slice can stop at a deadline and any instance can pick it up. Locally the slices
// run back to back inside the /message request. Hosted (Vercel Workflow, workflows/turn.mjs), each slice is a
// workflow step on whichever instance the queue picks: it pulls the mirror, stops well inside the 300 s function
// limit (runAgent's deadlines leave the conversation resumable) and pushes everything before returning.
const turnPath = (id) => path.join(JOBS, `${id}.turn.json`);
export const USE_WORKFLOW = !!process.env.VERCEL && mirror.enabled && process.env.HW_WORKFLOW !== "0";
// No new model call after SOFT ms into a slice; a call still streaming at HARD is dropped and redone next slice.
const SLICE_SOFT = Number(process.env.HW_SLICE_SOFT_MS) || 150000;
const SLICE_HARD = Number(process.env.HW_SLICE_HARD_MS) || 240000;
const MAX_SLICES = 40;
const sinks = new Map(); // weekId -> fn(event) streaming a local turn's events to its request
// Sent back once when the app's own answer check (the reply's checks block, run through sympy) finds wrong answers.
const recheckPrompt = (text, stage) => `The app checked the answers in your checks block with sympy. These are wrong:\n${text}\n\nFix each wrong answer (or change the problem), then send ${stage === "outline" ? "the complete checkpoint again" : "the complete corrected .tex, the problem manifest, the status-update block and the map-update block (if you sent one) again"}, with the checks block. If the CAS is the one that's wrong (the problem means something it can't see), keep your answer and say why in one line.`;
const NUDGE = "Nobody can answer questions in this app. For every question above, take the most conservative reasonable default yourself, list it under **Assumptions** (or **Needs your call** if the teacher must rule), and send the full checkpoint now.";

// One slice of a turn's work. Returns {done}. Never throws: a failure ends the turn with that error.
async function turnSlice(id, lim = {}) {
  const t = await readJson(turnPath(id), null);
  if (!t || t.phase === "done") return { done: true };
  const week = await loadWeek(id);
  const live = t.live;
  progress.set(id, live);
  const addTrace = (k, text) => { const last = live.trace.at(-1); if (last?.k === k) last.text += text; else live.trace.push({ k, text }); };
  const share = (force) => shareJob(id, { running: true, live }, { force });
  const heartbeat = setInterval(() => share(), 5000);
  // trace: everything in the order it happened: {k:"stage"|"think"|"say"|"tool", ...}. Tools are referenced by id.
  const emit = (e) => {
    if (e.type === "text") { live.text += e.text; addTrace("say", e.text); }
    if (e.type === "thinking") addTrace("think", e.text);
    if (e.type === "stage") live.trace.push({ k: "stage", stage: e.stage, model: e.model, at: Date.now() - live.startedAt });
    if (e.type === "tool") { live.tools.push({ id: e.tool.id, name: e.tool.name, input: e.tool.input, textAt: live.text.length }); live.trace.push({ k: "tool", id: e.tool.id }); }
    if (e.type === "tool_result") { const x = live.tools.find((y) => y.id === e.tool.id); if (x) Object.assign(x, { ok: e.tool.ok, chars: e.tool.chars, ms: e.tool.ms }); }
    share();
    sinks.get(id)?.(e.tool ? { type: e.type, name: e.tool.name } : e);
  };
  const say = (st, model) => emit({ type: "stage", stage: st, model });
  // This phase's running totals, across its slices.
  const cur = (t.cur ||= { text: "", usage: null, tools: [] });
  const addPart = (r) => {
    if (r.text) cur.text = cur.text && !cur.text.endsWith("\n") && !r.text.startsWith("\n") ? cur.text + "\n\n" + r.text : cur.text + r.text;
    cur.usage = mergeUsage(cur.usage, r.usage); cur.tools = cur.tools.concat(r.tools || []);
  };
  // HW_BUDGET_USD covers the whole turn (research + main + auto-continue, across slices), not each model run.
  const left = (running) => (BUDGET ? Number(BUDGET) - (t.usage?.costUSD || 0) - (running?.costUSD || 0) : Infinity);
  const overBudget = () => ({ ok: false, error: `Stopped: this turn reached the $${BUDGET} budget.` });
  const account = (st, model, usage, tools, extra = {}) => {
    t.stages.push({ stage: st, model, costUSD: usage?.costUSD || 0, ...extra });
    t.usage = mergeUsage(t.usage, usage); t.tools = t.tools.concat(tools || []);
  };
  try {
    if (mirror.enabled && (await mirror.fetchNow(jobFile(id, "stop")).catch(() => null))) stopped.add(id);
    t.slices = (t.slices || 0) + 1;
    if (t.slices > MAX_SLICES) { t.result = { ok: false, error: "this turn ran too long and was stopped", text: t.result?.text || cur.text }; t.phase = "wrap"; }
    // Stop pressed between slices or stages: end here rather than start or resume another model run.
    if (stopped.has(id) && t.phase !== "wrap") { t.result = { ok: false, error: "stopped", text: t.result?.text || cur.text }; t.phase = "wrap"; }

    // Set once this slice has run a model call: only then may the soft deadline end the slice, so every slice
    // makes progress even when it starts late (a slow mirror pull).
    let ran = false;
    // 1. Research (start only, and only for sections the corpus can't fill).
    if (t.phase === "research") {
      ran = true;
      if (!t.research) { t.research = { model: STAGES.research.model, attempt: 0, messages: null }; say("research", t.research.model); }
      const r = await researchSlice(week, t.brief, t.research, emit, { ...lim, budgetUSD: left(t.research.usage) });
      if (r) {
        account("research", r.model, r.usage, r.tools, { sections: t.brief.needsResearch, problems: r.result?.problems?.length || 0, error: r.error });
        t.prompt += researchNotes(r);
        t.research = null; t.phase = "main";
      }
    }
    // 2. The routed turn in the week's session (resumed if a slice paused it), then 3. the auto-continue, and
    // (after a failed answer check, step 4) the one recheck turn.
    // A reply with a checks block goes to the app's answer check before it joins the week.
    const after = (r) => (r?.ok && !stopped.has(id) && checksFrom(r.text)?.length ? "check" : "wrap");
    for (const ph of ["main", "auto", "recheck"]) {
      if (t.phase !== ph || (ran && lim.deadline && Date.now() > lim.deadline)) continue;
      if (left(cur.usage) <= 0) {
        // Out of budget before this phase starts: keep what the turn has so far.
        if (ph === "main" || !t.result) t.result = { ...overBudget(), text: cur.text || t.result?.text || "" };
        else t.result = { ...t.result, ok: false, error: overBudget().error };
        t.phase = "wrap"; break;
      }
      const model = modelFor(t.stage, week);
      const runStage = ph === "auto" ? "outline" : t.stage;
      let prompt = t.resume ? null : ph === "main" ? t.prompt : ph === "auto" ? NUDGE : t.recheckPrompt;
      if (!t.resume) {
        if (ph !== "main") emit({ type: "text", text: "\n\n---\n\n" });
        say(t.stage, model);
      }
      const r = await runClaude(week, prompt, t.sys, emit, runStage, { ...lim, budgetUSD: left(cur.usage) });
      addPart(r);
      if (cur.text || r.ok) { if (!week.started) { week.started = true; await saveWeek(week); } }
      if (r.paused && !stopped.has(id)) { t.resume = true; break; }
      t.resume = false;
      const res = { ok: !!r.ok, error: r.paused ? "stopped" : r.error, text: cur.text };
      account(runStage, model, cur.usage, cur.tools, ph === "auto" ? { auto: true } : ph === "recheck" ? { recheck: true } : {});
      t.cur = null;
      if (ph === "main") {
        t.result = res;
        // An outline turn must end at the checkpoint, never at a list of questions.
        if (res.ok && t.stage === "outline" && !hasBlock(res.text) && !isCheckpointText(res.text) && !stopped.has(id)) {
          logEvent("stage", "auto-continue", { week: id });
          t.preamble = res.text; t.phase = "auto";
        } else t.phase = after(res);
      } else {
        if (res.text || res.ok) t.result = { ...res, text: res.text || t.result.text };
        t.phase = after(t.result);
      }
      break;
    }
    // 4. The app's answer check: the reply's checks block through sympy, no model. Wrong answers go back once.
    if (t.phase === "check") {
      const list = checksFrom(t.result.text);
      const t0 = Date.now();
      const r = await agentTools(id, { names: ["check_answers"] })[0].run({ problems: list });
      const results = r.results || [];
      const by = (st) => results.filter((x) => x.status === st).map((x) => x.id);
      t.checks = { total: results.length, ok: by("ok"), wrong: by("wrong"), unchecked: by("error"), text: r.text, at: new Date().toISOString() };
      const tool = { id: `app-check-${t.tools.length}`, name: "check_answers", by: "app", input: { problems: list.length }, ok: !!r.ok, ms: Date.now() - t0, chars: r.text.length, preview: r.text };
      emit({ type: "tool", tool }); emit({ type: "tool_result", tool });
      account("check", "sympy", null, [tool], { checked: results.length, wrong: t.checks.wrong.length });
      logEvent("stage", "app-check", { week: id, total: results.length, wrong: t.checks.wrong.length, unchecked: t.checks.unchecked.length });
      const wrong = results.filter((x) => x.status === "wrong");
      if (wrong.length && !t.rechecked && left() > 0 && !stopped.has(id)) {
        t.rechecked = true;
        t.recheckPrompt = recheckPrompt(wrong.map((x) => `${x.id}: ${x.msg}`).join("\n"), t.stage);
        t.phase = "recheck";
      } else t.phase = "wrap";
    }
  } catch (e) {
    logEvent("server", "turn-error", { week: id, phase: t.phase, error: e.stack || e.message });
    t.result = { ok: false, error: e.message, text: t.result?.text || t.cur?.text || "" };
    t.phase = "wrap";
  } finally { clearInterval(heartbeat); }

  // 4. Wrap up: the reply joins the week.
  if (t.phase === "wrap") {
    const w = await loadWeek(id);
    if (week.started) w.started = true;
    const result = t.result || { ok: false, error: "no reply" };
    if (result.text || result.ok) {
      // The checks block is for the app: the teacher sees its verdict (checks) instead.
      w.messages.push({ role: "assistant", text: stripChecks(result.text), at: new Date().toISOString(), error: result.ok ? undefined : result.error, usage: t.usage || undefined, tools: t.tools, trace: live.trace, stage: t.stage, model: modelFor(t.stage, w), stages: t.stages, ...(t.preamble ? { preamble: stripChecks(t.preamble) } : {}), ...(t.checks ? { checks: t.checks } : {}) });
    } else {
      if (w.messages.at(-1)?.role === "user") w.messages.pop(); // nothing happened; let the teacher retry
      w.lastError = result.error;
    }
    await saveWeek(w);
    progress.delete(id);
    stopped.delete(id);
    await fsp.writeFile(turnPath(id), JSON.stringify({ phase: "done", endedAt: new Date().toISOString() }));
    // The week (with the reply) must be in storage before anyone is told the turn ended: a page that polls in
    // between would otherwise read the old week from another instance and show no reply.
    if (mirror.enabled) await mirror.push().catch((e) => logEvent("mirror", "push-error", { error: e.message }));
    await shareJob(id, { running: false }, { force: true });
    emit(result.ok ? { type: "done" } : { type: "error", error: result.error });
    return { done: true };
  }
  await fsp.writeFile(turnPath(id), JSON.stringify(t));
  await share(true);
  return { done: false };
}

// Hosted: one workflow step. Pull, run a slice inside the function limit, push.
export async function turnStep(id) {
  const t0 = Date.now();
  try { await mirror.pull(); } catch (e) { logEvent("mirror", "pull-error", { error: e.message }); }
  const r = await turnSlice(id, { deadline: t0 + SLICE_SOFT, hardDeadline: t0 + SLICE_HARD });
  logEvent("stage", "slice", { week: id, ms: Date.now() - t0, done: r.done });
  await mirror.push();
  return r;
}

// Starts a turn already written to its turn file: in-process locally, as a workflow run when hosted.
async function startTurn(id) {
  if (!USE_WORKFLOW) {
    // HW_SLICE_LOCAL=1 slices a local turn the way hosting does (to test pause and resume without deploying).
    const lim = () => (process.env.HW_SLICE_LOCAL === "1" ? { deadline: Date.now() + SLICE_SOFT, hardDeadline: Date.now() + SLICE_HARD } : {});
    while (!(await turnSlice(id, lim())).done);
    return null;
  }
  await mirror.push(); // the step may land on another instance: it must find the turn file and the week
  const { start } = await import("workflow/api");
  // The id the workflow build gives workflows/turn.mjs's weekTurn (see .well-known/workflow/v1/manifest.json).
  const run = await start({ workflowId: "workflow//./workflows/turn//weekTurn" }, [id]);
  logEvent("stage", "workflow-start", { week: id, runId: run.runId });
  return run.runId;
}

// What each stage would do for a message, without running anything (logged; returned by HW_DRY_STAGES=1).
function planStages(kind, week, brief) {
  const stage = stageFor(kind, week);
  const out = [];
  if (kind === "start") out.push({ stage: "research", model: STAGES.research.model, skip: !brief.needsResearch.length, why: brief.needsResearch.length ? `corpus thin for ${brief.needsResearch.join(", ")}` : "corpus covers every section" });
  out.push({ stage, model: modelFor(stage, week), why: STAGES[stage].why });
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
// The app's answer-check verdicts for the latest .tex: from its reply and any check-only replies after it.
export function appChecks(week) {
  const i = week.messages.findLastIndex((m) => m.role === "assistant" && /```(latex|tex)\n/.test(m.text));
  const out = { ok: new Set(), wrong: new Set(), unchecked: new Set() };
  if (i < 0) return out;
  for (const m of week.messages.slice(i)) {
    if (m.role !== "assistant" || !m.checks) continue;
    for (const [k, ids] of Object.entries({ ok: m.checks.ok, wrong: m.checks.wrong, unchecked: m.checks.unchecked }))
      for (const x of ids || []) { for (const s of Object.values(out)) s.delete(x); out[k].add(x); }
  }
  return out;
}
function saveManifest(week, name, tex) {
  const list = attachTex(manifestFrom(week), tex);
  if (!list.length) return { added: 0, merged: 0, total: 0 };
  const date = dateFromName(name) || new Date().toISOString().slice(0, 10);
  const items = loadCorpus();
  // Cached verification: a problem used verbatim, with the same answer, keeps the corpus copy's CAS check.
  // The app's own check of the final's checks block: passing answers are verified, failing ones are not.
  const ck = appChecks(week);
  for (const p of list) {
    const key = `P${p.part}.${p.n}`;
    if (ck.wrong.has(key) || ck.unchecked.has(key)) p.casVerified = false;
    else if (ck.ok.has(key)) p.casVerified = true;
    const pid = problemId(p.tex), have = items.find((x) => x.id === pid);
    if (have?.casVerified && sameAnswer(have.answer, p.answer)) p.casVerified = true;
  }
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
// every course with its versions and board sizes (the Progress map's picker)
function curriculaList(db) {
  const n = db.prepare("SELECT layer, COUNT(*) n FROM node_revision WHERE version_id = ? GROUP BY layer");
  return Cur.listCurricula(db).map((c) => {
    const v = Cur.draftOf(db, c.id) || Cur.latestPublished(db, c.id);
    const counts = v ? Object.fromEntries(n.all(v.id).map((r) => [r.layer, r.n])) : {};
    return { id: c.id, title: c.title, version: v && { id: v.id, seq: v.seq, status: v.status }, content: counts.content || 0, methods: counts.methods || 0 };
  });
}
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
    `You are estimating how far a student${STUDENT ? ` (${STUDENT})` : ""} has got through H. Wu's algebra, using two dependency graphs of the material and the evidence below: every homework set the student was given (with dates), the teacher's unit statuses, and any uploaded notes.`,
    "",
    "First write your reasoning under a \"## Reasoning\" heading, for the teacher to read later: go through the material in order (a few lines per ladder unit or group of nodes), saying what the homework and notes show and why you chose each state. Call out anything uncertain or where you disagree with the teacher's unit statuses. Keep it under about 700 words.",
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
    "- Treat the unit statuses as the teacher's view, but judge from the homework. Don't fill gaps by assumption.",
    binary.length ? `- Also use the uploaded note files attached after this text: ${binary.map((b) => b.name).join(", ")}` : "",
    "",
    "## Wu content DAG (arrow A -> B: A is used for B)", nodeLines(content, ""), "", edgeLines(content, ""),
    "", "## Wu methods DAG (arrow A -> B: A is used as a sub-step of B; 'rests on' = content node)", nodeLines(methods, "m:"), "", edgeLines(methods, "m:"),
    "", "## Curriculum ladder", ladder, "", "## The teacher's unit statuses", statusDigest(status), "", "## Evidence files", ...files,
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
    const { text, source } = await body(req);
    if (typeof text !== "string" || !text.trim()) return send(res, 400, { error: "empty status" });
    if (source === "upload") { const bad = checkStatusUpload(text); if (bad) return send(res, 400, { error: `Not uploaded: ${bad}.` }); }
    await writeStatus(text.replace(/\r\n/g, "\n"), { source: source === "upload" ? "upload" : "teacher" });
    if (source === "upload") logEvent("server", "status-upload", { chars: text.length });
    return send(res, 200, { ok: true });
  }
  if (m === "GET" && p === "/api/status/export") {
    const c = C();
    const text = await readStatus(c);
    const who = (c.studentName || "student").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "student";
    res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="status_${who}_${new Date().toISOString().slice(0, 10)}.md"` });
    return res.end(text);
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
  if (m === "POST" && p === "/api/corpus/chat") {
    // Read-only questions about the corpus. The browser sends the whole (text-only) conversation each time.
    const { messages: turns = [] } = await body(req);
    const hist = (Array.isArray(turns) ? turns : []).slice(-20).filter((t) => t && ["user", "assistant"].includes(t.role) && typeof t.text === "string" && t.text.trim());
    if (hist.at(-1)?.role !== "user") return send(res, 400, { error: "the last message must be the teacher's" });
    const messages = [];
    for (const t of hist) pushTurn(messages, t.role, t.text.slice(0, 20000));
    const c = C(), items = loadCorpus();
    const r = await callAgent({ key: `corpus-chat-${randomUUID().slice(0, 8)}`, model: CHAT_MODEL, system: corpusChatSystem(items, await readLadder(c)), messages, toolNames: ["corpus_search"], effort: "low", budgetUSD: BUDGET ? Number(BUDGET) : 1 });
    if (!r.ok && !r.text) return send(res, 502, { error: r.error || "no reply" });
    const reply = r.text.trim();
    return send(res, 200, { text: reply, ids: citedIds(reply, items), error: r.ok ? undefined : r.error, costUSD: r.usage?.costUSD ?? null, tools: r.tools.map((t) => ({ name: t.name, input: t.input, ok: t.ok })) });
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
    const c = CB(req, url);
    if (!c) return noCourse(res);
    const vid = Number(url.searchParams.get("version")) || c.versionId;
    const ver = Cur.getVersion(c.db, vid);
    if (!ver || ver.curriculum_id !== c.curriculumId) return send(res, 404, { error: "no such version" });
    const st = c.browsing ? { guess: null, overrides: {}, runs: [] } : dagState(c, vid);
    const job = guessJob?.running ? guessJob : (await remoteJob("dag-guess")) || guessJob;
    return send(res, 200, {
      content: Cur.graphFor(c.db, vid, "content"), methods: Cur.graphFor(c.db, vid, "methods"), guess: st.guess, overrides: st.overrides || {},
      job: job && { ...job, elapsed: job.startedAt ? Date.now() - job.startedAt : 0 }, notes: await noteFiles(), guessModel: GUESS_MODEL, runs: st.runs.map(runSummary),
      version: { id: ver.id, seq: ver.seq, status: ver.status, enrolled: c.browsing ? null : c.versionId }, versions: Cur.listVersions(c.db, c.curriculumId).map((v) => ({ id: v.id, seq: v.seq, status: v.status })),
      scopeSeq: Cur.scopeSeqFor(c.db, vid), comments: Cur.commentsFor(c.db, c.curriculumId),
      curriculum: { id: c.curriculumId, title: c.db.prepare("SELECT title FROM curriculum WHERE id = ?").get(c.curriculumId)?.title || c.curriculumId, browsing: !!c.browsing },
      curricula: curriculaList(c.db),
    });
  }
  // every course, for the Progress map's picker
  if (m === "GET" && p === "/api/curricula") return send(res, 200, { curricula: curriculaList(C().db), enrolled: C().curriculumId });
  // the curriculum's edit history (Progress map › History): draft edits, imports, publishes, discards, comments
  if (m === "GET" && p === "/api/dag/history") { const c = CB(req, url); if (!c) return noCourse(res); return send(res, 200, { edits: Cur.editHistory(c.db, c.curriculumId) }); }
  // comments on nodes: {key, text} to add, {text} to change; they belong to the key, so any version can take them
  if (m === "POST" && p === "/api/comments") {
    const { key, text } = await body(req);
    const c = CB(req, url);
    if (!c) return noCourse(res);
    try { Cur.addComment(c.db, c.curriculumId, String(key || ""), text); } catch (e) { return send(res, 400, { error: e.message }); }
    return send(res, 200, { comments: Cur.commentsFor(c.db, c.curriculumId) });
  }
  const cmm = p.match(/^\/api\/comments\/(\d+)$/);
  if (cmm && (m === "PATCH" || m === "DELETE")) {
    const c = CB(req, url);
    if (!c) return noCourse(res);
    try {
      if (m === "PATCH") Cur.updateComment(c.db, c.curriculumId, Number(cmm[1]), (await body(req)).text);
      else Cur.deleteComment(c.db, c.curriculumId, Number(cmm[1]));
    } catch (e) { return send(res, /no such/.test(e.message) ? 404 : 400, { error: e.message }); }
    return send(res, 200, { comments: Cur.commentsFor(c.db, c.curriculumId) });
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
  // Content / Methods boards as Markdown (public/progressmd.js): a deterministic export and import of the
  // teacher's states, at the enrolled version. An import with any error changes nothing.
  if (m === "GET" && p === "/api/dag/export") {
    const c = C(), board = url.searchParams.get("board");
    if (!["content", "methods"].includes(board)) return send(res, 400, { error: "board must be content or methods" });
    const st = dagState(c);
    const text = exportBoardMd({ board, dag: Cur.graphFor(c.db, c.versionId, board), guess: st.guess, overrides: st.overrides, student: c.studentName || "" });
    const who = (c.studentName || "student").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "student";
    res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${board}_${who}_${new Date().toISOString().slice(0, 10)}.md"` });
    return res.end(text);
  }
  if (m === "POST" && p === "/api/dag/import") {
    const { board, text } = await body(req);
    if (!["content", "methods"].includes(board)) return send(res, 400, { error: "board must be content or methods" });
    const c = C(), st = dagState(c);
    const { changes, errors } = parseBoardMd(text, { board, dag: Cur.graphFor(c.db, c.versionId, board), guess: st.guess, overrides: st.overrides });
    if (errors.length) return send(res, 400, { error: `Not imported: ${errors.slice(0, 5).join("; ")}${errors.length > 5 ? ` (and ${errors.length - 5} more)` : ""}.`, errors });
    tx(c.db, () => { for (const x of changes) Prog.recordEvent(c.db, c.enrollmentId, { key: x.key, state: x.state ?? "cleared", note: "imported", source: "teacher" }); });
    logEvent("server", "dag-import", { board, changed: changes.length });
    return send(res, 200, { overrides: dagState(c).overrides, changed: changes.length });
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
    // Switch the active student/course. The root curriculum_ladder.md follows it.
    const { id } = await body(req);
    const c = C();
    if (!Prog.getEnrollment(c.db, Number(id))) return send(res, 404, { error: "no such enrollment" });
    setActiveEnrollment(c.db, Number(id));
    setSetting(c.db, "ladder_export_hash", "");
    const n = C();
    // A student with no status yet starts from a blank one, never from the previous student's file.
    const text = latestStatus(n)?.text ?? `# Weekly status: ${n.studentName}\n\nNothing taught yet.\n`;
    if (!latestStatus(n)) saveStatus(n, text, { source: "teacher" });
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
    const c = CB(req, url);
    if (!c) return noCourse(res);
    const draft = Cur.draftOf(c.db, c.curriculumId);
    return send(res, 200, {
      curriculum: c.db.prepare("SELECT * FROM curriculum WHERE id = ?").get(c.curriculumId), versions: Cur.listVersions(c.db, c.curriculumId), enrolled: c.browsing ? null : c.versionId,
      enrollments: Prog.listEnrollments(c.db).filter((e) => e.curriculum_id === c.curriculumId),
      draft: draft && { id: draft.id, seq: draft.seq, note: draft.note, unresolved: Cur.unresolvedRemovals(c.db, draft.id), diff: draft.parent_id ? Cur.diffVersions(c.db, draft.parent_id, draft.id) : null },
      retag: c.db.prepare("SELECT COUNT(*) n FROM retag_queue WHERE done_at IS NULL").get().n,
    });
  }
  const vm = p.match(/^\/api\/versions\/(\d+)(\/diff|\/publish)?$/);
  if (vm) {
    const c = CB(req, url), vid = Number(vm[1]);
    if (!c) return noCourse(res);
    const ver = Cur.getVersion(c.db, vid);
    if (!ver || ver.curriculum_id !== c.curriculumId) return send(res, 404, { error: "no such version" });
    if (m === "GET" && !vm[2]) return send(res, 200, { ...ver, meta_json: undefined, scopeSeq: Cur.scopeSeqFor(c.db, vid), ladder: Cur.ladderFor(c.db, vid) });
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
    const c = CB(req, url);
    if (!c) return noCourse(res);
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
    const { title, model, replace } = await body(req);
    const base = (title || "week").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "week";
    // One unfinished week per title: a second click (or a second tab) offers that week back instead of
    // starting a parallel one. Finished weeks don't count, so a second set for the same date still works.
    if (creating.has(base)) return send(res, 409, { error: "already being created", existing: [] });
    creating.add(base);
    try {
      const same = new RegExp(`^${base}(-\\d+)?$`);
      const open = [];
      for (const w of await listWeeks()) {
        if (!same.test(w.id) || w.done) continue;
        open.push({ ...w, running: running.has(w.id) || !!(await remoteJob(w.id)) });
      }
      if (open.length && !replace) return send(res, 409, { error: `${title} is already in progress`, existing: open });
      if (open.some((w) => w.running)) return send(res, 409, { error: `${title} is still running; stop it before replacing it`, existing: open });
      for (const w of open) await deleteWeekFiles(w.id);
      return send(res, 200, await createWeek(base, title, model));
    } finally { creating.delete(base); }
  }
  const wm = p.match(/^\/api\/weeks\/([A-Za-z0-9_-]+)(\/message|\/stop|\/finish|\/tools)?$/);
  if (wm) {
    const [, id, action] = wm;
    if (m === "GET" && !action) {
      const here = running.has(id) || (!USE_WORKFLOW && progress.has(id));
      const remote = here ? null : await remoteJob(id);
      const wk = await loadWeek(id);
      let mapUpdate = null;
      if (!wk.done) try { mapUpdate = weekMapUpdate(wk); } catch (e) { mapUpdate = { error: e.message, items: [] }; }
      return send(res, 200, { ...wk, mapUpdate, running: here || !!remote, live: (here && progress.get(id)) || remote?.live || null });
    }
    if (m === "GET" && action === "/tools") return send(res, 200, { calls: await readToolLog(id) });
    if (m === "DELETE" && !action) {
      await deleteWeekFiles(id);
      return send(res, 200, { ok: true });
    }
    if (m === "POST" && action === "/finish") {
      // One click: save the .tex into the project, (optionally) next week's status, and the problems into the corpus.
      // The app applies the status changes itself: the week's promotions plus the final's status-update block.
      const { name, tex, updateStatus, overwrite, mapUpdate: acceptMap = [] } = await body(req);
      if (!TEX_NAME.test(name || "")) return send(res, 400, { error: "Filename must look like hw_11_28_2026.tex" });
      const dest = path.join(ROOT, name);
      if (fs.existsSync(dest) && !overwrite) return send(res, 409, { error: `${name} already exists` });
      await fsp.writeFile(dest, tex);
      const week = await loadWeek(id);
      let statusUpdated = false;
      if (updateStatus) {
        const wc = weekCtx(week), base = await readStatus(wc);
        const fin = [...week.messages].reverse().find((x) => x.role === "assistant" && /```(latex|tex)\n/.test(x.text || ""));
        const next = applyWeekUpdate(base, weekUpdateInputs(week, fin, base));
        if (next.trimEnd() !== base.trimEnd()) { await writeStatus(next.trimEnd() + "\n", { source: "claude", assignmentId: id, c: wc }); statusUpdated = true; }
      }
      let corpus = null;
      try { corpus = saveManifest(week, name, tex); tagInBackground(corpus.toTag || [], name); delete corpus.toTag; } catch (e) { corpus = { error: e.message }; }
      let mapUpdated = null;
      try { mapUpdated = applyMapUpdate(week, Array.isArray(acceptMap) ? acceptMap.map(Number) : []); } catch (e) { mapUpdated = { error: e.message }; }
      Object.assign(week, { done: true, savedAs: name, statusUpdated, corpusSaved: corpus, mapUpdated });
      await saveWeek(week);
      return send(res, 200, { ok: true, corpus });
    }
    if (m === "POST" && action === "/stop") { stopped.add(id); running.get(id)?.abort(); await requestStop(id); return send(res, 200, { ok: true }); }
    if (m === "POST" && action === "/message") {
      if (running.has(id) || (!USE_WORKFLOW && progress.has(id)) || (await remoteJob(id))) return send(res, 409, { error: "Claude is already working on this week" });
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
        userMsg.brief = { date: brief.date, promotions: brief.promotions, decisions: brief.decisions, comments: brief.comments.reduce((n, x) => n + x.texts.length, 0), sections: brief.sections.map(({ corpusIds, ...x }) => x), needsResearch: brief.needsResearch };
        prompt += `\n\n# Brief from the app (this week's whole input, settled before you were called)\n${briefText(brief)}\n\n## Corpus problems for this week (${corpus.length} in the corpus; search for more with corpus_search)\n${formatHits(hits)}`;
      }
      if (DRY_STAGES) {
        const plan = planStages(userMsg.kind, week, brief || (await weekBrief(overrides || {}, wc)));
        logEvent("stage", "dry-run", { week: id, kind, plan });
        return send(res, 200, { dryRun: true, plan, promptChars: prompt.length, prompt: clip(prompt, 20000) });
      }
      if (kind === "start" && !week.started) week.messages = []; // a retry replaces the start that got no reply
      week.messages.push(userMsg);
      await saveWeek(week);

      const live = { text: "", tools: [], trace: [], startedAt: Date.now() };
      const needsResearch = !!brief?.needsResearch.length && !STAGES_OFF.has("research");
      await fsp.writeFile(turnPath(id), JSON.stringify({ id, kind, stage, prompt, sys, brief: needsResearch ? brief : null, phase: needsResearch ? "research" : "main", live, stages: [], usage: null, tools: [] }));
      stopped.delete(id);
      await clearStop(id);
      await shareJob(id, { running: true, live }, { force: true });

      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      if (USE_WORKFLOW) {
        // The run outlives this request; the page follows it by polling GET /api/weeks/:id as it does anyway.
        try {
          const runId = await startTurn(id);
          res.write(JSON.stringify({ type: "started", runId }) + "\n");
        } catch (e) {
          logEvent("stage", "workflow-start-error", { week: id, error: e.message });
          week.messages.pop(); week.lastError = e.message; await saveWeek(week);
          if (mirror.enabled) await mirror.push().catch(() => {});
          await shareJob(id, { running: false }, { force: true });
          res.write(JSON.stringify({ type: "error", error: "could not start the turn: " + e.message }) + "\n");
        }
        return res.end();
      }
      let clientGone = false;
      res.on("close", () => (clientGone = true));
      sinks.set(id, (e) => { if (!clientGone) res.write(JSON.stringify(e) + "\n"); });
      try { await startTurn(id); } finally { sinks.delete(id); }
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
let login = null, pulledOnce = false;
export async function app(req, res) {
  login ??= createLogin({ hash: PASSWORD_HASH, dataDir: DATA, trustProxy: process.env.HW_TRUST_PROXY === "1" || !!process.env.VERCEL });
  const t0 = Date.now();
  const u = req.url.split("?")[0];
  const dynamic = !u.startsWith("/") || u.startsWith("/api/") || u.startsWith("/build/") || u === "/";
  // A fresh instance pulls on its first request whatever it is: otherwise a static file (main.js) that lands
  // on a new instance before any API call finds no sessions.json and redirects the module to the login page.
  if (dynamic || !pulledOnce) { try { await mirror.pull(); pulledOnce = true; } catch (e) { logEvent("mirror", "pull-error", { error: e.message }); } }
  const dbStamp = () => { try { const s = fs.statSync(path.join(DATA, "hw.db")); return `${s.size}:${s.mtimeMs}`; } catch { return null; } };
  const dbBefore = mirror.enabled ? dbStamp() : null;
  try {
    try { if (await login.gate(req, res)) return; } catch (e) { if (!res.headersSent) send(res, 500, { error: e.message }); return; }
    // Static files and the log endpoints themselves would drown everything else out.
    if (u.startsWith("/api/") && u !== "/api/log" && u !== "/api/logs") res.on("finish", () => logEvent("http", `${req.method} ${u}`, { status: res.statusCode, ms: Date.now() - t0 }));
    try { await handle(req, res); }
    catch (e) { logEvent("server", "error", { path: u, error: e.stack || e.message }); if (!res.headersSent) send(res, 500, { error: e.message }); else res.end(); }
  } finally {
    // Writes (including a login, which the gate answers itself) go to durable storage before the instance can sleep.
    // A GET can write hw.db too: the first one migrates the v0 files, and reads of the root status/ladder files
    // record hand edits. Push those as well, or they would stay on this instance.
    if (mirror.enabled && (req.method !== "GET" || dbStamp() !== dbBefore)) { try { await mirror.push(); } catch (e) { logEvent("mirror", "push-error", { error: e.message }); } }
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
