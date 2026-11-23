// Logs every user interaction through log() (console + server event log), using delegated capture-phase
// listeners so no view module has to remember to do it: clicks, changes, typing (debounced), keys,
// drags (pointer and HTML5), wheel zoom, file picks, dialogs opening/closing, and uncaught errors.
import { log } from "./lib.js";

// A short, stable description of an element: its id, or nearest-id ancestor + tag/classes/data-* + text.
export function describe(el) {
  if (!el || el.nodeType !== 1) return String(el);
  const data = Object.entries(el.dataset || {}).filter(([k]) => k !== "tip").map(([k, v]) => `[data-${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}=${v}]`).join("");
  const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
  const own = el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}${cls}${data}`;
  const anc = el.id ? null : el.parentElement?.closest("[id]");
  const text = (el.innerText ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
  return `${anc ? "#" + anc.id + " " : ""}${own}${text && !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) ? ` "${text}"` : ""}`;
}

// The element a click "means": the nearest control rather than the span/svg path inside it.
const target = (e) => e.target.closest?.("button,a,summary,label,input,select,textarea,[data-act],[data-open],[data-page],[data-set],[data-id],[data-key],[data-tab],li,.tchip,.node") || e.target;
const val = (el) => (el.type === "checkbox" || el.type === "radio" ? el.checked : el.type === "password" ? "•••" : String(el.value ?? "")).toString().slice(0, 120);

// debounced events (typing, zoom) waiting for their pause; flushPending() emits them now
const pending = new Map();
const later = (key, ms, fn) => { clearTimeout(pending.get(key)?.t); pending.set(key, { fn, t: setTimeout(() => { pending.delete(key); fn(); }, ms) }); };
export function flushPending() { for (const [k, { t, fn }] of pending) { clearTimeout(t); pending.delete(k); fn(); } }

export function initUiLog() {
  document.addEventListener("click", (e) => log("click", { el: describe(target(e)), ...(e.metaKey || e.ctrlKey || e.shiftKey ? { mods: [e.metaKey && "meta", e.ctrlKey && "ctrl", e.shiftKey && "shift"].filter(Boolean).join("+") } : {}) }), true);

  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el.type === "file") log("files", { el: describe(el), files: [...el.files].map((f) => `${f.name} (${f.size} B)`) });
    else log("change", { el: describe(el), value: val(el) });
  }, true);

  // typing: one event per field after a pause, with the final value
  document.addEventListener("input", (e) => {
    const el = e.target; if (!el.matches?.("input,textarea,[contenteditable]")) return;
    later(el, 700, () => log("input", { el: describe(el), value: val(el), chars: String(el.value ?? "").length }));
  }, true);

  document.addEventListener("keydown", (e) => {
    const special = /^(Enter|Escape|Tab|Backspace|Delete|Arrow\w+|Home|End|PageUp|PageDown)$/.test(e.key);
    if (!special && !e.metaKey && !e.ctrlKey) return;
    // plain Backspace/arrows while editing text are just typing
    const editing = e.target.matches?.("input,textarea") && !e.metaKey && !e.ctrlKey;
    if (editing && /^(Backspace|Delete|ArrowLeft|ArrowRight|Home|End)$/.test(e.key) && e.target.value) return;
    log("key", { key: [e.metaKey && "Meta", e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.key].filter(Boolean).join("+"), el: describe(e.target) });
  }, true);

  // pointer drags (DAG pan, chip reorder) — logged once on release if the pointer moved
  let down = null;
  document.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, el: describe(target(e)) }; }, true);
  document.addEventListener("pointerup", (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) log("drag", { from: down.el, dx: Math.round(e.clientX - down.x), dy: Math.round(e.clientY - down.y) });
    down = null;
  }, true);
  document.addEventListener("dragstart", (e) => log("dragstart", { el: describe(target(e)) }), true);
  document.addEventListener("drop", (e) => log("drop", { on: describe(target(e)), files: [...(e.dataTransfer?.files || [])].map((f) => f.name) }), true);

  let wheelSum = 0;
  document.addEventListener("wheel", (e) => {
    const svg = e.target.closest?.("svg"); if (!svg) return; // only the zoomable map; ordinary scrolling isn't an action
    wheelSum += e.deltaY;
    later("wheel", 300, () => { log("zoom", { el: describe(svg), deltaY: Math.round(wheelSum) }); wheelSum = 0; });
  }, { capture: true, passive: true });

  // dialogs: watch the open attribute (covers showModal, close, Esc, backdrop clicks, form method=dialog)
  const mo = new MutationObserver((ms) => { for (const m of ms) log(m.target.open ? "dialog-open" : "dialog-close", { id: m.target.id }); });
  for (const d of document.querySelectorAll("dialog")) mo.observe(d, { attributes: true, attributeFilter: ["open"] });

  for (const d of document.querySelectorAll("details")) d.addEventListener("toggle", () => log("toggle", { el: describe(d.querySelector("summary") || d), open: d.open }));

  addEventListener("error", (e) => log("error", { message: e.message, at: `${e.filename}:${e.lineno}:${e.colno}`, stack: String(e.error?.stack || "").slice(0, 600) }));
  addEventListener("unhandledrejection", (e) => log("error", { message: String(e.reason?.message || e.reason), stack: String(e.reason?.stack || "").slice(0, 600) }));
  log("page-load", { url: location.href, viewport: `${innerWidth}x${innerHeight}` });
}
