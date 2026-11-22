#!/usr/bin/env node
// Live-debug harness: a persistent headless Chrome pointed at the app, controlled from the shell.
//
//   node ui/dev/harness.mjs serve            # start (keeps running; one browser, one page)
//   node ui/dev/harness.mjs <cmd> [args...]  # talk to it
//
// Commands:
//   state                     app state summary (phase, week, next action, units widget…)
//   outline                   visible headings, text and controls, with selectors to click
//   shot [--full] [selector]  screenshot → prints the PNG path
//   click <selector|text:Label>   click an element (by CSS, or by visible text)
//   type <selector> <text>    set a field's value and fire input
//   select <selector> <value> set a <select> and fire change
//   key <Key|Meta+Enter> [selector]   press a key (focuses selector first): Escape, ArrowRight, Meta+Enter…
//   drag <from> <to|dx,dy>    drag with the mouse (HTML5 drag-and-drop and pointer drags/pans)
//   wheel <selector> <dy>     scroll-wheel over an element (the map zooms)
//   hover <selector>          move the mouse over an element
//   upload <selector> <file…> choose files in an <input type=file> (or the one inside selector)
//   wait <ms|js-condition> [timeoutMs]   sleep, or poll until a page expression is truthy (e.g. !__hw.week.running)
//   eval <js>                 evaluate in the page (await allowed), prints JSON
//   logs                      everything since the last call: the app's event log (UI events, HTTP, claude
//                             runs and tool calls, compiles) plus browser console, page errors, failed requests
//   goto <url|#hash|/path>    navigate;   reload   reload (no cache)
//   size <w> <h>              viewport size
//   stop                      shut down Chrome and the harness
//
//   node ui/dev/harness.mjs mcp   MCP server (stdio) exposing all of the above as ui_* tools; every action
//                                 returns its result, the new log lines and what changed in app state.
//                                 Starts the harness itself if it isn't running.
//
// No dependencies: Node 22's global WebSocket + Chrome DevTools Protocol.

import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "..", "data", "harness");
const CTRL = +(process.env.HARNESS_PORT || 4749);
const CDP_PORT = +(process.env.HARNESS_CDP_PORT || 9333);
const APP = process.env.APP_URL || `http://localhost:${process.env.PORT || 4747}/`;
const CHROME = process.env.CHROME || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
].find((p) => fs.existsSync(p));

const [cmd = "help", ...args] = process.argv.slice(2);
if (cmd === "serve") serve();
else if (cmd === "mcp") import("./harness-mcp.mjs").then((m) => m.main({ CTRL, harnessFile: fileURLToPath(import.meta.url) }));
else if (cmd === "help" || cmd === "-h") console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 36).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
else client();

// ============================== client ==============================

function client() {
  const body = JSON.stringify({ cmd, args });
  const req = http.request({ host: "127.0.0.1", port: CTRL, method: "POST", path: "/", headers: { "Content-Type": "application/json" } }, (res) => {
    let out = ""; res.on("data", (d) => (out += d));
    res.on("end", () => { process.stdout.write(out.endsWith("\n") ? out : out + "\n"); process.exit(res.statusCode === 200 ? 0 : 1); });
  });
  req.on("error", () => { console.error(`Harness not running. Start it with: node ui/dev/harness.mjs serve`); process.exit(2); });
  req.end(body);
}

// ============================== server ==============================

