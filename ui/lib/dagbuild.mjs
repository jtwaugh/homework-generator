// Build a curriculum's content and methods graphs from extracted chapter files (ui/scripts/wu/EXTRACT.md).
//
//   mergeChapters(chapters, {curriculum, merges}) -> {content, methods, externals, warnings}
//       chapters: [{doc, from, to, title, content: [node], methods: [node]}] in course order
//       node:     {ref, title, kind, detail, sections, pages, uses, proofUses?, restsOn?, aliases?}
//       merges:   [[ref, ref, ...]] groups a reviewer (or a dedupe pass) says are the same node
//   resolveExternals(built)  links each "@<curriculum>:<slug>" prerequisite to that curriculum's node when it exists
//   findCycles(graph) / breakCycles(graph) / danglingEdges(graph)
//
// Graphs come out in the wu_dag.json shape ({nodes: [{id, title, detail, kind, ...extra}], edges: [{from, to, prove}]})
// with ids w1, w2, ... per layer (a fresh range, so they never collide with a hand-drawn board's eNN ids).
// Methods carry restsOn (content ids). Cross-course prerequisites become `assumed` content nodes with
// xref "<curriculum>:<ref>". Every node keeps `refs` and `sources` ("EMI2a p.6") for provenance.
export const norm = (s) => String(s || "").toLowerCase().replace(/^§\s*\d+(\.\d+)*\s*/, "").replace(/[^a-z0-9]+/g, " ").trim();
const isExt = (r) => /^@[a-z0-9-]+:/.test(r);
const humanize = (slug) => slug.replace(/^(def|thm|assumed|m|wp)-/, "").replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

class UnionFind {
  constructor() { this.p = new Map(); }
  find(x) { if (!this.p.has(x)) this.p.set(x, x); let r = x; while (this.p.get(r) !== r) r = this.p.get(r); this.p.set(x, r); return r; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(rb, ra); } // first-seen stays the root
}

