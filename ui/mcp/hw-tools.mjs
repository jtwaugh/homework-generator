#!/usr/bin/env node
// Local MCP tool server for the homework app (stdio, newline-delimited JSON-RPC, no dependencies).
//   cas(code)                      run Python + sympy in a sandbox (no network, writes only to a temp dir, 20 s)
//   corpus_search({units,query})   search ui/data/corpus/problems.jsonl
//   corpus_add({problems:[...]})   cache good problems found during research
// Env: WEEK_ID (calls are logged to data/weeks/<WEEK_ID>.tools.jsonl), HW_DATA (data dir).
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DATA, loadCorpus, searchCorpus, formatHits, addProblems } from "../lib/corpus.mjs";

const WEEK_ID = process.env.WEEK_ID || "";
const PY = path.join(DATA, "venv", "bin", "python");
const CAS_TIMEOUT = 20000;
const LOG = WEEK_ID && /^[A-Za-z0-9_-]+$/.test(WEEK_ID) ? path.join(DATA, "weeks", `${WEEK_ID}.tools.jsonl`) : null;

export const TOOLS = [
  {
    name: "cas",
    description: "Run a short Python program with sympy available (import sympy as sp) and return its stdout/stderr. Use it to verify answer keys: substitute each solution back, check for extraneous roots, confirm factorizations and simplifications. Batch many checks into one call and print one line per problem, e.g. 'P1.3 ok x=2'. No network or file access; 20 second limit.",
    inputSchema: { type: "object", properties: { code: { type: "string", description: "Python source; print() what you want to see." } }, required: ["code"] },
  },
  {
    name: "corpus_search",
    description: "Search the teacher's cache of homework problems (past sets, problems you saved from earlier research, teacher favorites). Returns problems with ids, units, status, when last used, source and answer. Prefer adapting these over a fresh web search.",
    inputSchema: {
      type: "object",
      properties: {
        units: { type: "array", items: { type: "string" }, description: "Ladder unit ids, e.g. [\"U14\", \"U05\"]" },
        query: { type: "string", description: "Keywords, e.g. 'systems of inequalities empty solution set'" },
        wuNodes: { type: "array", items: { type: "string" }, description: "Optional Wu DAG node ids (content eNN, methods m:eNN)" },
        limit: { type: "number", description: "Max results (default 10, max 30)" },
      },
    },
  },
  {
    name: "corpus_add",
    description: "Save good problems you found during research into the teacher's corpus, including ones you don't use this week, so later weeks can reuse them without searching again. Give each problem as LaTeX for the problem body (no \\item).",
    inputSchema: {
      type: "object",
      properties: {
        problems: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tex: { type: "string" }, answer: { type: "string" }, units: { type: "array", items: { type: "string" } },
              tags: { type: "array", items: { type: "string" } }, url: { type: "string", description: "Source URL, if from the web" },
              note: { type: "string", description: "Where it came from / how it was adapted" }, casVerified: { type: "boolean" },
            },
            required: ["tex"],
          },
        },
      },
      required: ["problems"],
    },
  },
];

// ---------- cas ----------

export async function runCas(code) {
  if (!fs.existsSync(PY)) return { ok: false, text: "CAS unavailable: run `uv venv ui/data/venv && uv pip install --python ui/data/venv sympy`." };
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "hw-cas-")));
  await fsp.writeFile(path.join(dir, "main.py"), code);
  const profile = `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath "${dir}") (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty"))`;
  const useSandbox = fs.existsSync("/usr/bin/sandbox-exec");
  const [cmd, args] = useSandbox ? ["/usr/bin/sandbox-exec", ["-p", profile, PY, "-I", "-B", "main.py"]] : [PY, ["-I", "-B", "main.py"]];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: dir, env: { PATH: "/usr/bin:/bin", HOME: dir, MPLBACKEND: "Agg" } });
    let out = "", err = "", killed = false;
    const t = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, CAS_TIMEOUT);
    child.stdout.on("data", (d) => { if (out.length < 60000) out += d; });
    child.stderr.on("data", (d) => { if (err.length < 20000) err += d; });
    child.on("close", (code) => {
      clearTimeout(t);
      fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      const parts = [];
      if (out) parts.push(out.trimEnd());
      if (err) parts.push("[stderr]\n" + err.trimEnd());
      if (killed) parts.push(`[killed after ${CAS_TIMEOUT / 1000} s]`);
      resolve({ ok: code === 0 && !killed, text: parts.join("\n") || "(no output; use print())" });
    });
    child.on("error", (e) => { clearTimeout(t); resolve({ ok: false, text: "could not run python: " + e.message }); });
  });
}

// ---------- dispatch ----------

export async function callTool(name, args = {}) {
  if (name === "cas") {
    if (typeof args.code !== "string" || !args.code.trim()) return { ok: false, text: "code is required" };
    return runCas(args.code);
  }
  if (name === "corpus_search") {
    const hits = searchCorpus(loadCorpus(), { units: args.units, query: args.query, wuNodes: args.wuNodes, limit: Math.min(30, args.limit || 10) });
    return { ok: true, text: formatHits(hits), hits: hits.length };
  }
  if (name === "corpus_add") {
    const list = Array.isArray(args.problems) ? args.problems : [];
    const today = new Date().toISOString().slice(0, 10);
    const r = addProblems(loadCorpus(), list.map((p) => ({
      tex: p.tex, answer: p.answer, units: p.units, tags: p.tags, casVerified: p.casVerified, status: "candidate",
      source: { kind: p.url ? "web" : "claude", url: p.url, note: p.note, date: today, week: WEEK_ID || undefined },
    })));
    return { ok: true, text: `saved ${r.added.length} new, ${r.merged.length} already in the corpus`, added: r.added.length };
  }
  return { ok: false, text: `unknown tool ${name}` };
}

async function logCall(entry) {
  if (!LOG) return;
  await fsp.appendFile(LOG, JSON.stringify(entry) + "\n").catch(() => {});
}

// ---------- JSON-RPC over stdio ----------

function reply(id, result, error) {
  process.stdout.write(JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }) + "\n");
}

async function onMessage(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, { protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "hw", version: "1.0.0" } });
  }
  if (method === "notifications/initialized" || method?.startsWith("notifications/")) return;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    const t0 = Date.now();
    const { name, arguments: args = {} } = params || {};
    let r;
    try { r = await callTool(name, args); } catch (e) { r = { ok: false, text: "tool error: " + e.message }; }
    const { text, ok, ...extra } = r;
    await logCall({ ts: new Date().toISOString(), tool: name, input: args, output: text, ok, ms: Date.now() - t0, ...extra });
    return reply(id, { content: [{ type: "text", text }], isError: !ok });
  }
  if (id !== undefined) reply(id, null, { code: -32601, message: `method not found: ${method}` });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  let buf = "";
  const inflight = new Set();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const p = onMessage(msg).catch((e) => msg.id !== undefined && reply(msg.id, null, { code: -32603, message: e.message }));
      inflight.add(p); p.finally(() => inflight.delete(p));
    }
  });
  process.stdin.on("end", async () => { await Promise.allSettled([...inflight]); process.exit(0); });
}
