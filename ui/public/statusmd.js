// The week's status record (status_revision.text in hw.db) is the app's own data, kept as Markdown so the
// teacher can read it, export it and upload an edited copy (Progress map › Scope and Sequence). Claude never reads or
// rewrites it: the brief is rendered from it, and after a set the app applies the changes itself.
// Pure functions, shared by the server (Save & finish) and the page (the preview of next week's status).

// Lines of the section under the heading that starts with `heading` ("## Review priority" matches the
// heading with its parenthetical), up to the next "## ". Returns {lines, start, end} or null.
function bounds(md, heading) {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase().startsWith(heading.toLowerCase()));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  return { lines, start, end };
}
// Replace a section's body. fn gets the body lines (without trailing blanks) and returns the new ones.
function editSection(md, heading, fn, { create = true } = {}) {
  const b = bounds(md, heading);
  if (!b) return create ? md.trimEnd() + `\n\n${heading}\n${fn([]).join("\n")}\n` : md;
  const body = b.lines.slice(b.start + 1, b.end);
  while (body.length && !body.at(-1).trim()) body.pop();
  const tail = b.lines.slice(b.end);
  return [...b.lines.slice(0, b.start + 1), ...fn(body), ...(tail.length ? [""] : []), ...tail].join("\n");
}
export function sectionItems(md, heading) {
  const b = bounds(md, heading);
  if (!b) return [];
  return b.lines.slice(b.start + 1, b.end).filter((l) => /^\s*(\d+[.)]|[-*])\s/.test(l)).map((l) => l.replace(/^\s*(\d+[.)]|[-*])\s+/, "").trim()).filter(Boolean);
}
const isNone = (t) => /^\(?\s*(none|none yet|nothing)[^)]*\)?$/i.test(t.trim());

// "TAUGHT: U01, U02 (note)" -> the line's text after the colon, verbatim.
export const statusLine = (md, st) => (md.match(new RegExp(`^${st}:(.*)$`, "m"))?.[1] || "").trim();

