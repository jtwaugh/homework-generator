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
  await test("initialize; tools are cas, check_answers, corpus_search, corpus_add", async () => {
    assert.equal((await rpc("initialize", { protocolVersion: "2025-06-18" })).result.serverInfo.name, "hw");
    assert.deepEqual((await rpc("tools/list", {})).result.tools.map((t) => t.name).sort(), ["cas", "check_answers", "corpus_add", "corpus_search"]);
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
  await test(`check_answers ${hasPy ? "reports only the wrong and uncheckable items" : "reports unavailable (no venv)"}`, async () => {
    const r = await call("check_answers", { problems: [
      { id: "P1.1", expr: "x^2 - 5x + 6 = 0", claimed: "x = 2, x = 3" },
      { id: "P1.2", expr: "sqrt(x+3) = x - 3", claimed: "x = 1, x = 6" }, // x = 1 is extraneous
      { id: "P1.3", expr: "1 < 2x + 1 <= 7", claimed: "(0, 3]" },
      { id: "P1.4", expr: "x + y = 3; x - y = 1", claimed: "(2, 1)" },
      { id: "P1.5", kind: "equal", expr: "2x^2 - 8", claimed: "2(x^2 - 4)", form: "factored" }, // not completely factored
      { id: "P1.6", expr: "\\frac{1}{x-2} = \\frac{x}{x-2} - 1", claimed: "no solution" },
      { id: "P1.7", expr: "|x - 1| > 2", claimed: "x < -1 or x > 3" },
      { id: "P1.8", expr: "x^2 + = 3", claimed: "1" },
      { id: "Q", expr: "x^2 - 2x - 1 = 0" }, // no claim: returns the CAS's answer
    ] });
    const t = r.content[0].text;
    if (!hasPy) return assert.match(t, /NOT CHECKED/);
    assert.match(t, /^5 ok, 2 wrong, 1 not checked/);
    assert.match(t, /P1\.2 WRONG: .*x=1 doesn't satisfy/);
    assert.match(t, /P1\.5 WRONG: not completely factored/);
    assert.match(t, /P1\.8 NOT CHECKED/);
    assert.match(t, /Q: x: \{1 [+-] sqrt\(2\), 1 [+-] sqrt\(2\)\}/);
    assert.doesNotMatch(t, /P1\.1|P1\.3|P1\.4|P1\.6|P1\.7/, "passing items cost no lines");
  });
} finally {
  srv.stdin.end(); srv.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
