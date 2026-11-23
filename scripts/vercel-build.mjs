// Vercel build step: fetch the static Linux Tectonic into bin/ (bundled with the function) and make an empty
// static output folder (the function serves every page itself, so nothing in the repo is exposed as a file).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const URL = "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-x86_64-unknown-linux-musl.tar.gz";
const bin = path.join(ROOT, "bin");
fs.mkdirSync(bin, { recursive: true });
if (!fs.existsSync(path.join(bin, "tectonic"))) {
  const tgz = path.join(bin, "tectonic.tgz");
  const r = await fetch(URL);
  if (!r.ok) throw new Error(`tectonic download failed: ${r.status}`);
  fs.writeFileSync(tgz, Buffer.from(await r.arrayBuffer()));
  execFileSync("tar", ["-xzf", tgz, "-C", bin, "tectonic"]);
  fs.rmSync(tgz);
}
fs.chmodSync(path.join(bin, "tectonic"), 0o755);
console.log(execFileSync(path.join(bin, "tectonic"), ["--version"], { encoding: "utf8" }).trim());
const out = path.join(ROOT, "static-empty");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "robots.txt"), "User-agent: *\nDisallow: /\n");