function splitTop(s) { // commas not inside parentheses
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Mark units CURRENT (the brief's accepted promotions): taken off NEXT/FUTURE, added to CURRENT with a dated note.
export function promoteUnits(md, ids, date = "") {
  if (!ids.length) return md;
  const tag = date ? ` (set CURRENT ${shortDate(date)})` : "";
  let out = md;
  for (const st of ["NEXT", "FUTURE"]) {
    out = out.replace(new RegExp(`^${st}:(.*)$`, "m"), (_, rest) => {
      const toks = splitTop(rest).filter((t) => !ids.some((id) => new RegExp(`^${id}\\b`).test(t)));
      return `${st}: ${toks.length ? toks.join(", ") : "(none)"}`;
    });
  }
  const has = (line, id) => splitTop(line).some((t) => new RegExp(`^${id}\\b`).test(t));
  return out.replace(/^CURRENT:(.*)$/m, (_, rest) => {
    const toks = splitTop(rest).filter((t) => !isNone(t));
    for (const id of ids) if (!has(rest, id) && !has(statusLine(out, "TAUGHT"), id)) toks.push(id + tag);
    return `CURRENT: ${toks.join(", ")}`;
  });
}

const shortDate = (d) => String(d).replace(/^(\d{1,2}\/\d{1,2})\/\d{4}$/, "$1");

// What Claude may propose after a set, in one ```json object block in the final reply:
// {"history": "one line", "review": ["the updated review-priority list"], "conventions": ["new standing conventions"]}.
// The last such block wins. Older finals carried a whole weekly_status.md instead: read the same three things
// out of it by comparing with the status the week started from.
export function statusUpdateFrom(text, base = "") {
  const blocks = [...(text || "").matchAll(/```([a-zA-Z]*)\n([\s\S]*?)\n```/g)];
  for (const m of blocks.reverse()) {
    if (m[1].toLowerCase() !== "json") continue;
    try {
      const o = JSON.parse(m[2]);
      if (o && typeof o === "object" && !Array.isArray(o) && ("history" in o || "review" in o || "conventions" in o)) {
        return {
          history: typeof o.history === "string" ? o.history.trim() : "",
          review: Array.isArray(o.review) ? o.review.map(String).map((s) => s.trim()).filter(Boolean) : null,
          conventions: Array.isArray(o.conventions) ? o.conventions.map(String).map((s) => s.trim()).filter(Boolean) : [],
        };
      }
    } catch {}
  }
  const legacy = blocks.find((m) => ["markdown", "md", ""].includes(m[1].toLowerCase()) && /Unit statuses|weekly_status/i.test(m[2]));
  if (!legacy) return null;
  const md = legacy[2], had = (h) => new Set(sectionItems(base, h));
  const fresh = (h) => sectionItems(md, h).filter((x) => !had(h).has(x));
  const review = sectionItems(md, "## Review priority");
  return { history: fresh("## Recent history").join("; "), review: review.length ? review : null, conventions: fresh("## Standing conventions"), legacy: true };
}

// Next week's status: this one, with the week's promotions, Claude's proposed history line, review list and
// conventions, and the week's input cleared for next time.
export function applyWeekUpdate(md, { date = "", promote = [], update = null } = {}) {
  let out = promoteUnits(md, promote, date);
  const u = update || {};
  if (u.review?.length) out = editSection(out, "## Review priority", () => u.review.map((r, i) => `${i + 1}. ${r.replace(/^\d+[.)]\s*/, "")}`));
  if (u.conventions?.length) {
    out = editSection(out, "## Standing conventions", (body) => {
      const have = new Set(body.map((l) => l.replace(/^\s*-\s*(\(\d[^)]*\)\s*)?/, "").trim().toLowerCase()));
      const add = u.conventions.map((c) => c.replace(/^-\s*/, "")).filter((c) => !have.has(c.replace(/^\(\d[^)]*\)\s*/, "").toLowerCase()));
      return [...body.filter((l) => !isNone(l.replace(/^\s*-\s*/, ""))), ...add.map((c) => `- ${/^\(\d/.test(c) || !date ? "" : `(${shortDate(date)}) `}${c}`)];
    });
  }
  if (u.history) {
    const line = /^\d{1,2}\/\d{1,2}/.test(u.history) || !date ? u.history : `${shortDate(date)}: ${u.history}`;
    out = editSection(out, "## Recent history", (body) => [...body, `- ${line.replace(/^-\s*/, "")}`]);
  }
  return clearWeekInput(out);
}
export function clearWeekInput(md) {
  return editSection(md, "## This week's input", (body) => body.filter((l) => !/^ {2,}/.test(l)).map((l) => l.replace(/^([A-Z][^:\n]{1,60}):.*$/, "$1: ")), { create: false });
}

// The inputs for applyWeekUpdate from a week and its final reply (the start message's brief has the
// promotions the teacher accepted; the date is the week's title date).
export function weekUpdateInputs(week, finalMsg, base) {
  const start = (week?.messages || []).find((m) => m.role === "user" && m.kind === "start");
  const promote = (start?.brief?.promotions || []).filter((p) => p.accepted !== false).map((p) => p.id);
  const date = start?.brief?.date || (week?.title || "").match(/\d{1,2}\/\d{1,2}\/\d{4}/)?.[0] || "";
  return { date, promote, update: statusUpdateFrom(finalMsg?.text || "", base) };
}

// A status upload must look like one (Progress map › Scope and Sequence › Upload).
export function checkStatusUpload(md) {
  if (typeof md !== "string" || !md.trim()) return "the file is empty";
  if (!/^(TAUGHT|CURRENT):/m.test(md)) return "no TAUGHT: or CURRENT: line, so this doesn't look like a status file";
  if (md.length > 200000) return "the file is too large";
  return null;
}
