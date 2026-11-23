// Optional password login, for hosting the app somewhere other than your own machine.
// Set HW_PASSWORD_HASH to the output of `node ui/scripts/hash-password.mjs`; without it there is no login (local use).
// Passwords are hashed with scrypt; sessions are random tokens in an HttpOnly, SameSite=Strict cookie, stored
// (hashed) in data/sessions.json so a restart doesn't log you out. Failed logins are rate-limited.
import fs from "node:fs";
import path from "node:path";
import { scryptSync, randomBytes, timingSafeEqual, createHash } from "node:crypto";

const SCRYPT = { N: 16384, r: 8, p: 1 };
const COOKIE = "hw_session";
const SESSION_DAYS = 30;

// "scrypt$N$r$p$salt$hash" (salt and hash base64).
export function hashPassword(pw, salt = randomBytes(16)) {
  const h = scryptSync(String(pw), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${h.toString("base64")}`;
}
export function verifyPassword(pw, stored) {
  const m = String(stored || "").trim().match(/^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/);
  if (!m) return false;
  const want = Buffer.from(m[5], "base64");
  const got = scryptSync(String(pw), Buffer.from(m[4], "base64"), want.length, { N: +m[1], r: +m[2], p: +m[3], maxmem: 256 * +m[1] * +m[2] + 1e6 });
  return got.length === want.length && timingSafeEqual(got, want);
}
export const validHash = (stored) => /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(String(stored || "").trim());

// Failed attempts per client and overall, in a sliding window. Successful logins clear the client's count.
export function rateLimiter({ perClient = 8, overall = 40, windowMs = 15 * 60e3 } = {}) {
  const fails = new Map(); let all = [];
  const prune = (arr, now) => arr.filter((t) => now - t < windowMs);
  return {
    blocked(key, now = Date.now()) {
      all = prune(all, now);
      return prune(fails.get(key) || [], now).length >= perClient || all.length >= overall;
    },
    fail(key, now = Date.now()) { fails.set(key, [...prune(fails.get(key) || [], now), now]); all.push(now); },
    ok(key) { fails.delete(key); },
  };
}

export function parseCookies(header = "") {
  return Object.fromEntries(header.split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf("="); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
}

export function createLogin({ hash, dataDir, trustProxy = false, secureCookie = null }) {
  const enabled = !!hash;
  const file = path.join(dataDir, "sessions.json");
  const sha = (t) => createHash("sha256").update(t).digest("hex");
  let sessions = {};
  try { sessions = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(sessions), { mode: 0o600 }); } catch {} };
  const limiter = rateLimiter();

  const clientKey = (req) => (trustProxy && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";
  const isHttps = (req) => secureCookie ?? (req.socket.encrypted || (trustProxy && req.headers["x-forwarded-proto"] === "https"));
  const cookie = (req, value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`;

  function loggedIn(req) {
    if (!enabled) return true;
    const t = parseCookies(req.headers.cookie)[COOKIE];
    const s = t && sessions[sha(t)];
    if (!s) return false;
    if (s.exp < Date.now()) { delete sessions[sha(t)]; save(); return false; }
    return true;
  }

  const readBody = async (req) => { let s = ""; for await (const c of req) { s += c; if (s.length > 4096) break; } return s; };
  const json = (res, code, obj, extra = {}) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra }); res.end(JSON.stringify(obj)); };

  // Returns true if it handled the request (login routes, or turning away a request without a session).
  async function gate(req, res) {
    if (!enabled) return false;
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/login" && req.method === "GET") {
      if (loggedIn(req)) { res.writeHead(302, { Location: "/" }); res.end(); return true; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" });
      res.end(LOGIN_PAGE); return true;
    }
    if (p === "/api/login" && req.method === "POST") {
      const key = clientKey(req);
      if (limiter.blocked(key)) return json(res, 429, { error: "Too many attempts. Try again in a few minutes." }), true;
      let pw = "";
      try { pw = JSON.parse(await readBody(req)).password || ""; } catch {}
      if (!verifyPassword(pw, hash)) {
        limiter.fail(key);
        await new Promise((r) => setTimeout(r, 400));
        return json(res, 401, { error: "Wrong password." }), true;
      }
      limiter.ok(key);
      const t = randomBytes(32).toString("base64url");
      const now = Date.now();
      for (const [k, s] of Object.entries(sessions)) if (s.exp < now) delete sessions[k];
      sessions[sha(t)] = { exp: now + SESSION_DAYS * 864e5 };
      save();
      return json(res, 200, { ok: true }, { "Set-Cookie": cookie(req, t, SESSION_DAYS * 86400) }), true;
    }
    if (p === "/api/logout" && req.method === "POST") {
      const t = parseCookies(req.headers.cookie)[COOKIE];
      if (t) { delete sessions[sha(t)]; save(); }
      return json(res, 200, { ok: true }, { "Set-Cookie": cookie(req, "", 0) }), true;
    }
    if (loggedIn(req)) return false;
    if (p.startsWith("/api/")) return json(res, 401, { error: "login required" }), true;
    res.writeHead(302, { Location: "/login" }); res.end();
    return true;
  }
  return { enabled, gate, loggedIn };
}

const LOGIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Homework · log in</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1d1d1f; background: #f6f5f1; }
  form { width: min(340px, 90vw); padding: 28px; background: #fff; border: 1px solid #e3e1da; border-radius: 12px; }
  h1 { font-size: 18px; margin: 0 0 16px; }
  label { display: block; font-size: 12.5px; font-weight: 600; color: #6e6e73; margin-bottom: 4px; }
  input { width: 100%; box-sizing: border-box; font: inherit; border: 1px solid #e3e1da; border-radius: 8px; padding: 8px 10px; }
  input:focus { outline: 2px solid #e8f1ed; border-color: #2f5d50; }
  button { margin-top: 14px; width: 100%; font: inherit; font-weight: 600; padding: 8px; border: none; border-radius: 8px; background: #2f5d50; color: #fff; cursor: pointer; }
  button:disabled { opacity: .6; }
  .err { color: #b02a2a; font-size: 13.5px; min-height: 1.5em; margin: 8px 0 0; }
</style></head>
<body><form id="f"><h1>Homework</h1>
  <label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" autofocus required>
  <button>Log in</button><p class="err" id="err"></p></form>
<script>
  const f = document.getElementById("f"), err = document.getElementById("err");
  f.onsubmit = async (e) => {
    e.preventDefault(); err.textContent = ""; f.querySelector("button").disabled = true;
    try {
      const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: f.pw.value }) });
      if (r.ok) return location.replace("/");
      err.textContent = (await r.json().catch(() => ({}))).error || "Login failed.";
    } catch { err.textContent = "Can't reach the server."; }
    f.querySelector("button").disabled = false; f.pw.select();
  };
</script></body></html>`;
