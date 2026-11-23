// Vercel Workflow's endpoint (/.well-known/workflow/v1/flow, rewritten here): the queue calls it to run
// workflow and step code. It loads the app first, as api/index.mjs does, so steps can run a week's turn
// (workflows/turn.mjs → ui/server.mjs turnStep).
import { waitUntil } from "@vercel/functions";

process.env.HW_ROOT ||= "/tmp/hw/root";
process.env.HW_DATA ||= "/tmp/hw/data";
const server = await import("../ui/server.mjs");
server.setKeepAlive(waitUntil);
globalThis.__hwServer = server;

export { POST, GET } from "../.well-known/workflow/v1/flow.mjs";