export function mergeChapters(chapters, { curriculum, merges = [] } = {}) {
  const warnings = [];
  const layers = { content: new Map(), methods: new Map() }; // ref -> merged node (pre-union)
  const order = { content: [], methods: [] };
  let seq = 0;
  for (const ch of chapters) {
    for (const layer of ["content", "methods"]) {
      for (const n of ch[layer] || []) {
        if (!n?.ref || !n.title) { warnings.push(`${ch.doc} p.${ch.from}: a ${layer} node without ref or title`); continue; }
        if (isExt(n.ref)) { warnings.push(`${n.ref}: an external ref used as a node's own ref; skipped`); continue; }
        const src = (n.pages || []).map((p) => `${ch.doc} p.${p}`);
        const have = layers[layer].get(n.ref);
        if (have) {
          have.sources.push(...src); have.sections.push(...(n.sections || []).map(String));
          for (const k of ["uses", "proofUses", "restsOn", "aliases"]) have[k].push(...(n[k] || []));
          if (!have.detail && n.detail) have.detail = n.detail;
          continue;
        }
        const node = { ref: n.ref, title: String(n.title).trim(), kind: n.kind, detail: n.detail || "", sections: (n.sections || []).map(String), sources: src,
          uses: [...(n.uses || [])], proofUses: [...(n.proofUses || [])], restsOn: [...(n.restsOn || [])], aliases: [...(n.aliases || [])], order: seq++ };
        layers[layer].set(n.ref, node); order[layer].push(n.ref);
      }
    }
  }
  // Same idea under different refs: explicit merge groups, then equal titles, then an alias equal to a title.
  const uf = { content: new UnionFind(), methods: new UnionFind() };
  const layerOf = (r) => (layers.content.has(r) ? "content" : layers.methods.has(r) ? "methods" : null);
  for (const g of merges) {
    const known = g.filter((r) => layerOf(r));
    for (const r of known.slice(1)) {
      if (layerOf(r) !== layerOf(known[0])) { warnings.push(`merge ${known[0]} + ${r}: different layers; not merged`); continue; }
      uf[layerOf(r)].union(known[0], r);
    }
  }
  for (const layer of ["content", "methods"]) {
    const byTitle = new Map();
    for (const r of order[layer]) {
      const n = layers[layer].get(r), t = norm(n.title);
      if (byTitle.has(t)) uf[layer].union(byTitle.get(t), r); else byTitle.set(t, r);
    }
    for (const r of order[layer]) for (const a of layers[layer].get(r).aliases) { const hit = byTitle.get(norm(a)); if (hit && hit !== r) uf[layer].union(hit, r); }
  }
  // Collapse each group into its root.
  const groups = { content: new Map(), methods: new Map() };
  for (const layer of ["content", "methods"]) {
    for (const r of order[layer]) {
      const root = uf[layer].find(r), n = layers[layer].get(r);
      const g = groups[layer].get(root);
      if (!g) { groups[layer].set(root, { ...n, refs: [r] }); continue; }
      g.refs.push(r);
      for (const k of ["sources", "sections", "uses", "proofUses", "restsOn", "aliases"]) g[k].push(...n[k]);
      if (n.title !== g.title) g.aliases.push(n.title);
      if (!g.detail) g.detail = n.detail;
      if (g.kind !== n.kind) {
        // assumed < definition < theorem: a fact one draft assumes and another proves is a theorem.
        const rank = { assumed: 0, definition: 1, theorem: 2, method: 3, "word-problem": 3 };
        if ((rank[n.kind] ?? -1) > (rank[g.kind] ?? -1)) g.kind = n.kind;
      }
    }
  }
  // A merge group's first ref names the node: its title wins (the others stay as aliases).
  for (const g of merges) {
    const head = g.find((r) => layerOf(r)), layer = head && layerOf(head);
    if (!head) continue;
    const node = groups[layer].get(uf[layer].find(head)), want = layers[layer].get(head);
    if (node.title === want.title) continue;
    node.aliases = [node.title, ...node.aliases.filter((a) => a !== want.title)];
    node.title = want.title; node.detail = want.detail || node.detail;
  }
  // Ids, in first-appearance order.
  const idOf = { content: new Map(), methods: new Map() };
  for (const layer of ["content", "methods"]) {
    let i = 0;
    for (const g of groups[layer].values()) { g.id = `w${++i}`; for (const r of g.refs) idOf[layer].set(r, g.id); }
  }
  const externals = new Map(); // "@cur:slug" -> content node
  const ext = (r) => {
    if (externals.has(r)) return externals.get(r).id;
    const [, cur, slug] = r.match(/^@([a-z0-9-]+):(.+)$/);
    const id = `w${groups.content.size + externals.size + 1}`;
    externals.set(r, { id, ref: r, title: humanize(slug), kind: "assumed", detail: `From ${cur}.`, xref: `${cur}:${slug}`, refs: [r], sources: [], sections: [], uses: [], proofUses: [], restsOn: [], aliases: [], order: -1 });
    return id;
  };
  const resolve = (r, want, from) => {
    if (isExt(r)) {
      if (want === "methods") { warnings.push(`${from}: external ${r} as a method step; dropped`); return null; }
      if (r.slice(1).startsWith(`${curriculum}:`)) return resolve(r.slice(curriculum.length + 2), want, from); // its own course
      return ext(r);
    }
    if (idOf[want].has(r)) return idOf[want].get(r);
    // Titles in place of refs happen; accept them.
    const byTitle = [...groups[want].values()].find((g) => norm(g.title) === norm(r) || g.aliases.some((a) => norm(a) === norm(r)));
    if (byTitle) return byTitle.id;
    warnings.push(`${from}: unknown ${want} ref "${r}"; dropped`);
    return null;
  };
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  const content = { nodes: [], edges: [] }, methods = { nodes: [], edges: [] };
  const edge = (g, from, to, prove) => {
    if (!from || !to || from === to) return;
    const prev = g.edges.find((e) => e.from === from && e.to === to);
    if (prev) { if (!prove) prev.prove = false; return; } // needed to state beats needed to prove
    g.edges.push({ from, to, prove: !!prove });
  };
  const out = (g) => {
    const n = { id: g.id, title: g.title, detail: g.detail, kind: g.kind, sections: uniq(g.sections), sources: uniq(g.sources), refs: g.refs };
    const al = uniq(g.aliases).filter((a) => norm(a) !== norm(g.title));
    if (al.length) n.aliases = al;
    if (g.xref) n.xref = g.xref;
    return n;
  };
  for (const g of groups.content.values()) {
    content.nodes.push(out(g));
    for (const u of uniq(g.uses)) { if (!isExt(u) && idOf.methods.has(u) && !idOf.content.has(u)) { warnings.push(`${g.ref}: uses method ${u}; dropped`); continue; } edge(content, resolve(u, "content", g.ref), g.id, false); }
    for (const u of uniq(g.proofUses)) { if (!isExt(u) && idOf.methods.has(u) && !idOf.content.has(u)) continue; edge(content, resolve(u, "content", g.ref), g.id, true); }
  }
  for (const g of groups.methods.values()) {
    const n = out(g);
    const rests = [];
    for (const u of uniq(g.uses)) {
      // A method's `uses` may name content (it belongs in restsOn) or another method.
      if (!isExt(u) && idOf.methods.has(u)) edge(methods, idOf.methods.get(u), g.id, false);
      else rests.push(u);
    }
    n.restsOn = uniq([...g.restsOn, ...rests].map((r) => resolve(r, "content", g.ref)));
    methods.nodes.push(n);
  }
  for (const x of externals.values()) content.nodes.push(out(x));
  return { content, methods, externals: [...externals.values()].map((x) => ({ id: x.id, ref: x.ref, xref: x.xref })), warnings };
}

