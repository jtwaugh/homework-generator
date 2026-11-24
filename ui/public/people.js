// Students and Courses (the two tabs above the per-course ones).
//   Students: each student with every course, whether they're taking it now, which one the app is working on
//   (Work on this reloads the app on it; the root curriculum_ladder.md follows), adding a student, upgrading
//   an enrollment to a newer published version of its course.
//   Courses: the course's versions, the open draft (what changed against its parent, removed nodes that
//   still need merge/split/retire, Publish/Discard), and how many problems wait for retagging.
// Data: GET /api/students, /api/versions (lib/curriculum.mjs, lib/progress.mjs on the server).
import { $, S, esc, api, log, withCur } from "./lib.js";
import { onShow, showPage } from "./pages.js";

const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) : "");
const note = (el, msg, bad = false) => { el.textContent = msg; el.className = `small ${bad ? "err" : "muted"}`; };

// ---------- Students ----------
// Every student is in every course (courses are just skills). Per course the teacher sets whether the student
// is taking it now, and opens it: "Work on this" makes it the app's (enrolling the student at the latest
// published version the first time); a course with only a draft can be looked at on the Progress map.

function courseRow(st, c, d, latestId) {
  const on = c.enrollment?.id === d.active;
  const behind = on && c.enrollment && c.published != null && c.enrollment.version_seq < c.published;
  const version = c.enrollment ? `v${c.enrollment.version_seq}${behind ? ` <button class="small-btn" data-upgrade="${latestId}" title="Carry this student's progress forward to v${c.published} (merged nodes take the least advanced state; split nodes become partial and are flagged)">Upgrade to v${c.published}</button>` : c.published > c.enrollment.version_seq ? ` <span class="muted small">v${c.published} available</span>` : ""}`
    : c.published != null ? `<span class="muted small">not started</span>` : `<span class="pill-draft">draft only</span>`;
  const action = on ? `<span class="pill-on">Working on</span>`
    : c.published != null ? `<button class="small-btn" data-work="${st.id}" data-cur="${esc(c.id)}">Work on this</button>`
    : `<button class="small-btn" data-look="${esc(c.id)}" title="Open its draft on the Progress map. Publish it on Courses to work on it">Look at it</button>`;
  return `<tr class="${on ? "on" : ""}${c.taking ? "" : " not-taking"}">
    <td>${esc(c.title)}</td>
    <td><label class="taking"><input type="checkbox" data-taking="${st.id}" data-cur="${esc(c.id)}" ${c.taking ? "checked" : ""} /> ${c.taking ? "Taking now" : "Not now"}</label></td>
    <td>${version}</td><td>${action}</td></tr>`;
}

