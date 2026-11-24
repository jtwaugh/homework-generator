// One structured Claude call for the Wu pipeline, plus the shared text helpers.
import fs from "node:fs";
import { runAgent, makeClient, MODELS, PRICES } from "../../lib/agent.mjs";
import { pageFile } from "./sources.mjs";

let client = null;
export async function ask({ model, system, prompt, schema, effort = "medium", label = "" }) {
  client ||= makeClient();
  const r = await runAgent({ client, model, system, schema, effort, messages: [{ role: "user", content: clean(prompt) }], maxTurns: 2 });
  if (!r.ok) throw new Error(`${label}: ${r.error}`);
  return { data: r.structured, cost: r.usage.costUSD };
}

// Rough cost before spending: ~1.35 tokens per word in, `outTok` out.
export function estimate(model, words, outTok) {
  const p = PRICES[MODELS[model] || model];
  const inTok = Math.round(words * 1.35);
  return { inTok, outTok, usd: (inTok * p.in + outTok * p.out) / 1e6 };
}

// pdftotext can emit control characters and stray surrogates; the API rejects a body containing them.
export const clean = (s) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").toWellFormed();
export const readPage = (doc, n) => (fs.existsSync(pageFile(doc, n)) ? clean(fs.readFileSync(pageFile(doc, n), "utf8")) : "");
// Pages from..to with markers, whitespace squeezed (pdftotext -layout pads lines heavily).
export const pagesText = (doc, from, to) => {
  const out = [];
  for (let i = from; i <= to; i++) out.push(`[[${doc} p.${i}]]\n${readPage(doc, i).replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim()}`);
  return out.join("\n\n");
};
export const words = (s) => (s.match(/\S+/g) || []).length;
export const readJson = (f, d = null) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);
export const writeJson = (f, x) => fs.writeFileSync(f, JSON.stringify(x, null, 1) + "\n");
