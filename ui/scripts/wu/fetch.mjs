#!/usr/bin/env node
// Stage 1+2: download Wu's free drafts and split each into per-page text.
//
//   node ui/scripts/wu/fetch.mjs [--force] [doc ...]
//
// Downloads go to _raw/ (skipped when present); pdftotext writes <doc>/pages/NNNN.txt. Prints coverage per book.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { BOOKS, DOCS, BASE_URL, p, pageFile } from "./sources.mjs";

const args = process.argv.slice(2);
const force = args.includes("--force");
const only = args.filter((a) => !a.startsWith("--"));
const docs = Object.keys(DOCS).filter((d) => !only.length || only.includes(d));

fs.mkdirSync(p("_raw"), { recursive: true });
const manifestFile = p("manifest.json");
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : { docs: {} };

for (const doc of docs) {
  const pdf = p("_raw", `${doc}.pdf`), url = BASE_URL + encodeURIComponent(doc) + ".pdf";
  if (force || !fs.existsSync(pdf)) {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (homework-ui curriculum import)" } });
    if (!res.ok) { console.error(`${doc}: HTTP ${res.status}`); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.subarray(0, 5).toString() !== "%PDF-") { console.error(`${doc}: not a PDF`); continue; }
    fs.writeFileSync(pdf, buf);
  }
  const buf = fs.readFileSync(pdf);
  const info = execFileSync("pdfinfo", [pdf], { encoding: "utf8" });
  const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1] || 0);
  const dir = p(doc, "pages");
  if (force || !fs.existsSync(pageFile(doc, pages))) {
    fs.mkdirSync(dir, { recursive: true });
    // One call for the whole document; pdftotext separates pages with form feeds.
    const text = execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", pdf, "-"], { encoding: "utf8", maxBuffer: 1 << 28 });
    text.split("\f").slice(0, pages).forEach((t, i) => fs.writeFileSync(pageFile(doc, i + 1), t));
  }
  let words = 0, thin = 0;
  for (let i = 1; i <= pages; i++) { const w = (fs.readFileSync(pageFile(doc, i), "utf8").match(/\S+/g) || []).length; words += w; if (w < 40) thin++; }
  manifest.docs[doc] = { url, title: DOCS[doc].title, book: DOCS[doc].book, sha256: createHash("sha256").update(buf).digest("hex"), pages, words, thinPages: thin };
  console.log(`${doc.padEnd(24)} ${String(pages).padStart(4)} pages ${String(words).padStart(7)} words ${thin ? `(${thin} near-empty pages)` : ""}`);
}
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1) + "\n");

console.log("\nCoverage by book:");
for (const [b, title] of Object.entries(BOOKS)) {
  const ds = Object.entries(manifest.docs).filter(([, d]) => d.book === b);
  const pages = ds.reduce((s, [, d]) => s + d.pages, 0);
  console.log(`  ${title}\n    ${ds.length ? ds.map(([k, d]) => `${k} (${d.pages}p)`).join(", ") : "nothing free"}${pages ? ` = ${pages} pages` : ""}`);
}
