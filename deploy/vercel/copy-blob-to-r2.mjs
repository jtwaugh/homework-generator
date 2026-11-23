// One-off: copy everything in the Vercel Blob store to the R2 bucket, keys unchanged (hw/, hw-preview/, ...).
//   vercel env pull --environment=development .env.blob     (gives BLOB_READ_WRITE_TOKEN)
//   add R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET to that file
//   node --env-file=.env.blob deploy/vercel/copy-blob-to-r2.mjs [--prefix hw/] [--yes]
// Without --yes it only lists what it would copy. It refuses if R2 already holds anything under the prefix.
import { blobStore, r2Store, r2Configured, vercelBlobConfigured } from "../../ui/lib/mirror.mjs";

const args = process.argv.slice(2);
const prefix = args.includes("--prefix") ? args[args.indexOf("--prefix") + 1] : "";
const go = args.includes("--yes");
if (!vercelBlobConfigured()) { console.error("BLOB_READ_WRITE_TOKEN is not set."); process.exit(1); }
if (!r2Configured()) { console.error("Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET."); process.exit(1); }

const from = blobStore(), to = r2Store();
const blobs = await from.list(prefix);
console.log(`${blobs.length} blobs under '${prefix || "(all)"}'`);
for (const b of blobs) console.log("  " + b.pathname);
const existing = await to.list(prefix);
if (existing.length) { console.error(`R2 already holds ${existing.length} objects under '${prefix}'; not overwriting.`); process.exit(1); }
if (!go) { console.log("Dry run (R2 reachable and empty). Add --yes to copy."); process.exit(0); }
let n = 0, missing = [];
for (const b of blobs) {
  const got = await from.get(b.pathname);
  if (!got) { missing.push(b.pathname); continue; }
  await to.put(b.pathname, got.buf);
  n++;
}
console.log(`copied ${n}; R2 now holds ${(await to.list(prefix)).length} objects under '${prefix || "(all)"}'`);
if (missing.length) { console.error(`could not read ${missing.length}: ${missing.join(", ")}`); process.exit(1); }
