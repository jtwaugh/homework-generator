#!/usr/bin/env node
// Tests for the agent loop (ui/lib/agent.mjs) against a scripted fake client: no network, no API key.
//   node ui/scripts/test-agent.mjs
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { runAgent, costOf, addUserTurn, strictSchema, MODELS } from "../lib/agent.mjs";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log("  ✓", name); }
  catch (e) { fail++; console.log("  ✗", name, "\n    ", String(e.stack || e.message).split("\n").slice(0, 6).join("\n     ")); }
};

// ---------- fake client ----------
// Each scripted reply is a final Message (or an Error to throw mid-stream). The fake streams it as the API
// would: block start, deltas, block stop, then finalMessage().
const U = (i = 100, o = 50, extra = {}) => ({ input_tokens: i, output_tokens: o, ...extra });
const msg = (content, stop_reason = "end_turn", usage = U(), model) => ({ content, stop_reason, usage, model });
const txt = (text) => ({ type: "text", text });
const think = (thinking) => ({ type: "thinking", thinking, signature: "sig" });
const use = (id, name, input) => ({ type: "tool_use", id, name, input });
const suse = (id, name, input) => ({ type: "server_tool_use", id, name, input });

function eventsOf(m) {
  const ev = [];
  m.content.forEach((b, index) => {
    if (b.type === "text") { ev.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } }); ev.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } }); }
    else if (b.type === "thinking") { ev.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } }); ev.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.thinking } }); }
    else if (b.type === "tool_use" || b.type === "server_tool_use") {
      ev.push({ type: "content_block_start", index, content_block: { ...b, input: {} } });
      const j = JSON.stringify(b.input);
      ev.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: j.slice(0, 5) } });
      ev.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: j.slice(5) } });
    } else ev.push({ type: "content_block_start", index, content_block: b });
    ev.push({ type: "content_block_stop", index });
  });
  return ev;
}

function fakeClient(script) {
  const calls = [];
  const stream = (params, opts = {}) => {
    calls.push({ ...params, messages: structuredClone(params.messages), signal: opts.signal });
    const next = script.shift();
    if (!next) throw new Error("fake client: no more scripted replies");
    const final = typeof next === "function" ? next(params) : next;
    return {
      async *[Symbol.asyncIterator]() {
        if (final instanceof Error) throw final;
        for (const e of eventsOf(final)) { if (opts.signal?.aborted) throw new Anthropic.APIUserAbortError(); yield e; }
      },
      finalMessage: async () => ({ model: params.model, ...final }),
    };
  };
  return { calls, messages: { stream }, beta: { messages: { stream } } };
}

const casTool = (impl) => ({
  name: "cas", description: "run sympy",
  input_schema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
  run: impl,
});
const user = (t) => [{ role: "user", content: t }];

// ---------- tests ----------

await test("plain reply: text and thinking stream as events, history gets the assistant turn with thinking", async () => {
  const c = fakeClient([msg([think("hmm"), txt("Hello"), txt("world")])]);
  const events = [];
  const messages = user("hi");
  const r = await runAgent({ client: c, model: MODELS.sonnet, messages, onEvent: (e) => events.push(e) });
  assert.equal(r.ok, true);
  assert.equal(r.text, "Hello\n\nworld");
  assert.deepEqual(events.map((e) => e.type), ["thinking", "text", "text", "text"]);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].content[0].type, "thinking", "thinking block is passed back unchanged");
});

await test("request shape: adaptive summarized thinking, effort, caching, eager input streaming, web tools", async () => {
  const c = fakeClient([msg([txt("ok")])]);
  await runAgent({ client: c, model: MODELS.opus, system: "sys", messages: user("x"), effort: "high", server: ["WebSearch", "WebFetch"], tools: [casTool(async () => ({ ok: true, text: "" }))] });
  const p = c.calls[0];
  assert.deepEqual(p.thinking, { type: "adaptive", display: "summarized" });
  assert.equal(p.output_config.effort, "high");
  assert.deepEqual(p.cache_control, { type: "ephemeral" });
  assert.equal(p.system, "sys");
  assert.deepEqual(p.tools.map((t) => t.name), ["web_search", "web_fetch", "cas"]);
  assert.equal(p.tools[0].type, "web_search_20260209");
  assert.equal(p.tools[2].eager_input_streaming, true);
  assert.equal(p.tools[2].run, undefined, "the run function is not sent");
  assert.equal(p.fallbacks, "default");
});

