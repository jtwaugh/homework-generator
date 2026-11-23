// The agent loop: one Claude conversation over the Messages API (streaming), with server tools (web search/fetch)
// and our own in-process tools (cas, corpus_search, corpus_add, ...). It replaces `claude -p` and keeps the result
// and event shapes the server already used:
//   result  {ok, error?, text, usage, structured, tools, stopReason}
//   events  {type:"text"|"thinking", text} · {type:"tool", tool:{id,name,input,at,textIndex}}
//           · {type:"tool_result", tool:{id,name,input,at,textIndex,ms,chars,ok,preview}}
// `messages` is the conversation so far; it is extended in place (assistant turns keep their thinking blocks
// unchanged), so the caller persists it to continue the conversation next time.
import Anthropic from "@anthropic-ai/sdk";

export const MODELS = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };

// USD per million tokens. Cache writes (5-minute) cost 1.25x input. Web search is $10 per 1,000 searches.
export const PRICES = {
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01 },
};
const SEARCH_USD = 0.01;
const priceOf = (model) => PRICES[model] || PRICES[Object.keys(PRICES).find((k) => model?.startsWith(k))] || PRICES["claude-opus-5-5"];

export function costOf(model, m) {
  const p = priceOf(model);
  return ((m.in || 0) * p.in + (m.out || 0) * p.out + (m.cacheRead || 0) * p.cacheRead + (m.cacheWrite || 0) * p.in * 1.25) / 1e6 + (m.webSearches || 0) * SEARCH_USD;
}

export const emptyUsage = () => ({ costUSD: 0, durationMs: 0, numTurns: 0, webSearches: 0, models: {} });

// Adds one API response's usage into `u` (same shape the server's mergeUsage combines).
export function addUsage(u, model, usage = {}) {
  const m = (u.models[model] ||= { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0, costUSD: 0 });
  const d = {
    in: usage.input_tokens || 0, out: usage.output_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0, cacheWrite: usage.cache_creation_input_tokens || 0,
    webSearches: usage.server_tool_use?.web_search_requests || 0,
  };
  for (const k of Object.keys(d)) m[k] += d[k];
  const c = costOf(model, d);
  m.costUSD += c; u.costUSD += c; u.webSearches += d.webSearches; u.numTurns++;
  return u;
}

// The app's tool names (the UI and cost tables know these) for the API's server tools.
const SERVER_NAME = { web_search: "WebSearch", web_fetch: "WebFetch" };
const RESULT_TYPES = new Set(["web_search_tool_result", "web_fetch_tool_result"]);

export function serverTools(names = [], { maxSearches = 8 } = {}) {
  const out = [];
  if (names.includes("WebSearch")) out.push({ type: "web_search_20260209", name: "web_search", max_uses: maxSearches });
  if (names.includes("WebFetch")) out.push({ type: "web_fetch_20260209", name: "web_fetch", max_uses: 10 });
  return out;
}

// Minimal schema check for tool inputs (eager input streaming can hand us a truncated object).
function badInput(input, schema = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "input must be an object";
  for (const k of schema.required || []) if (input[k] === undefined) return `missing required field "${k}"`;
  for (const [k, s] of Object.entries(schema.properties || {})) {
    const v = input[k];
    if (v === undefined || !s.type) continue;
    const ok = s.type === "array" ? Array.isArray(v) : s.type === "object" ? v && typeof v === "object" : typeof v === s.type;
    if (!ok) return `field "${k}" must be ${s.type}`;
  }
  return null;
}

// Structured outputs need additionalProperties: false on every object.
export function strictSchema(x) {
  if (Array.isArray(x)) return x.map(strictSchema);
  if (!x || typeof x !== "object") return x;
  const o = Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === "properties" ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, strictSchema(pv)])) : strictSchema(v)]));
  if (o.type === "object" && o.additionalProperties === undefined) o.additionalProperties = false;
  return o;
}

// JSON from a reply that was asked (not forced) to be JSON: the whole text, a ```json block, or the outermost {...}.
export function parseJsonReply(t) {
  const tries = [t, ...[...t.matchAll(/```json\s*\n([\s\S]*?)```/g)].map((m) => m[1]).reverse(), t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)];
  for (const c of tries) { try { const v = JSON.parse(c.trim()); if (v && typeof v === "object") return v; } catch {} }
  return null;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

function serverResultText(block) {
  const c = block.content;
  if (Array.isArray(c)) return c.map((r) => `${r.title || ""} ${r.url || ""}`.trim()).join("\n");
  if (c?.type?.endsWith("_error")) return `error: ${c.error_code || "unknown"}`;
  if (c?.content?.source?.data) return String(c.content.source.data);
  return JSON.stringify(c ?? "");
}

const isRetryable = (e) => !(e instanceof Anthropic.APIError) || e.status === 429 || e.status >= 500 || e.status === undefined;
const isAbort = (e, signal) => signal?.aborted || e instanceof Anthropic.APIUserAbortError || e?.name === "AbortError";

