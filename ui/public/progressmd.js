// Content and Methods boards as Markdown: a deterministic export and import of where the student stands on
// each Wu node (Progress map › Content / Methods). No Claude involved: import sets the teacher's own state
// ("set by you") on every listed node whose state differs from what the board shows now, and `auto` drops
// that setting so Claude's guess shows again. An export imported back unchanged changes nothing.
// Pure functions, shared by the server (GET /api/dag/export, POST /api/dag/import) and the page (the confirm).

export const KINDS = [["assumed", "Assumed (pre-algebra)"], ["definition", "Definitions"], ["theorem", "Theorems"], ["method", "Methods"], ["word-problem", "Word problems (not used)"]];
const BOARD = { content: "Content", methods: "Methods" };
const keyOf = (board, id) => (board === "methods" ? "m:" + id : id);

// override > guess > not-yet
function current(key, guess, overrides) {
  const o = overrides?.[key];
  if (o) return { state: o.state, by: "you" };
  const g = guess?.nodes?.[key];
  if (g) return { state: g.state || "not-yet", by: "claude", confidence: g.confidence };
  return { state: "not-yet", by: null };
}

export function exportBoardMd({ board, dag, guess, overrides, student = "", date = new Date().toISOString().slice(0, 10) }) {
  const out = [`# ${BOARD[board]} progress${student ? ` — ${student}` : ""} — ${date}`, "",
    "States: done | partial | not-yet | auto (auto drops your setting and uses Claude's guess).",
    "Change the [state] on any line and import the file. Only lines starting \"- <id> [state]\" are read; the rest of a line is ignored.", ""];
  const known = new Set(KINDS.map(([k]) => k));
  for (const [kind, label] of [...KINDS, ["", "Other"]]) {
    const ns = dag.nodes.filter((n) => (kind ? n.kind === kind : !known.has(n.kind)));
    if (!ns.length) continue;
    out.push(`## ${label}`);
    for (const n of ns) {
      const key = keyOf(board, n.id), c = current(key, guess, overrides);
      const by = c.by === "you" ? " — you" : c.by === "claude" ? ` — Claude${c.confidence != null ? " " + Math.round(c.confidence * 100) / 100 : ""}` : "";
      out.push(`- ${key} [${c.state}] ${String(n.title || "").replace(/\s+/g, " ").trim()}${by}`);
    }
    out.push("");
  }
  return out.join("\n");
}

const STATE_WORDS = { done: "done", partial: "partial", partly: "partial", "not-yet": "not-yet", "not yet": "not-yet", notyet: "not-yet", auto: "auto" };

// {changes: [{key, state}] (state null = back to Claude's guess), errors: [string], read: lines read}.
// Errors (unknown or wrong-board ids, bad states, a word problem set, a node listed twice, nothing to read)
// mean the file is refused as a whole.
export function parseBoardMd(text, { board, dag, guess, overrides }) {
  const nodes = new Map(dag.nodes.map((n) => [keyOf(board, n.id), n]));
  const changes = [], errors = [], seen = new Set();
  let read = 0;
  String(text || "").replace(/\r\n/g, "\n").split("\n").forEach((line, i) => {
    const m = line.match(/^\s*[-*]\s+([A-Za-z0-9:_-]+)\s*\[([^\]]*)\]/);
    if (!m) return;
    read++;
    const key = m[1], word = m[2].trim().toLowerCase(), at = `line ${i + 1}`;
    const n = nodes.get(key);
    if (!n) {
      const other = board === "methods" ? !key.startsWith("m:") && nodes.has("m:" + key) : key.startsWith("m:") && nodes.has(key.slice(2));
      errors.push(`${at}: ${key} is not a ${BOARD[board].toLowerCase()} node${other ? ` (did you mean ${board === "methods" ? "m:" + key : key.slice(2)}?)` : ""}`);
      return;
    }
    const state = STATE_WORDS[word];
    if (!state) { errors.push(`${at}: "${m[2]}" is not a state (done, partial, not-yet or auto)`); return; }
    if (seen.has(key)) { errors.push(`${at}: ${key} is listed twice`); return; }
    seen.add(key);
    const c = current(key, guess, overrides);
    if (state === "auto") { if (c.by === "you") changes.push({ key, state: null }); return; }
    if (state === c.state) return;
    if (n.kind === "word-problem") { errors.push(`${at}: ${key} is a word problem; those are left out of these sets`); return; }
    changes.push({ key, state });
  });
  if (!read) errors.push(`no "- <id> [state]" lines for the ${BOARD[board].toLowerCase()} board`);
  return { changes, errors, read };
}
