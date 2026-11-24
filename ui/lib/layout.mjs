// Board coordinates for a graph that was not drawn by hand (an extracted Wu curriculum).
//
//   layoutGraph(graph, {top}) -> the same graph with x, y, w, h on every node
//
// Layered left to right: a node's column is the length of the longest path into it, so every arrow points right
// (or, past 12 columns, down into the next band).
// Within a column, nodes are ordered by where they first appear in the source (their `order`, else their position
// in graph.nodes) and then nudged toward the mean row of their parents, which shortens the arrows. Deterministic.
export const NODE_W = 230, NODE_H = 88;
const COL = NODE_W + 90, ROW = NODE_H + 32, BAND = 12, BAND_GAP = 160;

export function layoutGraph(graph, { top = 260, left = 0 } = {}) {
  const nodes = graph.nodes.map((n) => ({ ...n }));
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const parents = new Map(nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) if (idx.has(e.from) && idx.has(e.to) && e.from !== e.to) parents.get(e.to).push(e.from);
  const depth = new Map(), visiting = new Set();
  const d = (id) => {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0; // a cycle: the caller should have rejected it; don't loop
    visiting.add(id);
    const v = Math.max(-1, ...parents.get(id).map(d)) + 1;
    visiting.delete(id);
    depth.set(id, v);
    return v;
  };
  nodes.forEach((n) => d(n.id));
  const cols = [];
  for (const n of nodes) (cols[depth.get(n.id)] ||= []).push(n);
  const row = new Map();
  const key = (n) => n.order ?? idx.get(n.id);
  cols.forEach((col = [], c) => {
    col.sort((a, b) => key(a) - key(b));
    if (c > 0) {
      // Barycentre of the parents' rows, ties kept in source order.
      const bary = (n) => { const ps = parents.get(n.id).map((p) => row.get(p)).filter((r) => r != null); return ps.length ? ps.reduce((s, r) => s + r, 0) / ps.length : Infinity; };
      const b = new Map(col.map((n) => [n.id, bary(n)]));
      const cmp = (p, q) => (p === q ? 0 : p < q ? -1 : 1); // Infinity - Infinity would be NaN
      col.sort((x, y) => cmp(b.get(x.id), b.get(y.id)) || (key(x) - key(y)));
    }
    col.forEach((n, r) => row.set(n.id, r));
  });
  // A long chain of levels (hs-geometry has 33) would make a strip too thin to read: wrap every BAND columns into a
  // new band below the previous one, so the board stays roughly as tall as it is wide.
  let y0 = top;
  for (let b = 0; b * BAND < cols.length; b++) {
    const band = cols.slice(b * BAND, (b + 1) * BAND);
    band.forEach((col = [], i) => col.forEach((n) => Object.assign(n, { x: left + i * COL, y: y0 + row.get(n.id) * ROW, w: NODE_W, h: NODE_H })));
    y0 += Math.max(...band.map((col = []) => col.length)) * ROW + BAND_GAP;
  }
  return { ...graph, nodes };
}
