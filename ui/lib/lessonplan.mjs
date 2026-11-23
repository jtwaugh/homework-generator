// The lesson plan (curriculum_ladder.md) as structured data, and back to the exact same text.
//
//   parseLadder(md) -> { planText, layout, units, gated }
//     planText  the preamble (everything before the first "## " heading)
//     layout    [{ heading, items: [{unit: key} | {gated: grp} | {raw: line}] }]  (keeps the file's order and blank lines)
//     units     [{ key, name, about, needs: [keys], stance, notes, section, ord }]
//     gated     [{ grp, terms: [..], unit }]
//   renderLadder(plan) -> md    (renderLadder(parseLadder(md)) === md for the ladder format)
//
// A unit line:  "- U05 Name. About sentences. Needs U03, U04. Formal. Notes."  (every part after the name optional)
// A gated line: "- term, term: U10"
export const UNIT_KEY = /^(U\d\d|M\d|F\d)$/;
const UNIT_LINE = /^- (U\d\d|M\d|F\d) (.*)$/;
const GATED_LINE = /^- (.+): (U\d\d|M\d|F\d)$/;
const NEEDS = /(^|\s)Needs ((?:U\d\d|M\d|F\d)(?:, (?:U\d\d|M\d|F\d))*)\.(?=\s|$)/;
const STANCE = /(^|\s)(Formal|Informal[^.]*)\.(?=\s|$)/;

export function parseUnitLine(line) {
  const m = line.match(UNIT_LINE);
  if (!m) return null;
  const [, key, body] = m;
  const dot = body.search(/\.(\s|$)/);
  if (dot < 0) return null;
  const name = body.slice(0, dot), tail = body.slice(dot + 1).trim();
  let about = tail, needs = [], stance = "", notes = "";
  const n = tail.match(NEEDS);
  if (n) {
    about = tail.slice(0, n.index).trim();
    needs = n[2].split(", ");
    let after = tail.slice(n.index + n[0].length).trim();
    const s = after.match(/^(Formal|Informal[^.]*)\.(?=\s|$)/);
    if (s) { stance = s[1]; after = after.slice(s[0].length).trim(); }
    notes = after;
  } else {
    const s = tail.match(STANCE);
    if (s) { about = tail.slice(0, s.index).trim(); stance = s[2]; notes = tail.slice(s.index + s[0].length).trim(); }
  }
  return { key, name, about, needs, stance, notes };
}

export function renderUnitLine(u) {
  const parts = [u.about, u.needs?.length ? `Needs ${u.needs.join(", ")}.` : "", u.stance ? `${u.stance}.` : "", u.notes].filter(Boolean);
  return `- ${u.key} ${u.name}.${parts.length ? " " + parts.join(" ") : ""}`;
}

export function parseLadder(md) {
  const lines = String(md || "").split("\n");
  const first = lines.findIndex((l) => /^## /.test(l));
  const planText = (first < 0 ? lines : lines.slice(0, first)).join("\n");
  const layout = [], units = [], gated = [];
  let sec = null;
  for (const line of first < 0 ? [] : lines.slice(first)) {
    if (/^## /.test(line)) { sec = { heading: line.slice(3), items: [] }; layout.push(sec); continue; }
    const u = parseUnitLine(line);
    if (u && renderUnitLine(u) === line) {
      units.push({ ...u, section: layout.length - 1, ord: units.length });
      sec.items.push({ unit: u.key });
      continue;
    }
    const g = line.match(GATED_LINE);
    if (g && /^gated/i.test(sec.heading)) {
      gated.push({ grp: gated.length, terms: g[1].split(", "), unit: g[2] });
      sec.items.push({ gated: gated.length - 1 });
      continue;
    }
    sec.items.push({ raw: line });
  }
  return { planText, layout, units, gated, hasSections: first >= 0 };
}

export function renderLadder({ planText, layout, units, gated, hasSections = true }) {
  const byKey = new Map(units.map((u) => [u.key, u]));
  const byGrp = new Map(gated.map((g) => [g.grp, g]));
  const placed = new Set();
  const out = [planText];
  if (!hasSections && !layout.length) return planText;
  layout.forEach((sec, si) => {
    out.push(`## ${sec.heading}`);
    // Units added since the layout was recorded go after this section's last unit line.
    const extra = units.filter((u) => u.section === si && !sec.items.some((it) => it.unit === u.key)).sort((a, b) => a.ord - b.ord);
    let lastUnit = -1;
    sec.items.forEach((it, i) => { if (it.unit) lastUnit = i; });
    const items = [...sec.items];
    items.splice(lastUnit + 1, 0, ...extra.map((u) => ({ unit: u.key })));
    for (const it of items) {
      if (it.unit) { const u = byKey.get(it.unit); if (u && !placed.has(u.key)) { out.push(renderUnitLine(u)); placed.add(u.key); } }
      else if (it.gated != null) { const g = byGrp.get(it.gated); if (g) out.push(`- ${g.terms.join(", ")}: ${g.unit}`); }
      else out.push(it.raw);
    }
  });
  return out.join("\n");
}

// Line-by-line differences, for the migration's round-trip check.
export function lineDiff(a, b) {
  const A = a.split("\n"), B = b.split("\n"), out = [];
  for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) out.push({ line: i + 1, want: A[i], got: B[i] });
  return out;
}
