#!/usr/bin/env node
// JSON-RPC test of the MCP tool server against a throwaway copy of the data dir (the real corpus is untouched).
//   node ui/scripts/test-mcp.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL = path.join(HERE, "..", "data");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hw-mcp-"));
fs.mkdirSync(path.join(TMP, "corpus")); fs.mkdirSync(path.join(TMP, "weeks"));
fs.copyFileSync(path.join(HERE, "fixtures", "problems.jsonl"), path.join(TMP, "corpus", "problems.jsonl")); // anonymous fixture, never the real corpus
if (fs.existsSync(path.join(REAL, "venv"))) fs.symlinkSync(path.join(REAL, "venv"), path.join(TMP, "venv"));

const srv = spawn(process.execPath, [path.join(HERE, "..", "mcp", "hw-tools.mjs")], { env: { ...process.env, HW_DATA: TMP, WEEK_ID: "mcptest" }, stdio: ["pipe", "pipe", "inherit"] });
let buf = "", seq = 0; const waiting = new Map();
srv.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id); } });
const rpc = (method, params) => new Promise((r) => { const id = ++seq; waiting.set(id, r); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;

let pass = 0, fail = 0;
const test = async (name, fn) => { try { await fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.log("  ✗", name, "\n    ", e.message); } };

try {
  await test("initialize; tools are cas, corpus_search, corpus_add", async () => {
    assert.equal((await rpc("initialize", { protocolVersion: "2025-06-18" })).result.serverInfo.name, "hw");
    assert.deepEqual((await rpc("tools/list", {})).result.tools.map((t) => t.name).sort(), ["cas", "corpus_add", "corpus_search"]);
  });
  await test("corpus_search returns hits for U01", async () => { const r = await call("corpus_search", { units: ["U01"], limit: 5 }); assert.ok(!r.isError); assert.match(r.content[0].text, /U01/); assert.match(r.content[0].text, /pf1c50000001|pf1c50000002/); });
  await test("corpus_add saves then dedupes", async () => {
    const p = { tex: `Solve $${Date.now() % 97}x = 0$ for $x$.`, answer: "$x=0$", units: ["U02"], tags: ["mcp-test"] };
    const a = await call("corpus_add", { problems: [p] }); assert.match(a.content[0].text, /saved 1 new/);
    const b = await call("corpus_add", { problems: [p] }); assert.match(b.content[0].text, /saved 0 new, 1 already/);
  });
  const hasPy = fs.existsSync(path.join(TMP, "venv", "bin", "python"));
  await test(`cas ${hasPy ? "solves with sympy" : "reports unavailable (no venv)"}`, async () => {
    const r = await call("cas", { code: "import sympy as sp\nx=sp.symbols('x')\nprint(sp.solve(x**2-5*x+6, x))" });
    if (hasPy) { assert.ok(!r.isError, r.content[0].text); assert.match(r.content[0].text, /\[2, 3\]/); }
    else assert.ok(r.isError);
  });
} finally {
  srv.stdin.end(); srv.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
