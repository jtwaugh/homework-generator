#!/usr/bin/env node
// Drives the basic workflows through the harness MCP server (dev/harness.mjs mcp) against a sandbox copy
// of the app's files, and checks that each one shows up in the returned log with its effect.
// Nothing here runs Claude (Generate / Approve / Ask Claude / Guess are covered by the E2E run).
//
//   node ui/scripts/test-ui-mcp.mjs            (uses ports 4767 app, 4769 harness, 9353 Chrome)
//   KEEP=1 …                                   keep the sandbox and transcript for inspection
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeSandbox } from "../dev/sandbox.mjs";

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_PORT = 4767, CTRL = 4769, CDP = 9353;
const sb = makeSandbox();
const transcript = path.join(sb.dir, "transcript.txt");

// Fixed, anonymous fixtures (scripts/fixtures/) so the test behaves the same on any checkout and never uses
// real data: the example workflow/ladder/status, a three-problem corpus, and one small week.
const FIX = path.join(UI, "scripts", "fixtures"), EX = path.join(UI, "..", "examples");
for (const f of fs.readdirSync(sb.root)) fs.rmSync(path.join(sb.root, f), { recursive: true });
for (const f of fs.readdirSync(EX)) fs.copyFileSync(path.join(EX, f), path.join(sb.root, f));
fs.rmSync(path.join(sb.data, "weeks"), { recursive: true, force: true }); fs.mkdirSync(path.join(sb.data, "weeks"));
fs.rmSync(path.join(sb.data, "corpus"), { recursive: true, force: true }); fs.mkdirSync(path.join(sb.data, "corpus"));
fs.copyFileSync(path.join(FIX, "problems.jsonl"), path.join(sb.data, "corpus", "problems.jsonl"));
// a week that is waiting in the Final step
const w = JSON.parse(fs.readFileSync(path.join(FIX, "week.json"), "utf8"));
fs.writeFileSync(path.join(sb.data, "weeks", "TEST-final.json"), JSON.stringify(w));
// and one waiting on its outline: the same week cut after Claude's first reply
fs.writeFileSync(path.join(sb.data, "weeks", "TEST-outline.json"), JSON.stringify({ ...w, id: "TEST-outline", title: "TEST outline", messages: w.messages.slice(0, 2) }));

const app = spawn(process.execPath, [path.join(UI, "server.mjs")], { env: { ...process.env, PORT: APP_PORT, HW_ROOT: sb.root, HW_DATA: sb.data, HW_LOG_QUIET: "1", HW_NO_TAG: "1" }, stdio: "inherit" });
await new Promise((r) => setTimeout(r, 800));
const env = { ...process.env, APP_URL: `http://localhost:${APP_PORT}/`, HARNESS_PORT: CTRL, HARNESS_CDP_PORT: CDP };
const mcp = spawn(process.execPath, [path.join(UI, "dev", "harness.mjs"), "mcp"], { env, stdio: ["pipe", "pipe", "inherit"] });