async function serve() {
  if (!CHROME) throw new Error("Chrome not found; set CHROME=/path/to/chrome");
  fs.mkdirSync(DATA, { recursive: true });
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(DATA, CDP_PORT === 9333 ? "profile" : `profile-${CDP_PORT}`)}`,
    "--window-size=1200,1000", APP,
  ], { stdio: "ignore" });
  chrome.on("exit", (c) => { console.log(`chrome exited (${c})`); process.exit(1); });
  const shutdown = () => { chrome.kill(); process.exit(0); };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);

  // find the page target
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === "page"); }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  if (!target) throw new Error("could not reach Chrome DevTools");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0, dragData = null; const pending = new Map();
  const logs = [];
  const log = (kind, text) => { logs.push(`[${new Date().toISOString().slice(11, 19)}] ${kind}: ${text}`); if (logs.length > 500) logs.shift(); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); return; }
    if (m.method === "Runtime.consoleAPICalled") {
      const text = m.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ");
      if (!text.startsWith("[hw] ")) log(m.params.type, text); // [hw] events arrive via the server log
    }
    else if (m.method === "Input.dragIntercepted") dragData = m.params.data;
    else if (m.method === "Runtime.exceptionThrown") { const d = m.params.exceptionDetails; log("EXCEPTION", (d.exception?.description || d.text) + (d.url ? ` @ ${d.url}:${d.lineNumber + 1}` : "")); }
    else if (m.method === "Log.entryAdded") log(`log.${m.params.entry.level}`, `${m.params.entry.text}${m.params.entry.url ? " " + m.params.entry.url : ""}`);
    else if (m.method === "Network.responseReceived" && m.params.response.status >= 400) log("HTTP " + m.params.response.status, m.params.response.url);
    else if (m.method === "Network.loadingFailed" && !m.params.canceled) log("NETFAIL", `${m.params.errorText} ${m.params.requestId}`);
    else if (m.method === "Page.frameNavigated" && !m.params.frame.parentId) log("nav", m.params.frame.url);
  };
  ws.onclose = () => { console.log("devtools connection closed"); shutdown(); };
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  for (const d of ["Runtime", "Log", "Page", "Network", "DOM"]) await send(`${d}.enable`);
  await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 1000, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const J = (x) => JSON.stringify(x);
  // Resolve "text:Label" or a CSS selector to the first visible matching element.
  const findEl = (sel) => `(() => {
    const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length) && !e.closest('[hidden]');
    const s = ${J(sel)};
    if (s.startsWith('text:')) {
      const t = s.slice(5).trim().toLowerCase();
      const cand = [...document.querySelectorAll('button,a,summary,label,[data-act],li,option')].filter(vis);
      return cand.find((e) => e.innerText.trim().toLowerCase() === t) || cand.find((e) => e.innerText.trim().toLowerCase().includes(t));
    }
    return [...document.querySelectorAll(s)].find(vis) || document.querySelector(s);
  })()`;

  // center of an element in viewport coordinates (scrolled into view first)
  const center = async (sel) => {
    const r = await evaluate(`(() => { const e = ${findEl(sel)}; if (!e) return null; e.scrollIntoView({block:'center', inline:'center'}); const b = e.getBoundingClientRect(); return {x:b.x+b.width/2, y:b.y+b.height/2, w:b.width, h:b.height, d: e.tagName.toLowerCase() + ' "' + (e.innerText||'').trim().slice(0,40) + '"'}; })()`);
    if (!r) throw new Error("no element for " + sel);
    if (!r.w && !r.h) throw new Error(sel + " is not visible");
    return r;
  };
  const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
  const KEYS = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, " ": 32 };
  const MODS = { Alt: 1, Ctrl: 2, Control: 2, Meta: 4, Cmd: 4, Shift: 8 };
  const serverLogCursor = { seq: null };
  const fmtEvent = (e) => {
    const { seq: _s, ts, src, event, ...rest } = e;
    const kv = Object.entries(rest).filter(([, v]) => v !== undefined).map(([k, v]) => { const t = typeof v === "string" ? v : JSON.stringify(v); return `${k}=${t.length > 200 ? t.slice(0, 200) + "…" : t}`; }).join(" ");
    return `[${ts.slice(11, 19)}] ${src}: ${event}${kv ? " " + kv : ""}`;
  };
  const serverLogs = async () => {
    try {
      const r = await (await fetch(new URL(`/api/logs?since=${serverLogCursor.seq ?? 0}`, APP))).json();
      const first = serverLogCursor.seq === null; serverLogCursor.seq = r.seq;
      return first ? [] : r.events.map((e) => ({ ts: e.ts, line: fmtEvent(e) })); // first call only sets the cursor
    } catch (e) { return [{ ts: new Date().toISOString(), line: `[--:--:--] harness: could not read the app log (${e.message})` }]; }
  };
  await serverLogs();

  const commands = {
    async state() {
      return evaluate(`(() => {
        const h = window.__hw;
        const base = { url: location.href, title: document.title, next: document.querySelector('#next')?.textContent };
        return h ? { ...base, ...h.summary() } : { ...base, note: 'window.__hw not found (app not loaded?)' };
      })()`);
    },
    async outline() {
      return evaluate(`(() => {
        const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length) && !e.closest('[hidden]');
        const sel = (e) => e.id ? '#' + e.id : (e.closest('[id]') ? '#' + e.closest('[id]').id + ' ' : '') + e.tagName.toLowerCase() + (e.classList.length ? '.' + [...e.classList].join('.') : '') + (e.dataset.act ? '[data-act=' + e.dataset.act + ']' : '');
        const out = [];
        const walk = (e, depth, quiet) => {
          if (!vis(e)) return;
          const tag = e.tagName;
          const text = (e.innerText || '').trim().replace(/\\s+/g, ' ');
          if (/^H[1-3]$/.test(tag)) out.push('  '.repeat(depth) + '# ' + text);
          else if (['BUTTON', 'SUMMARY'].includes(tag) || e.dataset.act) out.push('  '.repeat(depth) + '[' + (e.disabled ? 'disabled ' : '') + tag.toLowerCase() + '] "' + text.slice(0, 60) + '"  → ' + sel(e));
          else if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) out.push('  '.repeat(depth) + '[' + tag.toLowerCase() + (e.type === 'checkbox' ? ' ' + (e.checked ? 'x' : ' ') : '') + '] ' + J(String(e.value).slice(0, 80)) + (e.placeholder ? ' (placeholder: ' + e.placeholder.slice(0, 40) + ')' : '') + '  → ' + sel(e));
          else if (!quiet && (['P', 'LI', 'PRE'].includes(tag) || (['DIV', 'SPAN', 'LABEL'].includes(tag) && ![...e.children].some((c) => !['B', 'I', 'EM', 'STRONG', 'CODE', 'SPAN', 'SMALL', 'A'].includes(c.tagName)))) && text) {
            out.push('  '.repeat(depth) + (tag === 'LI' ? '- ' : '') + text.slice(0, 160)); quiet = true; // print the block once; still list controls inside it
          }
          if (['SELECT', 'BUTTON'].includes(tag)) return;
          if (tag === 'DETAILS' && !e.open) { const s = e.querySelector('summary'); if (s) walk(s, depth); return; }
          for (const c of e.children) walk(c, depth + (e.matches('section,aside,.widget,details') ? 1 : 0), quiet);
        };
        const J = JSON.stringify;
        walk(document.body, 0);
        return out.join('\\n');
      })()`);
    },
    async shot(...a) {
      const full = a.includes("--full"); const target = a.find((x) => x !== "--full");
      let clip;
      if (target) {
        const r = await evaluate(`(() => { const e = ${findEl(target)}; if (!e) return null; e.scrollIntoView({block:'center'}); const b = e.getBoundingClientRect(); return {x:b.x+scrollX, y:b.y+scrollY, width:b.width, height:b.height}; })()`);
        if (!r) throw new Error("no element for " + target);
        if (!r.width || !r.height) throw new Error(`${target} is not visible right now (hidden or inside a collapsed step); try "outline"`);
        clip = { ...r, scale: 1 };
      }
      const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full || !!clip, ...(clip ? { clip } : {}) });
      const file = path.join(DATA, `shot-${Date.now()}.png`);
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      // keep the last 20
      fs.readdirSync(DATA).filter((f) => f.startsWith("shot-")).sort().slice(0, -20).forEach((f) => fs.unlinkSync(path.join(DATA, f)));
      return file;
    },
    // A real (trusted) mouse click at the element's center, so pointer handlers and :active fire like a
    // person's click. Elements with no box (e.g. a hidden checkbox) get element.click() instead.
    async click(sel) {
      const r = await evaluate(`(() => { const e = ${findEl(sel)}; if (!e) return null; e.scrollIntoView({block:'center', inline:'center'}); const b = e.getBoundingClientRect();
        const x = b.x + b.width / 2, y = b.y + b.height / 2, hit = document.elementFromPoint(x, y);
        return { x, y, w: b.width, h: b.height, covered: !!hit && hit !== e && !e.contains(hit) && !hit.contains(e), d: e.tagName.toLowerCase() + ' "' + (e.innerText||'').trim().slice(0,50) + '"' }; })()`);
      if (!r) throw new Error("not found: " + sel);
      if (!r.w || !r.h || r.covered) {
        await evaluate(`(() => { ${findEl(sel)}.click(); })()`);
        await settle(); return `clicked ${r.d}${r.covered ? " (covered by another element; used element.click())" : ""}`;
      }
      // no separate mouseMoved: its ack can stall ~5 s in headless Chrome after a large SVG dialog closes
      await mouse("mousePressed", r.x, r.y);
      await mouse("mouseReleased", r.x, r.y);
      await settle(); return `clicked ${r.d}`;
    },
    async type(sel, ...text) {
      const r = await evaluate(`(() => { const e = ${findEl(sel)}; if (!e) return 'not found'; e.focus(); e.value = ${J(text.join(" "))}; e.dispatchEvent(new Event('input', {bubbles:true})); e.blur(); return 'ok'; })()`);
      await settle(); return r;
    },
    async select(sel, value) {
      const r = await evaluate(`(() => { const e = ${findEl(sel)}; if (!e) return 'not found'; e.value = ${J(value)}; e.dispatchEvent(new Event('change', {bubbles:true})); return 'ok'; })()`);
      await settle(); return r;
    },
    async eval(...code) {
      const src = code.join(" ");
      // expression first; if that's a syntax error, run as statements (use `return x` to get a value back)
      const v = await evaluate(`(async () => { return (${src}); })()`).catch((e) => /SyntaxError/.test(e.message) ? evaluate(`(async () => { ${src} })()`) : Promise.reject(e));
      return v === undefined ? "(undefined; in statement mode, use return)" : v;
    },
    async ping() { return "pong"; },
    async logs() {
      // send the page's queued UI events now (its 250 ms batch timer is throttled to ~1 s in headless Chrome)
      await evaluate("window.__hw?.flushLog?.()").catch(() => {});
      await settle(100);
      const today = new Date().toISOString().slice(0, 11);
      const browser = logs.splice(0).map((l) => ({ ts: today + l.slice(1, 9), line: l.replace("] ", "] browser ") }));
      const all = [...(await serverLogs()), ...browser].sort((a, b) => a.ts.localeCompare(b.ts));
      return all.length ? all.map((x) => x.line).join("\n") : "(no new logs)";
    },
    async key(combo, sel) {
      if (sel) await evaluate(`(() => { const e = ${findEl(sel)}; if (!e) throw new Error('no element for ' + ${J(sel)}); e.focus(); })()`);
      const parts = combo.split("+"); const key = parts.pop() || "+";
      const modifiers = parts.reduce((m, p) => m | (MODS[p] || 0), 0);
      const code = KEYS[key] ?? key.toUpperCase().charCodeAt(0);
      const text = key === "Enter" ? "\r" : key.length === 1 && !(modifiers & 6) ? key : undefined;
      const base = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers };
      await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text, unmodifiedText: text } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      await settle(); return `pressed ${combo}${sel ? " in " + sel : ""}`;
    },
    async hover(sel) { const a = await center(sel); await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x, y: a.y }); await settle(); return "hovering " + a.d; },
    async drag(from, to) {
      const a = await center(from);
      const off = /^-?\d+,-?\d+$/.test(to || "") ? to.split(",").map(Number) : null;
      dragData = null;
      await send("Input.setInterceptDrags", { enabled: true });
      try {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x, y: a.y });
        await mouse("mousePressed", a.x, a.y);
        const b = off ? { x: a.x + off[0], y: a.y + off[1], d: `offset ${to}` } : await center(to);
        // once Chrome hands us an HTML5 drag, further mouse events block until it ends, so stop moving
        for (let i = 1; i <= 8 && !dragData; i++) { await Promise.race([mouse("mouseMoved", a.x + ((b.x - a.x) * i) / 8, a.y + ((b.y - a.y) * i) / 8), settle(1500)]); await settle(20); }
        if (dragData) { // HTML5 drag-and-drop: deliver the intercepted drag to the target
          for (const type of ["dragEnter", "dragOver", "drop"]) await send("Input.dispatchDragEvent", { type, x: b.x, y: b.y, data: dragData });
        }
        await Promise.race([mouse("mouseReleased", b.x, b.y), settle(1500)]);
        await settle(); return `dragged ${a.d} → ${b.d}${dragData ? " (html5 drop)" : ""}`;
      } finally { await send("Input.setInterceptDrags", { enabled: false }); }
    },
    async wheel(sel, dy = "-300") {
      const a = await center(sel);
      // CDP waits for the compositor to ack a wheel event, which a headless page may never do: fall back to a DOM WheelEvent
      const ok = await Promise.race([send("Input.dispatchMouseEvent", { type: "mouseWheel", x: a.x, y: a.y, deltaX: 0, deltaY: +dy }).then(() => true), settle(3000).then(() => false)]);
      if (!ok) await evaluate(`(() => { const e = document.elementFromPoint(${a.x}, ${a.y}); e.dispatchEvent(new WheelEvent("wheel", { deltaY: ${+dy}, clientX: ${a.x}, clientY: ${a.y}, bubbles: true, cancelable: true })); })()`);
      await settle(); return `wheel ${dy} over ${a.d}${ok ? "" : " (DOM event)"}`;
    },
    async upload(sel, ...files) {
      const abs = files.map((f) => path.resolve(f));
      for (const f of abs) if (!fs.existsSync(f)) throw new Error("no such file " + f);
      const { root } = await send("DOM.getDocument", { depth: 0 });
      const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: sel.includes("input") ? sel : `${sel} input[type=file]` });
      if (!nodeId) throw new Error("no file input for " + sel);
      await send("DOM.setFileInputFiles", { nodeId, files: abs });
      await settle(800); return `chose ${abs.map((f) => path.basename(f)).join(", ")}`;
    },
    async wait(what = "1000", timeout = "120000") {
      if (/^\d+$/.test(what)) { await settle(+what); return `waited ${what}ms`; }
      const t0 = Date.now();
      while (Date.now() - t0 < +timeout) {
        if (await evaluate(`(async () => { try { return !!(${what}); } catch { return false; } })()`)) return `true after ${Date.now() - t0}ms`;
        await settle(500);
      }
      throw new Error(`timed out after ${timeout}ms waiting for ${what}`);
    },
    async goto(u = "") {
      const url = /^https?:/.test(u) ? u : u.startsWith("#") ? APP.replace(/\/$/, "/") + u : new URL(u || "/", APP).href;
      await send("Page.navigate", { url }); await settle(1200); return "at " + url;
    },
    async reload() { await send("Page.reload", { ignoreCache: true }); await settle(1200); return "reloaded"; },
    async size(w, h) { await send("Emulation.setDeviceMetricsOverride", { width: +w, height: +h, deviceScaleFactor: 1, mobile: false }); return `viewport ${w}x${h}`; },
    async stop() { setTimeout(shutdown, 100); return "stopping"; },
  };

  http.createServer((req, res) => {
    let body = ""; req.on("data", (d) => (body += d));
    req.on("end", async () => {
      try {
        const { cmd, args = [] } = JSON.parse(body || "{}");
        if (!commands[cmd]) throw new Error(`unknown command "${cmd}". Try: ${Object.keys(commands).join(", ")}`);
        const out = await commands[cmd](...args);
        res.writeHead(200).end(typeof out === "string" ? out : JSON.stringify(out, null, 2));
      } catch (e) { res.writeHead(500).end("error: " + e.message); }
    });
  }).listen(CTRL, "127.0.0.1", () => console.log(`harness ready: control on :${CTRL}, Chrome devtools on :${CDP_PORT}, app ${APP}`));
}
