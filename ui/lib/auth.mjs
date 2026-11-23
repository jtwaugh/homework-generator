// How the app pays for Claude: the Anthropic API, with ANTHROPIC_API_KEY (billed per token to that API account).
// (The app used to drive the `claude` CLI on a Claude subscription; it now calls the API directly.)

export function decideAuth(env = process.env) {
  if (env.ANTHROPIC_API_KEY) return { mode: "api-key", note: "" };
  return { mode: "none", note: "ANTHROPIC_API_KEY is not set. Add it to the environment (or .env) to use Claude." };
}

export const claudeAuth = (env = process.env) => decideAuth(env);
