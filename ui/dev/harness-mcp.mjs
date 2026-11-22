// MCP server (stdio, newline-delimited JSON-RPC, no dependencies) that drives the app through the dev harness.
// Run via `node ui/dev/harness.mjs mcp`. Every tool that does something in the page returns:
//   - the command's own result,
//   - "Log": every event since the previous call — UI events, HTTP requests, claude runs and their tool
//     calls, compiles (the app's event log), plus browser console output, page errors, failed requests,
//   - "State changes": what changed in window.__hw.summary() (phase, dialogs, week, topics, final, cost…).
// It starts the harness (headless Chrome) itself if it isn't already running.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

let CTRL, HARNESS;

function harness(cmd, args = []) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: CTRL, method: "POST", path: "/", headers: { "Content-Type": "application/json" } }, (res) => {
      let out = ""; res.on("data", (d) => (out += d));
      res.on("end", () => (res.statusCode === 200 ? resolve(out) : reject(new Error(out.replace(/^error: /, "")))));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ cmd, args: args.map(String) }));
  });
}

let starting = null;
async function ensureHarness() {
  try { await harness("ping"); return; } catch (e) { if (!/ECONNREFUSED/.test(e.message)) return; }
  starting ??= (async () => {
    const logFile = path.join(path.dirname(HARNESS), "..", "data", "harness", `serve-${CTRL}.log`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = fs.openSync(logFile, "w");
    const child = spawn(process.execPath, [HARNESS, "serve"], { env: process.env, stdio: ["ignore", fd, fd], detached: true });
    child.unref();
    let exited = null; child.on("exit", (c) => (exited = c));
    for (let i = 0; i < 60 && exited === null; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try { await harness("ping"); await harness("logs"); return; } catch {} // logs: set the cursor
    }
    throw new Error(`the harness did not start${exited !== null ? ` (exited ${exited})` : ""}. ${logFile}:\n${fs.readFileSync(logFile, "utf8").slice(-1500)}`);
  })();
  try { await starting; } finally { starting = null; }
}

const state = async () => { try { return JSON.parse(await harness("state")); } catch { return null; } };

// flatten {a:{b:1}} → {"a.b": 1}; arrays of scalars stay whole
function flat(o, pre = "", out = {}) {
  if (o && typeof o === "object" && !(Array.isArray(o) && o.every((x) => typeof x !== "object"))) {
    for (const [k, v] of Object.entries(o)) flat(v, pre ? `${pre}.${k}` : k, out);
  } else out[pre] = o;
  return out;
}
function diff(a, b) {
  if (!a || !b) return "(state unavailable)";
  const A = flat(a), B = flat(b), lines = [];
  const show = (v) => { const t = JSON.stringify(v); return t === undefined ? "∅" : t.length > 140 ? t.slice(0, 140) + "…" : t; };
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
    if (JSON.stringify(A[k]) !== JSON.stringify(B[k])) lines.push(`${k}: ${show(A[k])} → ${show(B[k])}`);
  }
  return lines.length ? lines.slice(0, 40).join("\n") + (lines.length > 40 ? `\n… ${lines.length - 40} more` : "") : "(no change)";
}

const S = (props, req = []) => ({ type: "object", properties: props, required: req });
const str = (d) => ({ type: "string", description: d });
const SEL = str('CSS selector, or "text:Label" to match a visible button/link/label by its text');

