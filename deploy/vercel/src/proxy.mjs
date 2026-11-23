// Front door for homework.jtwaugh.com. The app itself runs unchanged inside a persistent Vercel Sandbox
// (see ../provision.mjs). Each request wakes the sandbox if it's asleep, starts the server if it isn't running,
// keeps the session alive while someone is using it, and forwards the request.
import { Sandbox } from "@vercel/sandbox";

const NAME = process.env.HW_SANDBOX || "homework";
const PORT = 4747;
const APP = "/vercel/sandbox/app";
const KEEP_ALIVE_MS = 20 * 60 * 1000; // stay up this long after the last request
const PASS_ENV = ["ANTHROPIC_API_KEY", "HW_ALLOW_API_KEY", "HW_PASSWORD_HASH", "HW_BUDGET_USD", "HW_STUDENT", "HW_MODEL"];
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length", "content-encoding", "te", "trailer", "proxy-authorization", "proxy-connection"]);

let cached = null; // { sandbox, base } reused across warm invocations

async function up(base) {
  try {
    const r = await fetch(`${base}/login`, { redirect: "manual", signal: AbortSignal.timeout(2500) });
    return r.status === 200 && (r.headers.get("content-type") || "").includes("text/html"); // the app's own login page
  } catch { return false; }
}

async function ensure() {
  if (cached && (await up(cached.base))) return cached;
  const sandbox = await Sandbox.get({ name: NAME, resume: true });
  const base = sandbox.domain(PORT);
  if (!(await up(base))) {
    const env = { HW_HOST: "0.0.0.0", HW_TRUST_PROXY: "1", PORT: String(PORT) };
    for (const k of PASS_ENV) if (process.env[k]) env[k] = process.env[k];
    await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", `cd ${APP} && PATH=$HOME/.local/bin:$PATH nohup node ui/server.mjs >> ${APP}/server.log 2>&1 &`],
      env,
    });
    const t0 = Date.now();
    while (!(await up(base))) {
      if (Date.now() - t0 > 45000) throw new Error("server did not start; see app/server.log in the sandbox");
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  return (cached = { sandbox, base });
}

async function keepAlive(sandbox) {
  const left = (sandbox.expiresAt?.getTime() ?? 0) - Date.now();
  if (left > KEEP_ALIVE_MS / 2) return;
  try { await sandbox.extendTimeout(KEEP_ALIVE_MS); } catch { /* at the plan's session cap; next request resumes a new session */ }
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.searchParams.get("__p") || "/";
    url.searchParams.delete("__p");
    let target;
    try { target = await ensure(); }
    catch (e) {
      cached = null;
      return new Response(`The homework app is waking up or failed to start (${e.message}). Reload in a few seconds.`, { status: 503, headers: { "content-type": "text/plain", "retry-after": "5" } });
    }
    const keep = keepAlive(target.sandbox);

    const headers = new Headers();
    for (const [k, v] of req.headers) if (!HOP.has(k) && !k.startsWith("x-vercel") && k !== "x-forwarded-for") headers.set(k, v);
    const ip = (req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
    if (ip) headers.set("x-forwarded-for", ip);
    headers.set("x-forwarded-proto", "https");
    headers.set("x-forwarded-host", url.host);

    const qs = url.searchParams.toString();
    const hasBody = !["GET", "HEAD"].includes(req.method);
    const send = (base) => fetch(`${base}${p}${qs ? `?${qs}` : ""}`, {
      method: req.method, headers, redirect: "manual",
      body: hasBody ? req.body : undefined, ...(hasBody ? { duplex: "half" } : {}),
    });
    let res;
    try {
      res = await send(target.base);
      // The sandbox went to sleep since this instance last checked: wake it and retry once (bodiless requests only).
      if (res.status >= 502 && res.status <= 504 && !hasBody) {
        cached = null;
        target = await ensure();
        res = await send(target.base);
      }
    } catch (e) {
      cached = null;
      await keep;
      return new Response(`Upstream error: ${e.message}. Reload in a few seconds.`, { status: 502, headers: { "content-type": "text/plain" } });
    }
    await keep;
    const out = new Headers();
    for (const [k, v] of res.headers) if (!HOP.has(k) && k !== "set-cookie") out.set(k, v);
    for (const c of res.headers.getSetCookie?.() || []) out.append("set-cookie", c);
    const loc = out.get("location");
    if (loc?.startsWith(target.base)) out.set("location", loc.slice(target.base.length) || "/");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  },
};
