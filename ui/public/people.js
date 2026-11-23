// Students and Courses (the two tabs above the per-course ones).
//   Students: every student × course enrollment, which one the app is working on (Switch reloads the app on
//   it: the root weekly_status.md and curriculum_ladder.md follow), adding a student, upgrading an
//   enrollment to a newer published version of its course.
//   Courses: the course's versions, the open draft (what changed against its parent, removed nodes that
//   still need merge/split/retire, Publish/Discard), and how many problems wait for retagging.
// Data: GET /api/students, /api/versions (lib/curriculum.mjs, lib/progress.mjs on the server).
import { $, esc, api, log } from "./lib.js";
import { onShow } from "./pages.js";

const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) : "");
const note = (el, msg, bad = false) => { el.textContent = msg; el.className = `small ${bad ? "err" : "muted"}`; };

// ---------- Students ----------

async function openStudents() {
  const el = $("#p-students");
  el.innerHTML = `<div class="view people"><h2 class="v-title">Students</h2><p class="muted">Loading…</p></div>`;
  let d, v;
  try { [d, v] = await Promise.all([api("/api/students"), api("/api/versions")]); } catch (e) { el.querySelector("p").textContent = e.message; return; }
  const latest = Math.max(...v.versions.filter((x) => x.status === "published").map((x) => x.seq));
  const latestId = v.versions.find((x) => x.seq === latest)?.id;
  const rows = d.enrollments.map((e) => {
    const on = e.id === d.active;
    const behind = e.curriculum_id === v.curriculum.id && e.version_seq < latest;
    return `<tr class="${on ? "on" : ""}">
      <td>${esc(e.student_name)}</td><td>${esc(e.curriculum_title)}</td>
      <td>v${e.version_seq}${behind && on ? ` <button class="small-btn" data-upgrade="${e.id}" title="Carry this student's progress forward to v${latest} (merged nodes take the least advanced state; split nodes become partial and are flagged)">Upgrade to v${latest}</button>` : behind ? ` <span class="muted small">v${latest} available</span>` : ""}</td>
      <td>${on ? `<span class="pill-on">Working on</span>` : `<button class="small-btn" data-switch="${e.id}">Switch</button>`}</td></tr>`;
  }).join("");
  el.innerHTML = `<div class="view people">
    <h2 class="v-title">Students</h2>
    <p class="muted">Each student has their own progress map, weekly status and homework history in each course. The tabs below this one work on the student marked <em>Working on</em>.</p>
    <table class="ptable"><thead><tr><th>Student</th><th>Course</th><th>Version</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <form class="add-student"><input name="name" placeholder="New student's name" autocomplete="off" /> <button class="small-btn" type="submit">Add student</button> <span class="small muted" id="st-msg"></span></form>
    <p class="small muted">A new student starts in ${esc(v.curriculum.title)} at its latest published version, with a blank weekly status.</p>
  </div>`;
  const msg = $("#st-msg", el);
  el.querySelector("form").onsubmit = async (ev) => {
    ev.preventDefault();
    const name = ev.target.name.value.trim(); if (!name) return;
    try { await api("/api/students", { method: "POST", body: { name } }); log("student-add", {}); openStudents(); } catch (e) { note(msg, e.message, true); }
  };
  el.onclick = async (ev) => {
    const sw = ev.target.closest("[data-switch]"), up = ev.target.closest("[data-upgrade]");
    try {
      if (sw) { await api("/api/enrollment", { method: "PUT", body: { id: Number(sw.dataset.switch) } }); log("enrollment-switch", { id: sw.dataset.switch }); location.reload(); }
      if (up) {
        const r = await api("/api/enrollment/upgrade", { method: "POST", body: { to: latestId } });
        log("enrollment-upgrade", { to: latest, written: r.written });
        note(msg, `Upgraded to v${latest}: ${r.written} node${r.written === 1 ? "" : "s"} took progress from merged or split ones.`);
        setTimeout(() => location.reload(), 900);
      }
    } catch (e) { note(msg, e.message, true); }
  };
}

// ---------- Courses ----------

function diffHtml(df, unresolved) {
  if (!df) return "";
  const li = (xs, f) => (xs.length ? `<ul>${xs.map((x) => `<li>${f(x)}</li>`).join("")}</ul>` : "");
  const node = (n) => `<code>${esc(n.key)}</code> ${esc(n.title)} <span class="muted small">${esc(n.layer)}</span>`;
  const lin = new Map(); for (const l of df.lineage) { if (!lin.has(l.old_key)) lin.set(l.old_key, []); lin.get(l.old_key).push(l); }
  const removed = df.removed.map((n) => {
    const l = lin.get(n.key);
    if (l) return `${node(n)} → ${l[0].relation === "retired" ? "retired" : `${l[0].relation} into ${l.map((x) => `<code>${esc(x.new_key)}</code>`).join(", ")}`}`;
    return `${node(n)} <span class="err small">needs a decision</span>
      <span class="lin" data-key="${esc(n.key)}"><button class="small-btn" data-lin="retired">Retire</button>
      <input placeholder="merge/split into: key, key" /> <button class="small-btn" data-lin="into">Set</button></span>`;
  });
  const edges = (xs) => xs.map((e) => `${esc(e.kind)} <code>${esc(e.from)}</code> → <code>${esc(e.to)}</code>`);
  const parts = [
    df.added.length && `<h4>Added (${df.added.length})</h4>${li(df.added, node)}`,
    df.removed.length && `<h4>Removed (${df.removed.length})</h4><ul>${removed.map((x) => `<li>${x}</li>`).join("")}</ul>`,
    df.changed.length && `<h4>Changed (${df.changed.length})</h4>${li(df.changed, (c) => `${node(c)} <span class="muted small">${esc(c.fields.join(", "))}</span>`)}`,
    (df.edgesAdded.length || df.edgesRemoved.length) && `<h4>Links</h4>${li([...edges(df.edgesAdded).map((x) => `+ ${x}`), ...edges(df.edgesRemoved).map((x) => `− ${x}`)], (x) => x)}`,
    (df.planTextChanged || df.gatedChanged || df.unitOrderChanged) && `<h4>Lesson plan</h4><p class="small">${[df.unitOrderChanged && "units reordered", df.planTextChanged && "preamble text changed", df.gatedChanged && "gated terms changed"].filter(Boolean).join("; ")}</p>`,
  ].filter(Boolean);
  return parts.length ? parts.join("") : `<p class="muted small">No changes against the version it was made from yet.</p>`;
}