// name → [description, schema, (args) => harness command + args, action?]
const TOOLS = {
  ui_state: ["App state summary: phase, week, next action, topics, units, final checks, cost, CAS, open dialogs.", S({}), () => ["state"], false],
  ui_outline: ["The visible page as text: headings, text blocks, and every control with a selector you can pass to the other tools.", S({}), () => ["outline"], false],
  ui_screenshot: ["Screenshot the viewport, the full page, or one element. Returns the image.", S({ selector: SEL, full: { type: "boolean" } }), (a) => ["shot", ...(a.full ? ["--full"] : []), ...(a.selector ? [a.selector] : [])], false],
  ui_logs: ["Everything logged since the last call: UI events, HTTP requests, claude runs and tool calls, compiles, browser console, errors.", S({}), () => ["logs"], false],
  ui_click: ["Click an element.", S({ selector: SEL }, ["selector"]), (a) => ["click", a.selector], true],
  ui_type: ["Set a text field's value (fires input, like typing).", S({ selector: SEL, text: str("the new value") }, ["selector", "text"]), (a) => ["type", a.selector, a.text], true],
  ui_select: ["Choose a value in a <select>.", S({ selector: SEL, value: str("option value") }, ["selector", "value"]), (a) => ["select", a.selector, a.value], true],
  ui_key: ["Press a key, optionally after focusing an element: Enter, Escape, Tab, Backspace, ArrowLeft/Right/Up/Down, Meta+Enter, a letter…", S({ key: str("e.g. Escape, ArrowRight, Meta+Enter"), selector: SEL }, ["key"]), (a) => ["key", a.key, ...(a.selector ? [a.selector] : [])], true],
  ui_drag: ["Drag with the mouse from one element to another (HTML5 drag-and-drop, e.g. reorder topic chips) or by an offset \"dx,dy\" (pointer drags, e.g. pan the progress map).", S({ from: SEL, to: str('target selector, or an offset like "200,0"') }, ["from", "to"]), (a) => ["drag", a.from, a.to], true],
  ui_wheel: ["Scroll the wheel over an element (negative deltaY zooms the progress map in).", S({ selector: SEL, deltaY: { type: "number" } }, ["selector"]), (a) => ["wheel", a.selector, a.deltaY ?? -300], true],
  ui_hover: ["Move the mouse over an element (tooltips, hover states).", S({ selector: SEL }, ["selector"]), (a) => ["hover", a.selector], true],
  ui_upload: ["Choose local files in a file input (e.g. the progress map's notes drop zone #dag-drop).", S({ selector: SEL, files: { type: "array", items: { type: "string" }, description: "absolute paths" } }, ["selector", "files"]), (a) => ["upload", a.selector, ...a.files], true],
  ui_wait: ["Wait some milliseconds, or until a page expression is truthy (e.g. \"!__hw.week?.running\" to wait for Claude to finish). Returns the log of everything that happened meanwhile.", S({ ms: { type: "number" }, until: str("JS expression evaluated in the page"), timeoutMs: { type: "number" } }), (a) => ["wait", a.until || String(a.ms ?? 1000), String(a.timeoutMs ?? 600000)], true],
  ui_eval: ["Evaluate JavaScript in the page (await allowed; use `return` in statement mode). window.__hw exposes the app state.", S({ js: str("expression or statements") }, ["js"]), (a) => ["eval", a.js], true],
  ui_goto: ["Navigate to a URL, path or #hash in the app.", S({ url: str("URL, /path or #hash") }), (a) => ["goto", a.url || "/"], true],
  ui_reload: ["Reload the page without cache (picks up front-end edits).", S({}), () => ["reload"], true],
  ui_size: ["Set the viewport size.", S({ width: { type: "number" }, height: { type: "number" } }, ["width", "height"]), (a) => ["size", a.width, a.height], false],
};

async function callTool(name, args = {}) {
  const t = TOOLS[name]; if (!t) throw new Error(`unknown tool ${name}`);
  await ensureHarness();
  const [cmd, ...cargs] = t[2](args);
  if (cmd === "shot") {
    const file = await harness(cmd, cargs);
    return [{ type: "image", data: fs.readFileSync(file.trim()).toString("base64"), mimeType: "image/png" }, { type: "text", text: file.trim() }];
  }
  if (!t[3]) return [{ type: "text", text: await harness(cmd, cargs) }];
  const before = await state();
  let result, failed = false;
  try { result = await harness(cmd, cargs); } catch (e) { result = "FAILED: " + e.message; failed = true; }
  const log = await harness("logs").catch((e) => "(logs unavailable: " + e.message + ")");
  const after = await state();
  return { failed, content: [{ type: "text", text: `${result}\n\n── Log ──\n${log}\n\n── State changes ──\n${diff(before, after)}` }] };
}

export function main(opts) {
  CTRL = opts.CTRL; HARNESS = opts.harnessFile;
  const reply = (id, result, error) => process.stdout.write(JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }) + "\n");
  const onMessage = async ({ id, method, params }) => {
    if (method === "initialize") return reply(id, { protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "hw-ui", version: "1.0.0" } });
    if (method?.startsWith("notifications/")) return;
    if (method === "ping") return reply(id, {});
    if (method === "tools/list") return reply(id, { tools: Object.entries(TOOLS).map(([name, [description, inputSchema]]) => ({ name, description, inputSchema })) });
    if (method === "tools/call") {
      try {
        const r = await callTool(params.name, params.arguments || {});
        return Array.isArray(r) ? reply(id, { content: r }) : reply(id, { content: r.content, isError: r.failed });
      } catch (e) { return reply(id, { content: [{ type: "text", text: "error: " + e.message }], isError: true }); }
    }
    if (id !== undefined) reply(id, null, { code: -32601, message: `method not found: ${method}` });
  };
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) { let m; try { m = JSON.parse(line); } catch { continue; } onMessage(m); } }
  });
  process.stdin.on("end", () => process.exit(0));
}