let buf = "", seq = 0; const waiting = new Map();
mcp.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) { const m = JSON.parse(l); waiting.get(m.id)?.(m); waiting.delete(m.id); } } });
const rpc = (method, params) => new Promise((r) => { const id = ++seq; waiting.set(id, r); mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const withTimeout = (p, ms, what) => { let t; return Promise.race([p, new Promise((_, j) => (t = setTimeout(() => j(new Error(`timed out after ${ms / 1000}s: ${what}`)), ms)))]).finally(() => clearTimeout(t)); };
const tool = async (name, args = {}) => { const r = (await withTimeout(rpc("tools/call", { name, arguments: args }), (args.timeoutMs || 0) + 60000, name)).result; return { text: r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), image: r.content.some((c) => c.type === "image"), isError: r.isError }; };

let pass = 0, fail = 0; const out = [];
// step(label, tool, args, ...expect) — each expect is a regex that must match the tool's returned text
async function step(label, name, args, ...expect) {
  const t0 = Date.now(); let r; try { r = await tool(name, args); } catch (e) { r = { text: "FAILED: " + e.message, isError: true }; }
  out.push(`\n=== ${label}  (${name} ${JSON.stringify(args)})\n${r.text}`);
  const missing = expect.filter((re) => !re.test(r.text));
  if (r.isError || missing.length) { fail++; console.log(`  ✗ ${label}${r.isError ? "  [tool error]" : ""}${missing.length ? "  missing: " + missing.join(", ") : ""}\n      ${r.text.split("\n")[0]}`); }
  else { pass++; console.log(`  ✓ ${label}  ${((Date.now() - t0) / 1000).toFixed(1)}s`); }
  return r;
}
const sel = (s) => ({ selector: s });

try {
  await rpc("initialize", { protocolVersion: "2025-06-18" });
  await tool("ui_size", { width: 1440, height: 900 });
  await step("page loads", "ui_reload", {}, /ui: page-load/, /GET \/api\/state status=200/);
  await tool("ui_eval", { js: "window.confirm = () => true; window.alert = (m) => console.error('alert: ' + m); return 'dialogs stubbed'" });

  console.log("Check and save (a week waiting in Final)");
  await step("open History", "ui_click", sel(".nav-item[data-page=history]"), /ui: page from=create to=history/);
  await step("open the week", "ui_click", sel('#p-history li[data-id="TEST-final"]'), /GET \/api\/weeks\/TEST-final status=200/, /ui: page from=history to=create/);
  await step("PDF compiles", "ui_wait", { until: "__hw.summary().final?.compile === 'ok'", timeoutMs: 180000 }, /true after/);
  await step("Save & finish", "ui_click", sel("#v-final .savebar .main"), /POST \/api\/weeks\/TEST-final\/finish status=200/, /phase from=final to=done/);
  await step("Outline breadcrumb looks back", "ui_click", sel("#strip [data-step=outline]"), /step-click step=outline/);
  await step("outline shown read-only", "ui_eval", { js: "__hw.summary().peek + ' ' + document.querySelector('#v-outline .main').textContent" }, /outline Back to saved/);
  await step("back to saved", "ui_click", sel("#v-outline .main"), /click/);

  console.log("Review the outline");
  await step("open the week", "ui_click", sel(".nav-item[data-page=history]"), /ui: page from=\w+ to=history/);
  await step("list loads", "ui_wait", { until: "!!document.querySelector('#p-history li[data-id=\"TEST-outline\"]')", timeoutMs: 10000 }, /true after/);
  await step("pick it", "ui_click", sel('#p-history li[data-id="TEST-outline"]'), /GET \/api\/weeks\/TEST-outline/);
  await step("Start over", "ui_click", sel("#start-over"), /DELETE \/api\/weeks\/TEST-outline status=200/, /phase from=outline to=setup/);

  console.log("Set up the week");
  await step("date", "ui_type", { selector: "#f-date", text: "12/05/2026" }, /input el=#f-date value=12\/05\/2026/);
  await step("type a topic", "ui_type", { selector: "#f-topics .tinput", text: "linear inequalities" }, /input el=.*tinput/);
  await step("↩ adds the chip", "ui_key", { key: "Enter", selector: "#f-topics .tinput" }, /key key=Enter/, /weekInput.Topics: "" → "linear inequalities( \(U\d\d\))?"/i);
  await step("We moved on → pick a unit", "ui_click", sel("#units [data-act=choose]"), /data-act=choose/);
  await step("start it", "ui_click", sel("#units [data-act=start]"), /data-act=start/, /units.current: /);
  await step("autosaves weekly_status.md", "ui_wait", { until: "!__hw.summary().statusDirty", timeoutMs: 10000 }, /PUT \/api\/status status=200/);
  await step("Generate is offered", "ui_eval", { js: "document.querySelector('#generate').disabled ? 'disabled' : 'enabled'" }, /enabled/);
  await step("Quick set is offered", "ui_eval", { js: "document.querySelector('#quick-set')?.textContent" }, /Quick set/);

  console.log("Sidebar tabs");
  await step("Progress Map tab", "ui_click", sel(".nav-item[data-page=dag]"), /ui: page from=\w+ to=dag/, /GET \/api\/dag status=200/);
  await step("Methods sub-item", "ui_click", sel("[data-dag=methods]"), /GET \/api\/dag status=200/);
  await step("shows the methods board", "ui_eval", { js: "__hw.summary().dag.board" }, /methods/);
  await step("Inference history sub-item", "ui_click", sel("[data-dag=runs]"), /GET \/api\/dag status=200/);
  await step("lists runs", "ui_eval", { js: "document.querySelector('#p-dag .dag-runs') ? 'runs view' : 'missing'" }, /runs view/);
  await step("Content sub-item", "ui_click", sel("[data-dag=content]"), /GET \/api\/dag status=200/);
  await step("select a block", "ui_click", sel("#p-dag g.node[data-id=e28]"), /dag-select board=content id=e28/);
  await step("mark it done", "ui_click", sel("#p-dag [data-set=done]"), /PUT \/api\/dag status=200/);
  await step("Corpus tab", "ui_click", sel(".nav-item[data-page=corpus]"), /ui: page from=dag to=corpus/, /GET \/api\/corpus status=200/);
  await step("★ a problem", "ui_click", sel("#p-corpus .cp .star"), /data-set=favorite/, /PATCH \/api\/corpus\/\S+ status=200/);
  await step("back to Create Homework", "ui_click", sel(".nav-item[data-page=create]"), /ui: page from=corpus to=create/);
  await step("Create Homework again: fresh setup", "ui_click", sel(".nav-item[data-page=create]"), /page-reselect page=create/, /GET \/api\/state status=200/);
  await step("setup shown", "ui_eval", { js: "__hw.summary().phase" }, /setup/);
  await step("Cost opens", "ui_click", sel("[data-open=cost]"), /dialog-open id=cost-dlg/);
  await step("✕ closes", "ui_click", sel("#cost-dlg form button"), /dialog-close id=cost-dlg/);

  const all = out.join("\n");
  /EXCEPTION|ui: error |render-error|server: error/.test(all) ? (fail++, console.log("  ✗ an error was logged (see transcript)")) : (pass++, console.log("  ✓ no errors logged"));
} finally {
  fs.writeFileSync(transcript, out.join("\n"));
  // stop the harness this test started, the MCP server and the app
  await fetch(`http://127.0.0.1:${CTRL}/`, { method: "POST", body: JSON.stringify({ cmd: "stop", args: [] }) }).catch(() => {});
  mcp.kill(); app.kill();
  if (!process.env.KEEP && !fail) fs.rmSync(sb.dir, { recursive: true, force: true });
  else console.log(`\nsandbox and transcript kept: ${sb.dir}${fail ? " (a step failed)" : ""}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
