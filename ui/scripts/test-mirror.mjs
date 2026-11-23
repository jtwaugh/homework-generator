// Tests for lib/mirror.mjs against an in-memory blob store. Run: node ui/scripts/test-mirror.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMirror } from "../lib/mirror.mjs";

let pass = 0, fail = 0;
async function test(name, fn) { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + "\n    " + (e.stack || e.message)); } }

function memStore() {
  const m = new Map(); let n = 0;
  return {
    m, puts: 0,
    async list(prefix) { return [...m].filter(([k]) => k.startsWith(prefix)).map(([pathname, v]) => ({ pathname, etag: v.etag })); },
    async get(p) { const v = m.get(p); return v ? { buf: Buffer.from(v.buf), etag: v.etag } : null; },
    async put(p, buf) { this.puts++; const etag = `e${++n}`; m.set(p, { buf: Buffer.from(buf), etag }); return etag; },
    async del(ps) { for (const p of ps) m.delete(p); },
  };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hw-mirror-"));
const instance = (store) => { const root = tmp(), data = tmp(); return { root, data, mir: createMirror({ roots: { root, data }, store, skip: (rel, pre) => pre === "data" && /^(build|logs)\//.test(rel) }) }; };

await test("disabled without a store: every call is a no-op", async () => {
  const m = createMirror({ roots: { data: tmp() } });
  assert.equal(m.enabled, false);
  await m.pull(); await m.push();
});

await test("push uploads changed files only, under base/prefix/path, and skips excluded folders", async () => {
  const s = memStore(), a = instance(s);
  fs.mkdirSync(path.join(a.data, "weeks"), { recursive: true });
  fs.mkdirSync(path.join(a.data, "build", "x"), { recursive: true });
  fs.writeFileSync(path.join(a.data, "weeks", "w.json"), "{}");
  fs.writeFileSync(path.join(a.data, "build", "x", "hw.pdf"), "pdf");
  fs.writeFileSync(path.join(a.root, "weekly_status.md"), "# s");
  await a.mir.push();
  assert.deepEqual([...s.m.keys()].sort(), ["hw/data/weeks/w.json", "hw/root/weekly_status.md"]);
  await a.mir.push();
  assert.equal(s.puts, 2, "unchanged files are not re-uploaded");
});

await test("a second instance pulls what the first pushed, then sees edits and deletes", async () => {
  const s = memStore(), a = instance(s), b = instance(s);
  fs.writeFileSync(path.join(a.root, "notes.md"), "v1");
  fs.writeFileSync(path.join(a.root, "gone.md"), "x");
  await a.mir.push();
  await b.mir.pull();
  assert.equal(fs.readFileSync(path.join(b.root, "notes.md"), "utf8"), "v1");
  fs.writeFileSync(path.join(a.root, "notes.md"), "v2 longer");
  fs.rmSync(path.join(a.root, "gone.md"));
  await a.mir.push();
  assert.equal(s.m.has("hw/root/gone.md"), false, "local delete removes the blob");
  await b.mir.pull();
  assert.equal(fs.readFileSync(path.join(b.root, "notes.md"), "utf8"), "v2 longer");
  assert.equal(fs.existsSync(path.join(b.root, "gone.md")), false, "remote delete removes the local copy");
});

await test("pull leaves files alone when nothing changed", async () => {
  const s = memStore(), a = instance(s);
  fs.writeFileSync(path.join(a.root, "f.md"), "x");
  await a.mir.push();
  let gets = 0; const g = s.get.bind(s); s.get = async (p) => { gets++; return g(p); };
  await a.mir.pull();
  assert.equal(gets, 0);
});

await test("putNow / fetchNow / delNow move one file right away", async () => {
  const s = memStore(), a = instance(s), b = instance(s);
  const f = path.join(a.data, "weeks", "w.stop");
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "1");
  await a.mir.putNow(f);
  assert.equal(String(await b.mir.fetchNow(path.join(b.data, "weeks", "w.stop"))), "1");
  await a.mir.delNow(f);
  assert.equal(await b.mir.fetchNow(path.join(b.data, "weeks", "w.stop")), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