// A slug's words without the kind prefix and filler: "theorem-on-equivalent-fractions" ~ "thm-equivalent-fractions".
const STOP = new Set(["the", "of", "a", "an", "on", "for", "and", "def", "thm", "asm", "assumed", "m", "wp", "theorem", "definition", "law", "laws", "property", "properties", "criterion"]);
const words = (s) => norm(String(s).replace(/-/g, " ")).split(" ").filter((w) => w && !STOP.has(w)).map((w) => w.replace(/s$/, ""));
const sameWords = (a, b) => { const x = words(a), y = words(b); return x.length > 0 && x.length === y.length && x.every((w) => y.includes(w)); };
function findXref(nodes, slug) {
  const own = nodes.filter((t) => !t.xref);
  return own.find((t) => t.refs?.includes(slug)) ||
    own.find((t) => norm(t.title) === norm(humanize(slug)) || (t.aliases || []).some((a) => norm(a) === norm(humanize(slug)))) ||
    own.find((t) => [...(t.refs || []), t.title, ...(t.aliases || [])].some((x) => sameWords(x, slug)));
}
// built: {<curriculum>: {content, methods}}. An external "@cur:slug" names the node there whose ref is slug, or
// whose title or alias matches the slug's words. Matched: the assumed node takes that title and xref "<cur>:<id>".
// map (optional): {"<cur>:<slug>": "<ref there>" | "<other cur>:<ref>"} for slugs the words don't find.
export function resolveExternals(built, map = {}) {
  const report = [];
  for (const [cur, b] of Object.entries(built)) {
    for (const n of b.content.nodes) {
      if (!n.xref) continue;
      // A map value "<cur>:<ref>" can also send the slug to another course (the extractor guessed the wrong one).
      const [other, slug] = (map[n.xref]?.includes(":") ? map[n.xref] : `${n.xref.split(":")[0]}:${map[n.xref] || n.xref.split(":")[1]}`).split(":");
      const target = built[other];
      const hit = target && findXref(target.content.nodes, slug);
      if (hit) { n.title = hit.title; n.detail = hit.detail || n.detail; n.xref = `${other}:${hit.id}`; n.xrefResolved = true; }
      report.push({ curriculum: cur, ref: n.refs?.[0], to: n.xref, resolved: !!hit });
    }
    // Two externals that resolved to the same node: keep one.
    const seen = new Map();
    for (const n of [...b.content.nodes]) {
      if (!n.xrefResolved) continue;
      const k = n.xref;
      if (!seen.has(k)) { seen.set(k, n.id); continue; }
      const keep = seen.get(k);
      b.content.nodes = b.content.nodes.filter((x) => x !== n);
      for (const e of b.content.edges) { if (e.from === n.id) e.from = keep; if (e.to === n.id) e.to = keep; }
      for (const m of b.methods.nodes) m.restsOn = [...new Set(m.restsOn.map((r) => (r === n.id ? keep : r)))];
      b.content.edges = dedupeEdges(b.content.edges);
    }
  }
  return report;
}
const dedupeEdges = (es) => { const m = new Map(); for (const e of es) { if (e.from === e.to) continue; const k = `${e.from}>${e.to}`; const p = m.get(k); if (!p) m.set(k, { ...e }); else if (!e.prove) p.prove = false; } return [...m.values()]; };

export function danglingEdges(g) {
  const ids = new Set(g.nodes.map((n) => n.id));
  return g.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to));
}

// Edges whose removal leaves no cycle: depth-first in node order; an edge into a node on the stack closes a cycle.
export function findCycles(g) {
  const out = new Map(g.nodes.map((n) => [n.id, []]));
  for (const e of g.edges) out.get(e.from)?.push(e);
  const mark = new Map(), back = [];
  const visit = (id) => {
    mark.set(id, 1);
    for (const e of out.get(id) || []) {
      const m = mark.get(e.to);
      if (m === 1) back.push(e); else if (!m) visit(e.to);
    }
    mark.set(id, 2);
  };
  for (const n of g.nodes) if (!mark.get(n.id)) visit(n.id);
  return back;
}
export function breakCycles(g) {
  const back = new Set(findCycles(g));
  g.edges = g.edges.filter((e) => !back.has(e));
  return [...back];
}