async function openCourses() {
  const el = $("#p-courses");
  el.innerHTML = `<div class="view people"><h2 class="v-title">Courses</h2><p class="muted">Loading…</p></div>`;
  let v;
  try { v = await api("/api/versions"); } catch (e) { el.querySelector("p").textContent = e.message; return; }
  const enrolledAt = (id) => v.enrollments.filter((e) => e.version_id === id).map((e) => esc(e.student_name)).join(", ");
  const rows = [...v.versions].reverse().map((x) => `<tr class="${x.id === v.enrolled ? "on" : ""}">
    <td>v${x.seq}</td><td>${x.status === "draft" ? `<span class="pill-draft">draft</span>` : "published"}</td><td>${esc(x.origin)}</td>
    <td>${esc(x.note || "")}</td><td>${fmt(x.published_at || x.created_at)}</td><td>${enrolledAt(x.id)}</td></tr>`).join("");
  const dr = v.draft;
  el.innerHTML = `<div class="view people">
    <h2 class="v-title">${esc(v.curriculum.title)}</h2>
    <p class="muted">A course's content DAG, methods DAG and lesson plan are versioned together. Published versions never change; edits, whiteboard re-imports (<code>node ui/scripts/import-dag.mjs</code>) and hand edits of <code>curriculum_ladder.md</code> collect in one draft until you publish it. Each student stays on their version until you upgrade them on the Students tab.</p>
    <table class="ptable"><thead><tr><th>Version</th><th>Status</th><th>From</th><th>Note</th><th>Date</th><th>Students</th></tr></thead><tbody>${rows}</tbody></table>
    ${dr ? `<section class="draft"><h3>Draft v${dr.seq}${dr.note ? ` <span class="muted small">${esc(dr.note)}</span>` : ""}</h3>
      ${diffHtml(dr.diff, dr.unresolved)}
      <p><button class="small-btn" id="v-publish" ${dr.unresolved.length ? "disabled" : ""}>Publish v${dr.seq}</button>
         <button class="small-btn" id="v-discard">Discard draft</button> <span class="small muted" id="v-msg">${dr.unresolved.length ? `Say what happened to ${dr.unresolved.length} removed node${dr.unresolved.length === 1 ? "" : "s"} first.` : ""}</span></p></section>`
      : `<p class="small muted">No draft open.</p>`}
    <p class="small muted">${v.retag ? `${v.retag} problem${v.retag === 1 ? "" : "s"} had tags that were split or retired and wait for retagging: <code>node ui/scripts/tag-corpus.mjs</code> (or Save &amp; finish tags them in the background).` : "No problems wait for retagging."}</p>
  </div>`;
  if (!dr) return;
  const msg = $("#v-msg", el);
  el.onclick = async (ev) => {
    const b = ev.target.closest("button"); if (!b) return;
    try {
      if (b.id === "v-publish") {
        const r = await api(`/api/versions/${dr.id}/publish`, { method: "POST", body: {} });
        log("version-publish", { seq: r.version.seq, lineageTags: r.lineageTags, queued: r.queued });
        note(msg, `Published v${r.version.seq}: ${r.lineageTags} tag${r.lineageTags === 1 ? "" : "s"} carried forward, ${r.queued} queued for retagging.`);
        setTimeout(openCourses, 900);
      } else if (b.id === "v-discard") {
        await api(`/api/versions/${dr.id}`, { method: "DELETE" }); log("version-discard", { seq: dr.seq }); openCourses();
      } else if (b.dataset.lin) {
        const span = b.closest(".lin"), key = span.dataset.key;
        const into = b.dataset.lin === "retired" ? [] : span.querySelector("input").value.split(/[\s,]+/).filter(Boolean);
        if (b.dataset.lin === "into" && !into.length) return note(msg, "Type the key(s) it became, e.g. e33 or e26, c:ab12cd.", true);
        const relation = !into.length ? "retired" : into.length > 1 ? "split" : "merged";
        await api("/api/versions/draft", { method: "POST", body: { ops: [{ op: "lineage", key, relation, into }] } });
        log("version-lineage", { key, relation });
        openCourses();
      }
    } catch (e) { note(msg, e.message, true); }
  };
}

onShow("students", openStudents);
onShow("courses", openCourses);
