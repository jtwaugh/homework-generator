// Tags corpus problems with Wu DAG nodes (content eNN, methods m:eNN) and short topic tags, using one cheap
// API call per batch (Haiku by default, no tools). Used by the seed script, by Save & finish (for the
// set's new problems, in the background) and by scripts/tag-corpus.mjs (backfill).
import fs from "node:fs";
import path from "node:path";
import { runAgent, makeClient } from "./agent.mjs";
import { ctx as storeCtx } from "./store.mjs";
import { ladderFor, graphFor } from "./curriculum.mjs";

export const TAG_MODEL = process.env.HW_TAG_MODEL || "claude-haiku-5-5";
const BATCH = 40;

// Untagged = no methods node and no content node, or queued for retagging after a curriculum change
// (its tags were split or retired). Rejected problems are skipped.
export const needsTags = (p) => p.status !== "rejected" && (!(p.wuNodes || []).length || !!p.needsRetag);

// The ladder units and both DAGs the tags are checked against: the active enrollment's curriculum version
// (hw.db), or the files under root/data when those are given (scripts run against a bare checkout).
function context({ root, data, c } = {}) {
  const units = (md) => md.split("\n").filter((l) => /^- (U\d\d|M\d|F\d) /.test(l)).map((l) => l.split(".")[0].slice(2)).join("\n");
  const list = (g, pre) => (g?.nodes || []).filter((n) => n.kind !== "word-problem").map((n) => `${pre}${n.id} ${n.title}`).join("\n");
  if (root && data) {
    const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
    const dag = (f) => { const t = read(path.join(data, f)); return t ? JSON.parse(t) : null; };
    return { ladder: units(read(path.join(root, "curriculum_ladder.md"))), content: list(dag("wu_dag.json"), ""), methods: list(dag("wu_methods_dag.json"), "") };
  }
  c ||= storeCtx();
  return { ladder: units(ladderFor(c.db, c.versionId)), content: list(graphFor(c.db, c.versionId, "content"), ""), methods: list(graphFor(c.db, c.versionId, "methods"), "") };
}

export function tagPrompt(probs, ctx) {
  return [
    "Tag each homework problem below. Reply with only a JSON array, one object per problem, in order:",
    '[{"i": 0, "units": ["U05"], "content": ["e64"], "methods": ["e46"], "tags": ["completing the square", "irrational roots"]}]',
    "- units: the curriculum ladder units the problem practises (1-3, most specific first).",
    "- content: ids from the Wu content DAG list that the problem exercises (0-3).",
    "- methods: ids from the Wu methods DAG list for how the problem is solved (0-3). The two lists reuse numbers (content e41 is not methods e41), so put each id in the list it came from.",
    "- tags: 1-4 short lowercase topic phrases.",
    "", "## Ladder units", ctx.ladder, "", "## Wu content DAG", ctx.content, "", "## Wu methods DAG", ctx.methods,
    "", "## Problems",
    ...probs.map((p, i) => `### ${i} (section: ${p.context || "?"})\n${p.tex.slice(0, 600)}${p.answer ? `\nanswer: ${String(p.answer).slice(0, 200)}` : ""}`),
  ].join("\n");
}

// → [{i, units, wuNodes, tags}]: content ids plain, methods ids prefixed m:, each checked against its own DAG.
export function parseTags(text, ctx) {
  const idsOf = (list) => new Set(list.split("\n").map((l) => l.split(" ")[0]).filter(Boolean));
  const C = idsOf(ctx.content), M = idsOf(ctx.methods);
  const pick = (a, ids, pre) => (Array.isArray(a) ? a.map((x) => String(x).replace(/^m:/, "")).filter((n) => ids.has(n)).map((n) => pre + n) : []);
  const arr = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
  return arr.filter((t) => t && Number.isInteger(t.i)).map((t) => ({
    i: t.i,
    units: Array.isArray(t.units) ? t.units.map(String) : [],
    wuNodes: [...pick(t.content, C, ""), ...pick(t.methods, M, "m:")],
    tags: Array.isArray(t.tags) ? t.tags.map((x) => String(x).toLowerCase()) : [],
  }));
}

async function runClaude(prompt, client) {
  const r = await runAgent({ client: client || makeClient(), model: TAG_MODEL, messages: [{ role: "user", content: prompt }], effort: "low" });
  if (!r.ok) throw new Error(`tagger: ${r.error}`);
  return { text: r.text, cost: r.usage.costUSD };
}

// Tags `probs` in place (wuNodes, tags; units only when the problem has none). Returns {tagged, cost}.
export async function tagProblems(probs, { root, data, c, onBatch, client } = {}) {
  const ctx = context({ root, data, c });
  let tagged = 0, cost = 0;
  for (let s = 0; s < probs.length; s += BATCH) {
    const batch = probs.slice(s, s + BATCH);
    const r = await runClaude(tagPrompt(batch, ctx), client);
    cost += r.cost;
    for (const t of parseTags(r.text, ctx)) {
      const p = batch[t.i]; if (!p) continue;
      // A retag replaces the tags that no longer resolve; otherwise tags only accumulate.
      if ((p.needsRetag || !(p.units || []).length) && t.units.length) p.units = [...new Set([...(p.needsRetag ? p.units || [] : []), ...t.units])];
      p.wuNodes = [...new Set([...(p.wuNodes || []), ...t.wuNodes])];
      delete p.needsRetag;
      p.tags = [...new Set([...(p.tags || []), ...t.tags])];
      tagged++;
    }
    onBatch?.({ done: Math.min(s + BATCH, probs.length), total: probs.length, cost });
  }
  return { tagged, cost };
}