async function openStudents() {
  const el = $("#p-students");
  el.innerHTML = `<div class="view people"><h2 class="v-title">Students</h2><p class="muted">Loading…</p></div>`;
  let d, v;
  try { [d, v] = await Promise.all([api("/api/students"), api("/api/versions")]); } catch (e) { el.querySelector("p").textContent = e.message; return; }
  const latestId = v.versions.filter((x) => x.status === "published").sort((a, b) => b.seq - a.seq)[0]?.id;
  const one = d.students.length === 1;
  const block = (st) => {
    const taking = st.courses.filter((c) => c.taking).length;
    return `<section class="student">
      ${one ? "" : `<h3>${esc(st.name)}</h3>`}
      <p class="small muted">${taking ? `Taking ${taking} of ${st.courses.length} courses.` : `Not taking any of the ${st.courses.length} courses right now.`}</p>
      <table class="ptable"><thead><tr><th>Course</th><th>Taking</th><th>Version</th><th></th></tr></thead>
      <tbody>${st.courses.map((c) => courseRow(st, c, d, latestId)).join("")}</tbody></table></section>`;
  };
  el.innerHTML = `<div class="view people">
    <h2 class="v-title">${one ? esc(d.students[0].name) : "Students"}</h2>
    <p class="muted">Every student is in every course. Tick the ones they're taking now. Each course keeps its own progress map, weekly status and homework history for the student; the other tabs work on the one marked <em>Working on</em>.</p>
    ${d.students.map(block).join("")}
    <form class="add-student"><input name="name" placeholder="New student's name" autocomplete="off" /> <button class="small-btn" type="submit">Add student</button> <span class="small muted" id="st-msg"></span></form>
    <p class="small muted">A new student starts out taking ${esc(v.curriculum.title)}, at its latest published version, with a blank weekly status.</p>
  </div>`;
  const msg = $("#st-msg", el);
  el.querySelector("form").onsubmit = async (ev) => {
    ev.preventDefault();
    const name = ev.target.name.value.trim(); if (!name) return;
    try { await api("/api/students", { method: "POST", body: { name } }); log("student-add", {}); openStudents(); } catch (e) { note(msg, e.message, true); }
  };
  el.onchange = async (ev) => {
    const t = ev.target.closest("[data-taking]"); if (!t) return;
    try {
      await api(`/api/students/${t.dataset.taking}/courses/${encodeURIComponent(t.dataset.cur)}`, { method: "PUT", body: { taking: t.checked } });
      log("course-taking", { curriculum: t.dataset.cur, taking: t.checked });
      openStudents();
    } catch (e) { t.checked = !t.checked; note(msg, e.message, true); }
  };
  el.onclick = async (ev) => {
    const work = ev.target.closest("[data-work]"), look = ev.target.closest("[data-look]"), up = ev.target.closest("[data-upgrade]");
    try {
      if (work) {
        await api("/api/enrollment", { method: "PUT", body: { student: Number(work.dataset.work), curriculum: work.dataset.cur } });
        log("enrollment-switch", { curriculum: work.dataset.cur }); location.reload();
      }
      if (look) { S.browse = look.dataset.look; log("course-look", { curriculum: S.browse }); showPage("dag"); }
      if (up) {
        const r = await api("/api/enrollment/upgrade", { method: "POST", body: { to: Number(up.dataset.upgrade) } });
        log("enrollment-upgrade", { to: up.dataset.upgrade, written: r.written });
        note(msg, `Upgraded: ${r.written} node${r.written === 1 ? "" : "s"} took progress from merged or split ones.`);
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
    (df.scopeSeqTextChanged || df.gatedChanged || df.unitOrderChanged) && `<h4>Scope and Sequence</h4><p class="small">${[df.unitOrderChanged && "units reordered", df.scopeSeqTextChanged && "preamble text changed", df.gatedChanged && "gated terms changed"].filter(Boolean).join("; ")}</p>`,
  ].filter(Boolean);
  return parts.length ? parts.join("") : `<p class="muted small">No changes against the version it was made from yet.</p>`;
}

async function openCourses() {
  const el = $("#p-courses");
  el.innerHTML = `<div class="view people"><h2 class="v-title">Courses</h2><p class="muted">Loading…</p></div>`;
  let v;
  try { v = await api(withCur("/api/versions")); } catch (e) { el.querySelector("p").textContent = e.message; return; }
  const enrolledAt = (id) => v.enrollments.filter((e) => e.version_id === id).map((e) => esc(e.student_name)).join(", ");
  const rows = [...v.versions].reverse().map((x) => `<tr class="${x.id === v.enrolled ? "on" : ""}">
    <td>v${x.seq}</td><td>${x.status === "draft" ? `<span class="pill-draft">draft</span>` : "published"}</td><td>${esc(x.origin)}</td>
    <td>${esc(x.note || "")}</td><td>${fmt(x.published_at || x.created_at)}</td><td>${enrolledAt(x.id)}</td></tr>`).join("");
  const dr = v.draft;
  el.innerHTML = `<div class="view people">
    <h2 class="v-title">${esc(v.curriculum.title)}</h2>
    <p class="muted">A course's content DAG, methods DAG and Scope and Sequence are versioned together. Published versions never change; edits, whiteboard re-imports (<code>node ui/scripts/import-dag.mjs</code>) and hand edits of <code>curriculum_ladder.md</code> collect in one draft until you publish it. Each student stays on their version until you upgrade them on the Students tab.</p>
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
        const r = await api(withCur(`/api/versions/${dr.id}/publish`), { method: "POST", body: {} });
        log("version-publish", { seq: r.version.seq, lineageTags: r.lineageTags, queued: r.queued });
        note(msg, `Published v${r.version.seq}: ${r.lineageTags} tag${r.lineageTags === 1 ? "" : "s"} carried forward, ${r.queued} queued for retagging.`);
        setTimeout(openCourses, 900);
      } else if (b.id === "v-discard") {
        await api(withCur(`/api/versions/${dr.id}`), { method: "DELETE" }); log("version-discard", { seq: dr.seq }); openCourses();
      } else if (b.dataset.lin) {
        const span = b.closest(".lin"), key = span.dataset.key;
        const into = b.dataset.lin === "retired" ? [] : span.querySelector("input").value.split(/[\s,]+/).filter(Boolean);
        if (b.dataset.lin === "into" && !into.length) return note(msg, "Type the key(s) it became, e.g. e33 or e26, c:ab12cd.", true);
        const relation = !into.length ? "retired" : into.length > 1 ? "split" : "merged";
        await api(withCur("/api/versions/draft"), { method: "POST", body: { ops: [{ op: "lineage", key, relation, into }] } });
        log("version-lineage", { key, relation });
        openCourses();
      }
    } catch (e) { note(msg, e.message, true); }
  };
}

onShow("students", openStudents);
onShow("courses", openCourses);
