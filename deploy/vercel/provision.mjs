// One-time (and re-runnable) setup of the persistent sandbox that runs the app.
//   cd deploy/vercel && vercel env pull .env.local && node --env-file=.env.local provision.mjs [--fresh] [--no-data]
// Uploads the code, your local homework files (.tex, the three .md files) and ui/data state, then installs the
// claude CLI, Tectonic and the sympy venv. Re-running updates the code and restarts the server; data in the
// sandbox is only overwritten with --fresh (which deletes and recreates the sandbox) or on first creation.
import { Sandbox } from "@vercel/sandbox";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const NAME = process.env.HW_SANDBOX || "homework";
const ROOT = path.resolve(import.meta.dirname, "../..");
const APP = "/vercel/sandbox/app";
const args = new Set(process.argv.slice(2));
// Static (musl) build: the dynamically linked one needs graphite2/harfbuzz/ICU, which the image lacks.
const TECTONIC_URL = "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-x86_64-unknown-linux-musl.tar.gz";
const DATA_KEEP = ["weeks", "corpus", "backups", "notes", "dag_state.json", "definitions.json", "wu_dag.json", "wu_methods_dag.json"];

async function sh(sb, script, { quiet = false } = {}) {
  const r = await sb.runCommand({ cmd: "bash", args: ["-lc", `set -euo pipefail; export PATH=$HOME/.local/bin:$PATH; ${script}`] });
  const out = (await r.stdout()) + (await r.stderr());
  if (!quiet || r.exitCode) process.stdout.write(out.split("\n").slice(-25).join("\n") + "\n");
  if (r.exitCode) throw new Error(`failed (${r.exitCode}): ${script.slice(0, 80)}`);
  return out;
}

function tarball({ withData }) {
  const list = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter((f) => f && !f.startsWith("deploy/"));
  for (const f of fs.readdirSync(ROOT)) if (/\.(tex|md)$/i.test(f) && !list.includes(f)) list.push(f);
  if (withData) for (const d of DATA_KEEP) if (fs.existsSync(path.join(ROOT, "ui/data", d))) list.push(`ui/data/${d}`);
  const out = path.join(os.tmpdir(), `hw-${Date.now()}.tgz`);
  execFileSync("tar", ["-czf", out, "--no-xattrs", "--exclude=.DS_Store", "-C", ROOT, ...new Set(list)], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return out;
}

let sb;
let created = false;
if (args.has("--fresh")) { try { await (await Sandbox.get({ name: NAME })).delete(); console.log("deleted old sandbox"); } catch {} }
try { sb = await Sandbox.get({ name: NAME, resume: true }); console.log(`resumed ${NAME}`); }
catch {
  sb = await Sandbox.create({ name: NAME, persistent: true, image: "vercel/sandbox/universal", ports: [4747], timeout: 45 * 60 * 1000, resources: { vcpus: 2 } });
  created = true;
  console.log(`created ${NAME}`);
}

const withData = created && !args.has("--no-data");
const tgz = tarball({ withData });
console.log(`uploading ${(fs.statSync(tgz).size / 1024).toFixed(0)} KB (${withData ? "code + data" : "code only"})`);
await sb.writeFiles([{ path: "/vercel/sandbox/upload.tgz", content: fs.readFileSync(tgz) }]);
fs.unlinkSync(tgz);
await sh(sb, `mkdir -p ${APP} && tar -xzf /vercel/sandbox/upload.tgz -C ${APP} && rm /vercel/sandbox/upload.tgz && ls ${APP}`, { quiet: true });

await sh(sb, `mkdir -p $HOME/.local/bin
npm install -g --prefix $HOME/.local @anthropic-ai/claude-code@latest >/dev/null # always update: ui/server.mjs passes --thinking-display
tectonic --version >/dev/null 2>&1 || curl -fsSL "${TECTONIC_URL}" | tar -xz -C $HOME/.local/bin tectonic
cd ${APP} && { [ -x ui/data/venv/bin/python ] || { python3 -m venv ui/data/venv && ui/data/venv/bin/pip install -q sympy; }; }
echo "node $(node -v) | claude $(claude --version) | $(tectonic --version) | sympy $(ui/data/venv/bin/python -c 'import sympy; print(sympy.__version__)')"`);

// Warm Tectonic's TeX bundle cache so the first real compile isn't slow.
await sh(sb, `cd /tmp && f=$(ls -t ${APP}/hw_*.tex ${APP}/HW_*.tex 2>/dev/null | head -1); [ -n "$f" ] && { cp "$f" warm.tex; tectonic warm.tex >/dev/null 2>&1 && echo "tectonic warm: ok" || echo "tectonic warm: compile failed (bundle still cached)"; } || true`);

// Restart the server so the next request starts it with the current code.
await sh(sb, `pkill -f "[n]ode ui/server.mjs" || true; echo restarted`, { quiet: true });
console.log(`ready: ${sb.domain(4747)}  (the proxy starts the server on the next request)`);
