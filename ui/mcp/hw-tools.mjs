#!/usr/bin/env node
// MCP tool server for the homework tools (stdio, newline-delimited JSON-RPC). The app itself calls the tools in
// process (lib/tools.mjs); this wrapper exposes the same tools to other MCP clients and to scripts/test-mcp.mjs.
// Env: WEEK_ID (calls are logged to data/weeks/<WEEK_ID>.tools.jsonl), HW_DATA (data dir).
import fsp from "node:fs/promises";
import path from "node:path";
import { DATA } from "../lib/corpus.mjs";
import { TOOLS, callTool, runCas } from "../lib/tools.mjs";

export { TOOLS, callTool, runCas };
const WEEK_ID = process.env.WEEK_ID || "";
const LOG = WEEK_ID && /^[A-Za-z0-9_-]+$/.test(WEEK_ID) ? path.join(DATA, "weeks", `${WEEK_ID}.tools.jsonl`) : null;

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
    try { r = await callTool(name, args, { weekId: WEEK_ID }); } catch (e) { r = { ok: false, text: "tool error: " + e.message }; }
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
