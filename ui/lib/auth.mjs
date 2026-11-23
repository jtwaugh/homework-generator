// How the app pays for Claude. A logged-in Claude subscription always wins. Only if none is found, and the teacher
// opted in with HW_ALLOW_API_KEY=1, is ANTHROPIC_API_KEY passed to `claude -p` (billed per token through the API).
// Otherwise every API-key variable is stripped so nobody is billed through the API by accident.
import { spawnSync } from "node:child_process";

const KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
const stripped = (env) => { const e = { ...env }; for (const k of KEY_VARS) delete e[k]; return e; };

// Pure decision, so the tests can cover it: status is `claude auth status --json` run without API keys (or null).
export function decideAuth(status, env = process.env) {
  const optIn = /^(1|true|yes)$/i.test(env.HW_ALLOW_API_KEY || "");
  const hasKey = !!env.ANTHROPIC_API_KEY;
  if (status?.loggedIn && status.authMethod === "claude.ai")
    return { mode: "subscription", plan: status.subscriptionType || null, note: hasKey ? "Claude subscription found; ignoring ANTHROPIC_API_KEY." : "" };
  if (optIn && hasKey) return { mode: "api-key", note: "No Claude subscription found: using ANTHROPIC_API_KEY (HW_ALLOW_API_KEY=1). Turns are billed to your API account." };
  if (status?.loggedIn) return { mode: "other", note: `The claude CLI is logged in via ${status.authMethod}, not a Claude subscription.` };
  return {
    mode: "none",
    note: hasKey
      ? "No Claude subscription found. ANTHROPIC_API_KEY is set but ignored; start with HW_ALLOW_API_KEY=1 to use it (billed per token)."
      : "No Claude subscription found. Run `claude` then /login, or set ANTHROPIC_API_KEY and HW_ALLOW_API_KEY=1.",
  };
}

let cached = null;
export function claudeAuth(env = process.env) {
  if (cached) return cached;
  let status = null;
  const r = spawnSync("claude", ["auth", "status", "--json"], { env: stripped(env), encoding: "utf8", timeout: 15000 });
  try { status = JSON.parse(r.stdout); } catch {}
  return (cached = decideAuth(status, env));
}

// The environment every `claude -p` child gets.
export function claudeEnv(env = process.env) {
  return claudeAuth(env).mode === "api-key" ? { ...env } : stripped(env);
}
