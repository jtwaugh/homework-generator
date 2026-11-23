// Write-through mirror between local folders and Vercel Blob, for hosting on Vercel.
//
// The app reads and writes plain files (sync and async fs, as it always has). When hosted, those folders live
// in the function's /tmp, which is per-instance and disappears; this mirror makes Blob the durable copy:
//   pull()  before a request: download blobs that changed since this instance last saw them, drop local
//           files whose blob was deleted elsewhere.
//   push()  after a write: upload local files that changed (by size + mtime), delete blobs whose file is gone.
//   putNow(file) / fetchNow(file): one file, right away (live progress and stop flags across instances).
// Locally (no Blob store configured) every method is a no-op and the folders are the only copy.
//
// `store` is injectable for tests: { list(prefix) -> [{pathname, etag}], get(pathname) -> Buffer|null,
// put(pathname, buf), del(pathnames[]) }.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export function blobStore() {
  const lib = import("@vercel/blob");
  return {
    async list(prefix) {
      const { list } = await lib;
      const out = [];
      let cursor;
      do {
        const r = await list({ prefix, cursor, limit: 1000 });
        out.push(...r.blobs.map((b) => ({ pathname: b.pathname, etag: b.etag })));
        cursor = r.hasMore ? r.cursor : undefined;
      } while (cursor);
      return out;
    },
    async get(pathname) {
      const { get } = await lib;
      const r = await get(pathname, { access: "private", useCache: false });
      if (!r || r.statusCode !== 200) return null;
      return { buf: Buffer.from(await new Response(r.stream).arrayBuffer()), etag: r.blob.etag };
    },
    async put(pathname, buf) {
      const { put } = await lib;
      const r = await put(pathname, buf, { access: "private", allowOverwrite: true, addRandomSuffix: false, cacheControlMaxAge: 60, contentType: "application/octet-stream" });
      return r.etag;
    },
    async del(pathnames) {
      const { del, list } = await lib;
      if (!pathnames.length) return;
      // del() takes URLs; look them up by pathname.
      const urls = [];
      for (const p of pathnames) { const r = await list({ prefix: p, limit: 5 }); const b = r.blobs.find((x) => x.pathname === p); if (b) urls.push(b.url); }
      if (urls.length) await del(urls);
    },
  };
}

export const blobConfigured = (env = process.env) => !!(env.BLOB_READ_WRITE_TOKEN || env.BLOB_STORE_ID);

// roots: { prefix: localDir }, e.g. { root: "/tmp/hw/root", data: "/tmp/hw/data" }.
// skip(relPath) -> true for files that stay local (caches, logs, builds).
// beforeReplace(file): called before a pull overwrites or deletes a local file (the server closes hw.db first).
export function createMirror({ roots, store = null, skip = () => false, base = "hw", beforeReplace = () => {} } = {}) {
  if (!store) return { enabled: false, pull: async () => {}, push: async () => {}, putNow: async () => {}, fetchNow: async () => null, delNow: async () => {} };
  // pathname -> { etag, size, mtimeMs } as of the last sync, for files this instance holds.
  const known = new Map();
  const toBlob = (file) => {
    for (const [pre, dir] of Object.entries(roots)) {
      const rel = path.relative(dir, file);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) return skip(rel.split(path.sep).join("/"), pre) ? null : `${base}/${pre}/${rel.split(path.sep).join("/")}`;
    }
    return null;
  };
  const toFile = (pathname) => {
    const [b, pre, ...rest] = pathname.split("/");
    if (b !== base || !roots[pre] || !rest.length) return null;
    const rel = rest.join("/");
    return skip(rel, pre) ? null : path.join(roots[pre], ...rest);
  };
  const stamp = (file) => { try { const s = fs.statSync(file); return { size: s.size, mtimeMs: s.mtimeMs }; } catch { return null; } };
  // One sync at a time; a pull or push requested while one runs waits for it.
  let chain = Promise.resolve();
  const serial = (fn) => (chain = chain.then(fn, fn));

  async function pullNow() {
    const blobs = await store.list(`${base}/`);
    const seen = new Set();
    for (const b of blobs) {
      const file = toFile(b.pathname);
      if (!file) continue;
      seen.add(b.pathname);
      const k = known.get(b.pathname);
      if (k && k.etag === b.etag && fs.existsSync(file)) continue;
      const got = await store.get(b.pathname);
      if (!got) continue;
      await fsp.mkdir(path.dirname(file), { recursive: true });
      beforeReplace(file);
      await fsp.writeFile(file, got.buf);
      known.set(b.pathname, { etag: got.etag || b.etag, ...stamp(file) });
    }
    for (const [p] of known) if (!seen.has(p)) { const f = toFile(p); if (f) { beforeReplace(f); await fsp.rm(f, { force: true }); } known.delete(p); }
  }

  function walk(dir, out = []) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of ents) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f, out);
      else if (e.isFile()) out.push(f);
    }
    return out;
  }

  async function pushNow() {
    const present = new Set();
    for (const dir of Object.values(roots)) {
      for (const file of walk(dir)) {
        const p = toBlob(file);
        if (!p) continue;
        present.add(p);
        const st = stamp(file), k = known.get(p);
        if (k && st && k.size === st.size && k.mtimeMs === st.mtimeMs) continue;
        const etag = await store.put(p, await fsp.readFile(file));
        known.set(p, { etag, ...st });
      }
    }
    const gone = [...known.keys()].filter((p) => !present.has(p));
    if (gone.length) { await store.del(gone); for (const p of gone) known.delete(p); }
  }

  return {
    enabled: true,
    pull: () => serial(pullNow),
    push: () => serial(pushNow),
    async putNow(file) {
      const p = toBlob(file);
      if (!p || !fs.existsSync(file)) return;
      const etag = await store.put(p, await fsp.readFile(file));
      known.set(p, { etag, ...stamp(file) });
    },
    async fetchNow(file) {
      const p = toBlob(file);
      if (!p) return null;
      const got = await store.get(p);
      return got ? got.buf : null;
    },
    async delNow(file) {
      const p = toBlob(file);
      if (!p) return;
      await store.del([p]);
      known.delete(p);
    },
  };
}