/**
 * @param {object} o
 * @param {Anthropic} o.client   any object with messages.stream / beta.messages.stream (tests pass a fake)
 * @param {string} o.model
 * @param {string} [o.system]
 * @param {Array} o.messages     conversation; the new user prompt must already be the last entry
 * @param {Array} [o.tools]      custom tools: {name, description, input_schema, run(input) → {ok, text}}
 * @param {string[]} [o.server]  "WebSearch", "WebFetch"
 * @param {string} [o.effort]    low | medium | high | xhigh | max
 * @param {object} [o.schema]    JSON schema: the final reply is JSON, parsed into result.structured
 * @param {number} [o.budgetUSD] stop once this conversation run has cost more
 * @param {string[]} [o.allow]  custom tools this call may run (others are declared but refused): keeps the tool
 *                              list identical across a conversation's stages, as replayed thinking requires
 * @param {boolean} [o.binding]  multi-turn conversation: drop (not reject) replayed thinking the API can't verify
 * @param {AbortSignal} [o.signal]
 */
export async function runAgent({
  client, model, system, messages, tools = [], server = [], effort, schema, budgetUSD = Infinity, signal,
  allow = null, binding = false,
  onEvent = () => {}, log = () => {}, maxTurns = 60, maxTokens = 64000, fallbacks = process.env.HW_FALLBACKS !== "0",
}) {
  model = MODELS[model] || model; // "opus" / "sonnet" / "haiku" (as stored on older weeks) -> API model id
  const started = Date.now();
  const usage = emptyUsage();
  const calls = [];
  let text = "", lastText = "", stopReason = null;
  const byName = new Map(tools.map((t) => [t.name, t]));
  const apiTools = [
    ...serverTools(server),
    ...tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, eager_input_streaming: true })),
  ];
  // Server-side refusal fallbacks exist for Opus and Sonnet, not Haiku.
  // JSON outputs can't be combined with citations, which web search results carry: with server tools the schema
  // goes into the system prompt and the reply is parsed instead.
  const forced = schema && !server.length;
  if (schema && !forced) system = `${system ? system + "\n\n" : ""}End your work with one reply that is only a JSON object matching this JSON schema (no prose around it):\n${JSON.stringify(schema)}`;
  const useFallbacks = fallbacks && !/haiku/.test(model);
  const betas = [...(useFallbacks ? ["server-side-fallback-2026-07-01"] : []), ...(binding ? ["thinking-binding-controls-2026-08-01"] : [])];
  const params = {
    model, max_tokens: maxTokens, messages,
    thinking: { type: "adaptive", display: "summarized", ...(binding ? { block_binding: { prefix_mismatch_behavior: "drop_block" } } : {}) },
    cache_control: { type: "ephemeral" },
    ...(system ? { system } : {}),
    ...(apiTools.length ? { tools: apiTools } : {}),
    ...(effort || forced ? { output_config: { ...(effort ? { effort } : {}), ...(forced ? { format: { type: "json_schema", schema: strictSchema(schema) } } : {}) } } : {}),
    ...(betas.length ? { betas } : {}),
    ...(useFallbacks ? { fallbacks: "default" } : {}),
  };
  const finish = (ok, error) => {
    usage.durationMs = Date.now() - started;
    let structured = null;
    if (ok && schema) {
      structured = forced ? (() => { try { return JSON.parse(lastText); } catch { return null; } })() : parseJsonReply(lastText);
      if (!structured) { ok = false; error = "reply was not valid JSON for the schema"; }
    }
    log(ok ? "result" : "error", { model, costUSD: usage.costUSD, turns: usage.numTurns, stopReason, error });
    return { ok, ...(error ? { error } : {}), text, usage, structured, stopReason, tools: calls.map(({ at, ...t }) => t) };
  };

  log("start", { model, effort, tools: apiTools.map((t) => t.name), messages: messages.length });
  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) return finish(false, "stopped");
    let msg;
    for (let attempt = 0; ; attempt++) {
      const pending = new Map(); // block index → {kind, id, name, json, at, textIndex}
      const textBefore = text;
      try {
        const api = params.betas ? client.beta.messages : client.messages;
        const stream = api.stream(params, { signal });
        for await (const ev of stream) {
          if (ev.type === "content_block_start") {
            const b = ev.content_block;
            if (b.type === "text" && text) { text += "\n\n"; onEvent({ type: "text", text: "\n\n" }); }
            // Web search's dynamic filtering runs code_execution itself: an internal step, not a tool the app shows.
            if (b.type === "tool_use" || (b.type === "server_tool_use" && b.name !== "code_execution"))
              pending.set(ev.index, { id: b.id, name: SERVER_NAME[b.name] || b.name, json: "", at: Date.now(), textIndex: text.length });
          } else if (ev.type === "content_block_delta") {
            const d = ev.delta;
            if (d.type === "text_delta") { text += d.text; onEvent({ type: "text", text: d.text }); }
            else if (d.type === "thinking_delta") onEvent({ type: "thinking", text: d.thinking });
            else if (d.type === "input_json_delta" && pending.has(ev.index)) pending.get(ev.index).json += d.partial_json;
          } else if (ev.type === "content_block_stop" && pending.has(ev.index)) {
            const p = pending.get(ev.index);
            try { p.input = p.json ? JSON.parse(p.json) : {}; } catch { p.input = null; }
            const tool = { id: p.id, name: p.name, input: p.input ?? {}, at: p.at, textIndex: p.textIndex };
            calls.push(tool);
            onEvent({ type: "tool", tool });
            log("tool", { name: tool.name });
          }
        }
        msg = await stream.finalMessage();
        break;
      } catch (e) {
        if (isAbort(e, signal)) return finish(false, "stopped");
        // Drop what this failed attempt emitted from the record, then retry transient failures twice.
        text = textBefore;
        for (const p of pending.values()) { const i = calls.findIndex((c) => c.id === p.id); if (i >= 0) calls.splice(i, 1); }
        // A model that doesn't take the binding control: drop it rather than fail the turn.
        if (e.status === 400 && params.thinking.block_binding && /block_binding|thinking-binding/.test(e.message)) {
          delete params.thinking.block_binding;
          params.betas = params.betas.filter((b) => !b.startsWith("thinking-binding"));
          if (!params.betas.length) delete params.betas;
          log("retry", { error: "binding control rejected; retrying without it" });
          attempt--; continue;
        }
        if (attempt >= 2 || !isRetryable(e)) return finish(false, `${e.status ? `API ${e.status}: ` : ""}${e.message}`);
        log("retry", { attempt: attempt + 1, error: e.message });
      }
    }

    addUsage(usage, msg.model || model, msg.usage);
    stopReason = msg.stop_reason;
    messages.push({ role: "assistant", content: msg.content });
    lastText = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");

    // Server tool results (web search/fetch) arrive inside the assistant message.
    for (const b of msg.content) {
      if (!RESULT_TYPES.has(b.type)) continue;
      const tool = calls.find((c) => c.id === b.tool_use_id);
      if (!tool) continue;
      const out = serverResultText(b);
      Object.assign(tool, { ms: Date.now() - tool.at, chars: out.length, ok: !b.content?.type?.endsWith("_error"), preview: clip(out, 4000) });
      onEvent({ type: "tool_result", tool });
    }

    if (usage.costUSD > budgetUSD) {
      // Keep the history valid for the next turn: every tool_use needs a tool_result.
      const open = msg.content.filter((b) => b.type === "tool_use");
      if (open.length) messages.push({ role: "user", content: open.map((b) => ({ type: "tool_result", tool_use_id: b.id, content: "not run: budget reached", is_error: true })) });
      return finish(false, `Stopped: this turn reached the $${budgetUSD} budget.`);
    }
    if (stopReason === "end_turn" || stopReason === "stop_sequence") return finish(true);
    if (stopReason === "refusal") return finish(false, "Claude declined this request.");
    if (stopReason === "pause_turn") continue; // server tool loop paused: re-send as-is to let it resume
    if (stopReason === "max_tokens") {
      if (msg.content.at(-1)?.type === "tool_use") return finish(false, "reply was cut off at the output limit mid tool call");
      return finish(true);
    }
    if (stopReason !== "tool_use") return finish(false, `unexpected stop reason ${stopReason}`);

    // Run our tools; all results go back in one user message.
    const results = [];
    for (const b of msg.content.filter((x) => x.type === "tool_use")) {
      const tool = calls.find((c) => c.id === b.id) || { id: b.id, name: b.name, input: b.input, at: Date.now() };
      tool.input = b.input; // the final message holds the authoritative parsed input
      const def = byName.get(b.name);
      const t0 = Date.now();
      let r;
      const bad = def ? badInput(b.input, def.input_schema) : null;
      if (!def) r = { ok: false, text: `unknown tool ${b.name}` };
      else if (allow && !allow.includes(b.name)) r = { ok: false, text: `${b.name} is not available at this step` };
      else if (bad) r = { ok: false, text: `invalid input: ${bad}` };
      else if (signal?.aborted) r = { ok: false, text: "stopped by the teacher" };
      else {
        try { r = await def.run(b.input, { signal }); } catch (e) { r = { ok: false, text: "tool error: " + e.message }; }
      }
      const out = String(r.text ?? "");
      Object.assign(tool, { ms: Date.now() - t0, chars: out.length, ok: !!r.ok, preview: clip(out, 4000) });
      onEvent({ type: "tool_result", tool });
      log("tool-result", { name: b.name, ok: !!r.ok, ms: tool.ms });
      results.push({ type: "tool_result", tool_use_id: b.id, content: out || "(empty)", ...(r.ok ? {} : { is_error: true }) });
    }
    messages.push({ role: "user", content: results });
  }
  return finish(false, `stopped after ${maxTurns} model calls`);
}

// Appends a user turn, merging into the last one if it is also a user turn (e.g. after a stopped run).
export function addUserTurn(messages, content) {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  const last = messages.at(-1);
  if (last?.role === "user") last.content = [...(typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content), ...blocks];
  else messages.push({ role: "user", content: blocks });
  return messages;
}

export function makeClient() {
  return new Anthropic({ maxRetries: 3, timeout: 10 * 60 * 1000 });
}
