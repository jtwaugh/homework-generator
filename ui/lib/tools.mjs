// The app's own tools, shared by the agent loop (in process) and the MCP server (ui/mcp/hw-tools.mjs):
//   cas(code)                      Python + sympy in a sandbox (no network, writes only to a temp dir, 20 s)
//   check_answers({problems:[...]}) rote answer checks: fixed sympy code over {id, kind, expr, claimed} (lib/check.mjs)
//   corpus_search({units,query})   search the problem corpus
//   corpus_add({problems:[...]})   cache good problems found during research
// CAS runs locally from ui/data/venv, or, when HW_CAS_URL is set (hosted), via the Python function at that URL.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DATA, loadCorpus, searchCorpus, formatHits, addProblems } from "./corpus.mjs";
import { checkAnswers, CHECK_ITEM_SCHEMA } from "./check.mjs";

const PY = path.join(DATA, "venv", "bin", "python");
export const CAS_TIMEOUT = 20000;

export const TOOLS = [
  {
    name: "cas",
    description: "Run a short Python program and return its stdout/stderr. Already imported, so you never need import lines: sympy as sp plus everything from sympy (symbols, solve, Eq, Rational, sqrt, simplify, factor, expand, ...), math, itertools, functools, collections, fractions.Fraction, and the symbols x y z t a b c k m n (real). Your own imports and symbol definitions still work and override these. For checking answer keys use check_answers instead; use cas only for what it can't express (randomized sets, searching for numbers that give integer roots, word problems that need setting up). Print only what's wrong plus one count line (e.g. 'checked 14, 0 wrong'), never a line per passing item: everything printed is paid for on every later call. No network or file access; 20 second limit.",
    inputSchema: { type: "object", properties: { code: { type: "string", description: "Python source; print() what you want to see." } }, required: ["code"] },
  },
  {
    name: "check_answers",
    description: "Check answer keys with sympy, no code needed: list each problem as {id, kind, expr, claimed}. solve: equations (extraneous roots and excluded values handled), inequalities, compound inequalities, absolute value, literal equations (give vars), systems (';' between equations). equal: simplify/factor/expand/evaluate answers (form: 'factored' also requires complete factoring). Returns one count line plus a line only for each wrong or uncheckable item. Leave claimed out to get the CAS's answer instead. Put every problem in one call.",
    inputSchema: { type: "object", properties: { problems: { type: "array", items: CHECK_ITEM_SCHEMA } }, required: ["problems"] },
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
        similarTo: { type: "string", description: "Optional problem LaTeX: finds the same problem type even with different numbers, variables or wording" },
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

// The model often forgets imports (itertools, Fraction, ...), so run.py preloads the usual ones and then runs
// main.py in that namespace. Compiling under the name "main.py" keeps traceback line numbers matching its code.
// (api/cas.py uses the same prelude when hosted.)
export const PRELUDE = `import math, itertools, functools, collections, fractions, random
import sympy as sp
from sympy import *
from fractions import Fraction
from itertools import product, permutations, combinations
x, y, z, t, a, b, c, k, m, n = symbols("x y z t a b c k m n", real=True)
__ns = {k_: v_ for k_, v_ in globals().items() if not k_.startswith("__")}
__ns["__name__"] = "__main__"
with open("main.py") as __f:
    exec(compile(__f.read(), "main.py", "exec"), __ns)
`;

// The sympy service: HW_CAS_URL, or (hosted on Vercel) this deployment's own Python function at /api/cas.
export const casRemote = (env = process.env) => {
  if (env.HW_CAS_URL) return env.HW_CAS_URL;
  if (!env.VERCEL) return "";
  const host = (env.VERCEL_ENV === "production" && env.VERCEL_PROJECT_PRODUCTION_URL) || env.VERCEL_URL;
  return host ? `https://${host}/api/cas` : "";
};

async function runCasRemote(code, signal) {
  try {
    const r = await fetch(casRemote(), {
      method: "POST", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(CAS_TIMEOUT + 15000)]) : AbortSignal.timeout(CAS_TIMEOUT + 15000),
      headers: { "content-type": "application/json", ...(process.env.HW_INTERNAL_TOKEN ? { authorization: `Bearer ${process.env.HW_INTERNAL_TOKEN}` } : {}),
        // Preview deployments sit behind Vercel Authentication; this lets the app reach its own function.
        ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET } : {}) },
      body: JSON.stringify({ code, prelude: PRELUDE, timeoutMs: CAS_TIMEOUT }),
    });
    if (!r.ok) return { ok: false, text: `CAS service error ${r.status}: ${(await r.text()).slice(0, 300)}` };
    const j = await r.json();
    return { ok: !!j.ok, text: j.text || "(no output; use print())" };
  } catch (e) {
    return { ok: false, text: "CAS service unreachable: " + e.message };
  }
}

