// Sidebar tabs: one <section class="page" id="p-NAME"> per tab, one [data-page=NAME] button each.
// showPage hides the others, marks the button, remembers the tab for this browser tab, and runs the
// page's on-show hook (registered by main.js so this module imports nothing from the views).
import { $$, log } from "./lib.js";

const KEY = "hw.page";
const hooks = {};
export const pages = { current: null };

export const onShow = (name, fn) => { hooks[name] = fn; };
export const isShown = (name) => pages.current === name;

export function showPage(name) {
  if (!document.getElementById(`p-${name}`)) name = "create";
  const from = pages.current;
  for (const p of $$(".page")) p.hidden = p.id !== `p-${name}`;
  for (const b of $$("[data-page]")) {
    const on = b.dataset.page === name;
    b.classList.toggle("on", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  pages.current = name;
  try { sessionStorage.setItem(KEY, name); } catch {}
  if (from && from !== name) log("page", { from, to: name });
  hooks[name]?.();
}

export function initPages() {
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-page]"); if (b) showPage(b.dataset.page); });
  let saved = null; try { saved = sessionStorage.getItem(KEY); } catch {}
  showPage(saved || "create");
}