await test("haiku requests carry no fallbacks parameter", async () => {
  const c = fakeClient([msg([txt("ok")])]);
  await runAgent({ client: c, model: MODELS.haiku, messages: user("x") });
  assert.equal(c.calls[0].fallbacks, undefined);
  assert.equal(c.calls[0].betas, undefined);
});

await test("tool loop: custom tools run, every result returns in one user message, errors flagged", async () => {
  const c = fakeClient([
    msg([txt("Checking."), use("t1", "cas", { code: "print(1)" }), use("t2", "cas", { code: "boom" }), use("t3", "nope", {})], "tool_use"),
    msg([txt("All good.")]),
  ]);
  const ran = [];
  const events = [];
  const messages = user("verify");
  const r = await runAgent({
    client: c, model: MODELS.sonnet, messages, onEvent: (e) => events.push(e),
    tools: [casTool(async ({ code }) => { ran.push(code); if (code === "boom") throw new Error("kaboom"); return { ok: true, text: "1" }; })],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(ran, ["print(1)", "boom"]);
  const results = c.calls[1].messages.at(-1);
  assert.equal(results.role, "user");
  assert.deepEqual(results.content.map((b) => [b.tool_use_id, !!b.is_error]), [["t1", false], ["t2", true], ["t3", true]]);
  assert.match(results.content[1].content, /kaboom/);
  assert.match(results.content[2].content, /unknown tool/);
  const tool = events.find((e) => e.type === "tool");
  assert.deepEqual(tool.tool.input, { code: "print(1)" }, "streamed JSON input is reassembled");
  assert.equal(tool.tool.textIndex, "Checking.".length);
  assert.equal(r.tools.length, 3);
  assert.equal(r.tools[0].ok, true); assert.equal(r.tools[1].ok, false);
  assert.ok(!("at" in r.tools[0]), "returned tools omit at");
  assert.ok(r.tools.some((t) => /cas$/.test(t.name) && t.ok), "verify's 'cas ran' check still works");
});

await test("invalid tool input is rejected without running the tool", async () => {
  const c = fakeClient([msg([use("t1", "cas", { code: 5 })], "tool_use"), msg([txt("ok")])]);
  let ran = false;
  await runAgent({ client: c, model: MODELS.haiku, messages: user("x"), tools: [casTool(async () => { ran = true; return { ok: true, text: "" }; })] });
  assert.equal(ran, false);
  const res = c.calls[1].messages.at(-1).content[0];
  assert.equal(res.is_error, true); assert.match(res.content, /must be string/);
});

await test("server tools: web search shows as WebSearch with a result preview; usage counts searches", async () => {
  const c = fakeClient([msg([
    suse("s1", "web_search", { query: "systems of inequalities worksheet" }),
    { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", title: "Worksheet", url: "https://ex.com/a" }] },
    txt("Found one."),
  ], "end_turn", U(1000, 200, { server_tool_use: { web_search_requests: 1 } }))]);
  const events = [];
  const r = await runAgent({ client: c, model: MODELS.sonnet, messages: user("x"), server: ["WebSearch"], onEvent: (e) => events.push(e) });
  const res = events.find((e) => e.type === "tool_result");
  assert.equal(res.tool.name, "WebSearch");
  assert.equal(res.tool.ok, true);
  assert.match(res.tool.preview, /ex\.com/);
  assert.equal(r.usage.webSearches, 1);
  assert.ok(Math.abs(r.usage.costUSD - (1000 * 2 + 200 * 10) / 1e6 - 0.01) < 1e-9);
});

await test("pause_turn: the paused assistant turn is re-sent and the loop continues", async () => {
  const c = fakeClient([msg([txt("part 1")], "pause_turn"), msg([txt("part 2")])]);
  const r = await runAgent({ client: c, model: MODELS.sonnet, messages: user("x") });
  assert.equal(r.ok, true);
  assert.equal(c.calls.length, 2);
  assert.equal(c.calls[1].messages.at(-1).role, "assistant", "no extra user message after pause_turn");
  assert.equal(r.text, "part 1\n\npart 2");
  assert.equal(r.usage.numTurns, 2);
});

await test("usage and cost: per model, cache read/write priced, merged across calls", async () => {
  const u = U(1_000_000, 100_000, { cache_read_input_tokens: 2_000_000, cache_creation_input_tokens: 400_000 });
  const c = fakeClient([msg([use("t", "cas", { code: "1" })], "tool_use", u), msg([txt("ok")], "end_turn", U(0, 0))]);
  const r = await runAgent({ client: c, model: MODELS.opus, messages: user("x"), tools: [casTool(async () => ({ ok: true, text: "1" }))] });
  const want = 4 + 2 + 0.4 + 0.4 * 4 * 1.25; // in, out, cache read, cache write
  assert.ok(Math.abs(r.usage.costUSD - want) < 1e-9, `${r.usage.costUSD} vs ${want}`);
  assert.deepEqual(Object.keys(r.usage.models), [MODELS.opus]);
  assert.equal(r.usage.models[MODELS.opus].cacheRead, 2_000_000);
  assert.ok(costOf(MODELS.haiku, { in: 1e6 }) < costOf(MODELS.sonnet, { in: 1e6 }));
});

await test("a fallback model's tokens are billed at that model's rate", async () => {
  const c = fakeClient([{ ...msg([txt("ok")], "end_turn", U(1e6, 0)), model: "claude-sonnet-5-5" }]);
  const r = await runAgent({ client: c, model: MODELS.opus, messages: user("x") });
  assert.deepEqual(Object.keys(r.usage.models), ["claude-sonnet-5-5"]);
  assert.ok(Math.abs(r.usage.costUSD - 2) < 1e-9);
});

await test("structured output: schema sent as output_config.format, reply parsed; bad JSON is an error", async () => {
  const schema = { type: "object", properties: { pass: { type: "boolean" } }, required: ["pass"] };
  const c = fakeClient([msg([txt('{"pass": true}')]), msg([txt("not json")])]);
  const r = await runAgent({ client: c, model: MODELS.haiku, messages: user("x"), schema, effort: "low" });
  assert.deepEqual(c.calls[0].output_config, { effort: "low", format: { type: "json_schema", schema: { ...schema, additionalProperties: false } } });
  assert.deepEqual(r.structured, { pass: true });
  const r2 = await runAgent({ client: c, model: MODELS.haiku, messages: user("x"), schema });
  assert.equal(r2.ok, false); assert.equal(r2.structured, null);
});

await test("structured output with web tools: schema goes in the system prompt, JSON parsed from the reply", async () => {
  const schema = { type: "object", properties: { problems: { type: "array", items: { type: "object", properties: { tex: { type: "string" } } } } } };
  const c = fakeClient([msg([txt('Here you go:\n```json\n{"problems": [{"tex": "x"}]}\n```')])]);
  const r = await runAgent({ client: c, model: MODELS.sonnet, system: "S", messages: user("x"), schema, server: ["WebSearch"] });
  assert.equal(c.calls[0].output_config, undefined, "no forced format next to citations");
  assert.match(c.calls[0].system, /^S\n\n.*JSON schema/s);
  assert.deepEqual(r.structured, { problems: [{ tex: "x" }] });
  assert.equal(strictSchema(schema).properties.problems.items.additionalProperties, false);
});

await test("short model names resolve to API ids", async () => {
  const c = fakeClient([msg([txt("ok")])]);
  await runAgent({ client: c, model: "sonnet", messages: user("x") });
  assert.equal(c.calls[0].model, MODELS.sonnet);
});

await test("budget: stops after the call that crosses it, and closes open tool calls in the history", async () => {
  const c = fakeClient([msg([use("t", "cas", { code: "1" })], "tool_use", U(1e6, 0))]);
  let ran = false;
  const messages = user("x");
  const r = await runAgent({ client: c, model: MODELS.opus, messages, budgetUSD: 1, tools: [casTool(async () => { ran = true; return { ok: true, text: "" }; })] });
  assert.equal(r.ok, false); assert.match(r.error, /budget/);
  assert.equal(ran, false);
  assert.equal(c.calls.length, 1);
  assert.equal(messages.at(-1).content[0].tool_use_id, "t", "history stays valid for the next turn");
});

await test("refusal and max_tokens mid tool call are errors; max_tokens on text is ok", async () => {
  const c = fakeClient([msg([], "refusal"), msg([use("t", "cas", { code: "1" })], "max_tokens"), msg([txt("long…")], "max_tokens")]);
  assert.match((await runAgent({ client: c, model: MODELS.sonnet, messages: user("x") })).error, /declined/);
  assert.match((await runAgent({ client: c, model: MODELS.sonnet, messages: user("x"), tools: [casTool(async () => ({ ok: true, text: "" }))] })).error, /cut off/);
  assert.equal((await runAgent({ client: c, model: MODELS.sonnet, messages: user("x") })).ok, true);
});

await test("transient stream errors retry (partial text discarded); 4xx API errors do not", async () => {
  const c = fakeClient([new Error("socket hang up"), msg([txt("recovered")])]);
  const r = await runAgent({ client: c, model: MODELS.sonnet, messages: user("x") });
  assert.equal(r.ok, true); assert.equal(r.text, "recovered"); assert.equal(c.calls.length, 2);
  const bad = new Anthropic.BadRequestError(400, { error: { message: "bad" } }, "bad request", new Headers());
  const c2 = fakeClient([bad, msg([txt("never")])]);
  const r2 = await runAgent({ client: c2, model: MODELS.sonnet, messages: user("x") });
  assert.equal(r2.ok, false); assert.match(r2.error, /400/); assert.equal(c2.calls.length, 1);
});

await test("abort: a stopped run returns 'stopped' and the signal reaches the client", async () => {
  const ac = new AbortController();
  const c = fakeClient([msg([use("t", "cas", { code: "1" })], "tool_use"), msg([txt("never")])]);
  const r = await runAgent({ client: c, model: MODELS.sonnet, messages: user("x"), signal: ac.signal, tools: [casTool(async () => { ac.abort(); return { ok: true, text: "1" }; })] });
  assert.equal(r.ok, false); assert.equal(r.error, "stopped");
  assert.equal(c.calls.length, 1, "no further model call after abort");
  assert.equal(c.calls[0].signal, ac.signal);
});

await test("stage allowlist: a declared but disallowed tool is refused, tool list unchanged", async () => {
  const c = fakeClient([msg([use("t", "cas", { code: "1" })], "tool_use"), msg([txt("ok")])]);
  let ran = false;
  await runAgent({ client: c, model: MODELS.sonnet, messages: user("x"), allow: ["corpus_search"], tools: [casTool(async () => { ran = true; return { ok: true, text: "" }; })] });
  assert.equal(ran, false);
  assert.deepEqual(c.calls[0].tools.map((t) => t.name), ["cas"]);
  assert.match(c.calls[1].messages.at(-1).content[0].content, /not available/);
});

await test("binding: conversation turns ask for drop_block; a model that rejects it is retried without", async () => {
  const c = fakeClient([msg([txt("ok")])]);
  await runAgent({ client: c, model: MODELS.haiku, messages: user("x"), binding: true });
  assert.deepEqual(c.calls[0].thinking.block_binding, { prefix_mismatch_behavior: "drop_block" });
  assert.deepEqual(c.calls[0].betas, ["thinking-binding-controls-2026-08-01"]);
  const bad = new Anthropic.BadRequestError(400, { error: { message: "thinking.block_binding: not supported" } }, "thinking.block_binding: not supported", new Headers());
  const c2 = fakeClient([bad, msg([txt("ok")])]);
  const r = await runAgent({ client: c2, model: MODELS.haiku, messages: user("x"), binding: true });
  assert.equal(r.ok, true);
  assert.equal(c2.calls[1].thinking.block_binding, undefined);
  assert.equal(c2.calls[1].betas, undefined);
});

await test("addUserTurn merges into a dangling user turn (after a stopped run)", () => {
  const m = addUserTurn(user("first"), "second");
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].content.map((b) => b.text), ["first", "second"]);
  m.push({ role: "assistant", content: [txt("a")] });
  assert.equal(addUserTurn(m, "third").length, 3, "after an assistant turn it is a new message");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
