// Vercel entry: the whole Node app as one function (the sympy tool is api/cas.py).
// Code is read-only here, so the homework folder and app data live in /tmp, mirrored to Vercel Blob.
import { waitUntil } from "@vercel/functions";

process.env.HW_ROOT ||= "/tmp/hw/root";
process.env.HW_DATA ||= "/tmp/hw/data";
const { app, setKeepAlive } = await import("../ui/server.mjs");
setKeepAlive(waitUntil);

// The catch-all rewrite passes the original path as ?__p=; put it back so the app sees the real URL.
export function restoreUrl(url) {
  const u = new URL(url, "http://x");
  const p = u.searchParams.get("__p");
  if (p == null) return url;
  u.searchParams.delete("__p");
  return (p.startsWith("/") ? p : "/" + p) + (u.searchParams.size ? "?" + u.searchParams : "");
}

export default function handler(req, res) {
  req.url = restoreUrl(req.url);
  // A week turn streams for minutes; keep the instance alive even if the browser goes away mid-turn.
  const p = app(req, res);
  waitUntil(p);
  return p;
}