export async function runCas(code, { signal } = {}) {
  if (casRemote()) return runCasRemote(code, signal);
  if (!fs.existsSync(PY)) return { ok: false, text: "CAS unavailable: run `uv venv ui/data/venv && uv pip install --python ui/data/venv sympy`." };
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "hw-cas-")));
  await fsp.writeFile(path.join(dir, "main.py"), code);
  await fsp.writeFile(path.join(dir, "run.py"), PRELUDE);
  const profile = `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath "${dir}") (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty"))`;
  const useSandbox = fs.existsSync("/usr/bin/sandbox-exec");
  const [cmd, args] = useSandbox ? ["/usr/bin/sandbox-exec", ["-p", profile, PY, "-I", "-B", "run.py"]] : [PY, ["-I", "-B", "run.py"]];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: dir, env: { PATH: "/usr/bin:/bin", HOME: dir, MPLBACKEND: "Agg" } });
    let out = "", err = "", killed = false;
    const kill = () => { killed = true; child.kill("SIGKILL"); };
    const t = setTimeout(kill, CAS_TIMEOUT);
    signal?.addEventListener("abort", kill, { once: true });
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

export async function callTool(name, args = {}, { weekId = "", signal } = {}) {
  if (name === "cas") {
    if (typeof args.code !== "string" || !args.code.trim()) return { ok: false, text: "code is required" };
    return runCas(args.code, { signal });
  }
  if (name === "check_answers") {
    if (!Array.isArray(args.problems) || !args.problems.length) return { ok: false, text: "problems must be a non-empty array" };
    const r = await checkAnswers(args.problems, runCas, { signal });
    return { ...r, checked: r.results.length, wrong: r.results.filter((x) => x.status === "wrong").length };
  }
  if (name === "corpus_search") {
    const hits = searchCorpus(loadCorpus(), { units: args.units, query: args.query, wuNodes: args.wuNodes, similarTo: args.similarTo, limit: Math.min(30, args.limit || 10) });
    return { ok: true, text: formatHits(hits), hits: hits.length };
  }
  if (name === "corpus_add") {
    const list = Array.isArray(args.problems) ? args.problems : [];
    const today = new Date().toISOString().slice(0, 10);
    const r = addProblems(loadCorpus(), list.map((p) => ({
      tex: p.tex, answer: p.answer, units: p.units, tags: p.tags, casVerified: p.casVerified, status: "candidate",
      source: { kind: p.url ? "web" : "claude", url: p.url, note: p.note, date: today, week: weekId || undefined },
    })));
    return { ok: true, text: `saved ${r.added.length} new, ${r.merged.length} already in the corpus`, added: r.added.length };
  }
  return { ok: false, text: `unknown tool ${name}` };
}

// Tools for the agent loop: every call is logged to weeks/<weekId>.tools.jsonl (the week's Tools view reads it).
export function agentTools(weekId = "", { names = TOOLS.map((t) => t.name), append } = {}) {
  const LOG = weekId && /^[A-Za-z0-9_-]+$/.test(weekId) ? path.join(DATA, "weeks", `${weekId}.tools.jsonl`) : null;
  const write = append || ((line) => (LOG ? fsp.appendFile(LOG, line) : Promise.resolve()));
  return TOOLS.filter((t) => names.includes(t.name)).map((t) => ({
    name: t.name, description: t.description, input_schema: t.inputSchema,
    async run(input, { signal } = {}) {
      const t0 = Date.now();
      let r;
      try { r = await callTool(t.name, input, { weekId, signal }); } catch (e) { r = { ok: false, text: "tool error: " + e.message }; }
      const { text, ok, ...extra } = r;
      await write(JSON.stringify({ ts: new Date().toISOString(), tool: t.name, input, output: text, ok, ms: Date.now() - t0, ...extra }) + "\n").catch(() => {});
      return r;
    },
  }));
}
