# Homework generator: local UI

```
node ui/server.mjs
```
Then open http://localhost:4747.

Requires Node 22, an Anthropic API key (`ANTHROPIC_API_KEY`; see the main README), `npm install`, and `brew install tectonic` for PDFs.

The sidebar holds the tabs (below). **Create Homework** is split in two: the conversation with Claude on the left (every tool call shown as a chip, with a cost footer per turn), and the current step's work on the right. The pill in the header always says what to do next.

1. **Set up the week.**
   - The unit card shows the unit you're teaching now. If you're still on it, do nothing. If you moved on, click **We moved on →**: the current unit is marked taught, and you pick the next one from the units the student is now ready for. You can undo this.
   - **show all units** opens the full timeline.
   - **Make a set on Uxx →** (or **Make a set →** next to any unit under **We moved on**) is the one-click path: it marks that unit current, sets the date a week after the last saved set, keeps the rest of last week's input, and has Claude write the finished set in one pass, with no questions and no outline. The reply opens with a **Judgment calls** list; correct any of them in one chat message, or go straight to step 3.
   - To steer the set instead, fill in the date and topics and click **Generate outline**.
   - **Options** is a dropdown: the number of sections, and checkboxes for an answer key, worked examples, a unit circle reference sheet, graph paper and the disclaimer. Rows with a › open a small menu of numbers on hover (or click): how many sections, how many worked examples.
   - Everything autosaves to the student's status record in `ui/data/hw.db`. **Edit status (Markdown)** opens the whole record (unit statuses, review priority, standing conventions, history). Claude never sees this file: the app renders it into the week's brief, which is Claude's whole input.
2. **Review the outline.**
   - If Claude asks questions, answer them or click **Use your defaults**.
   - When it sends the checkpoint, approve it or send changes.
3. **Check and save.**
   - The PDF compiles automatically, with checks for banned or gated words and for lines that run past the margin.
   - If something is flagged, one click asks Claude to fix it.
   - Changes to next week's status are shown as a list. **view MD** shows the diff.
   - **Save & finish** writes the `.tex` into the project folder and updates the status itself: units the week promoted become CURRENT, and Claude's proposed history line, review list and any new standing conventions (a small JSON block in the final) are applied. Every earlier version stays in the status history. The set's problems go into the corpus and are tagged by content and solution method in the background (`tag` lines in the log).

The other tabs, and the header:
- **Students**: every student × course enrollment. **Switch** makes another one the one the app works on (the root `curriculum_ladder.md` follows); add a student; upgrade an enrollment to a newer published version of its course (progress carries over through merges and splits).
- **Courses**: the course's versions, the open draft (what changed against its parent, removed nodes that still need merge / split / retire, **Publish** / **Discard**), and how many problems wait for retagging after a publish.
- **$ badge** (header): what each turn cost on your API account, tokens, searches, tool calls, and an estimated research vs writing split. `HW_BUDGET_USD=2` caps each turn.
- **Progress map**: Wu's school algebra as two DAGs (Content and Methods). **Export status.md** / **Upload status.md** (Scope and Sequence) download the status record or replace it with an edited copy; the root `weekly_status.md` is no longer read or written. Content and Methods can also be exported and imported as Markdown (each node's state), with no Claude involved. **Guess progress** has Claude read every homework file and your uploaded notes and mark each block done / partly / not yet; click a block to see its evidence or override it. The header names the curriculum and its version. All three views are editable in the app: **Edit board** (Content, Methods) or **Edit units** (Scope and Sequence) opens the course's draft, where you add a block or unit, change its title, description and links (uses / sub-steps / rests on, or a unit's needs; a loop is refused), drag a block to move it, or remove it (retired, or merged into another). The forms, pickers and remove step are shared by all three views. Publish the draft on **Courses**. Every block and unit has **comments** (💬 on the node, or in its side panel / row), notes for you that Claude doesn't read. **↺ Edit history** (top right) lists every change to the course, newest first: board and unit edits with before → after, moves, adds, removes, comments, drafts started and published; filter by view, and **show** jumps to the node.
- **Corpus**: every problem Claude can reuse (past homework, problems it saved from research), as a table: click a column to sort, a row to see the whole problem; **Cards** switches to the old view. ★ to prefer, ✕ to never offer again. **💬 Ask Claude** opens a side chat about the corpus ("which U14 problems are unused?", "any near-duplicates?"): Claude reads the whole corpus (Sonnet, `HW_CORPUS_CHAT_MODEL`; a few cents a question) but can't change it, and the problem ids it cites link to the table.
- **History › Sessions**: a searchable list of sessions (one per homework, grouped by date). Each opens read-only in place: the **Conversation** (your inputs and Claude's steps, tool calls, replies and cost) and the **Homework** it produced (PDF / Source / Compile log). Older `.tex` files with no session are listed at the bottom; ← → between sessions. **History › Inference** (also under Progress map) lists every **Guess progress** run with its per-node guesses and reasoning.

Besides web search and fetch, Claude has four local tools (`lib/tools.mjs`, run in process; `mcp/hw-tools.mjs` serves the same tools over MCP for other clients and the tests): `cas` (sympy), `check_answers` (fixed sympy code checks a list of answers, so no model writes verification code), `corpus_search` and `corpus_add`. The app also runs `check_answers` itself on the checks block of every outline and final, and sends wrong answers back once. Install the CAS once: `uv venv ui/data/venv && uv pip install --python ui/data/venv sympy`.

Claude keeps working if you close the tab. Each week is one resumable Claude conversation, stored in `ui/data/weeks/`; a turn in progress is `ui/data/jobs/<id>.turn.json`.

A week's turns are split across models by stage: research on Sonnet, the outline and final on the week's model (Opus by default, so the final reads the outline's prompt cache), compile and lint fixes on Haiku (moving up a tier if a fix fails).

Open `/#new` to skip an unfinished week.

## Settings

All optional, as environment variables.

| Variable | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | the API key every call is billed to |
| `HW_STUDENT` | generic | the first student's name, used when the database is created |
| `HW_CURRICULUM` | the course title | sidebar header |
| `PORT` / `HW_HOST` | 4747 / 127.0.0.1 | listen port and address; any address but localhost needs `HW_PASSWORD_HASH` |
| `HW_PASSWORD_HASH` | none (no login) | require a login; make one with `node ui/scripts/hash-password.mjs` |
| `HW_TRUST_PROXY=1` | off | behind a reverse proxy: per-client login rate limits, `Secure` cookie |
| `HW_BUDGET_USD` | none | stop any one turn at this cost |
| `HW_GOLD_FILES` | 3 | how many recent sets go in every prompt as style examples (~2k tokens each) |
| `HW_MODEL` | `claude-opus-5-5` | the week's model: outline and final |
| `HW_RESEARCH_MODEL`, `HW_WRITE_MODEL`, `HW_FIX_MODEL` | Sonnet, week's model, Haiku | per-stage overrides |
| `HW_SONNET_MODEL`, `HW_HAIKU_MODEL` | 5.5 | the ids behind "Sonnet" and "Haiku" above |
| `HW_STAGES_OFF=research` | none | skip a stage (comma list), e.g. to compare cost |
| `HW_DRY_STAGES=1` | off | log what each stage would do for a message, run nothing |
| `HW_FALLBACKS=0` | on | turn off the API's server-side refusal fallbacks (Opus and Sonnet calls) |
| `HW_GUESS_MODEL` | Sonnet | **Guess progress** |
| `HW_CORPUS_CHAT_MODEL` | Sonnet | the corpus chat |
| `HW_TAG_MODEL` / `HW_NO_TAG=1` | Haiku / off | corpus tagging; turn background tagging off |
| `HW_ROOT` | the repo | folder with the `.tex` sets, `project_instructions.md`, `curriculum_ladder.md` |
| `HW_DATA` | `ui/data` | the app's data folder (`hw.db` and the rest) |
| `HW_ENROLLMENT` | last chosen | work on this enrollment id |
| `HW_TECTONIC` | found on PATH | the Tectonic binary |
| `HW_CAS_URL` | local venv | run `cas` through a remote sympy function instead (hosted: this deployment's `/api/cas`) |
| `HW_LOG_QUIET=1` | off | don't print the event log |
| `HW_SLICE_LOCAL=1`, `HW_SLICE_SOFT_MS`, `HW_SLICE_HARD_MS` | off, 150000, 240000 | slice turns locally as hosting does; slice deadlines |
| hosted only: `HW_WORKFLOW=0`, `HW_BLOB_PREFIX`, `HW_INTERNAL_TOKEN`, `HW_DB_JOURNAL`, `R2_*`, `BLOB_READ_WRITE_TOKEN` | | see the main README's Vercel section |

## What's in ui/data

| Path | What |
|---|---|
| `hw.db` | the database (SQLite, `node:sqlite`): students, enrollments, course versions, progress, corpus, status history, comments, edit history |
| `weeks/` | one file per week: the Claude conversation, the session the History tab shows |
| `jobs/` | turns in progress (so a stopped or hosted turn can resume) |
| `logs/app.jsonl` | the event log |
| `sessions.json` | login sessions (delete it to log everyone out) |
| `curricula/<course>/v<n>/` | each published version, exported (tracked in git) |
| `wu_dag.json`, `wu_methods_dag.json` | the seed DAGs for version 1 (tracked in git) |
| `venv/` | the sympy virtualenv |
| `build/`, `debug/`, `mcp/`, `notes/`, `harness/`, `backups/` | compiles, debug dumps, tool-call logs, uploaded notes, harness screenshots, backups |
| `legacy-v0/` | files from before `hw.db`, moved aside by the one-time migration |

## Where things live

| File | Owns |
|---|---|
| `server.mjs` | HTTP API, the status record read/write and export, the week's turns (stages, slices, `buildSystemPrompt`), compiles, save & finish (`/finish`, `saveManifest`) |
| `lib/agent.mjs` | the agent loop over the Messages API: streaming, tools, budget, deadlines, resume, prices |
| `lib/preflight.mjs` | the week's brief: everything settled from the app's own data before Claude is called |
| `lib/tools.mjs`, `lib/check.mjs` | Claude's local tools; the fixed sympy answer checker |
| `lib/db.mjs`, `lib/store.mjs`, `lib/migrate.mjs` | `hw.db` schema and migrations; the active enrollment and DB-backed corpus; the one-time v0 import |
| `lib/curriculum.mjs`, `lib/scopesequence.mjs` | course versions, drafts, lineage, publish; the Scope and Sequence ↔ `curriculum_ladder.md` |
| `lib/progress.mjs` | students, enrollments, progress events and guess runs |
| `lib/mirror.mjs` | the hosted file mirror to R2 / Vercel Blob |
| `lib/login.mjs`, `lib/auth.mjs` | password login, sessions, rate limits |
| `lib/tagger.mjs` | tags problems with Wu content and methods nodes (one cheap Claude pass), used by Save & finish, seeding and `tag-corpus.mjs` |
| `lib/corpus.mjs` | problem corpus: load/save, search, `splitTex`, `attachTex` (manifest → problem LaTeX) |
| `lib/corpuschat.mjs` | the corpus chat's system prompt (the whole corpus, or an index once it's too big) and cited ids |
| `mcp/hw-tools.mjs` | the MCP tools Claude calls: `cas`, `corpus_search`, `corpus_add` |
| `public/state.js` | app state, phases (`phaseOf`), `send`, polling, `currentFinal`, status autosave |
| `public/statusmd.js` | the status record as Markdown: applying a finished week (`applyWeekUpdate`), reading the final's status-update block, checking uploads |
| `public/lib.js` | shared helpers: `S` (server state), status parsing/writing, `lintTex`, `mathify`, `nextSetDate` |
| `public/work.js` | right pane: units widget and **Make a set** (`quickSet`), setup form, outline view, final checks and save bar |
| `public/chat.js` | left pane: conversation, tool chips, composer |
| `public/topics.js` | topic chips |
| `public/dag.js`, `progressmd.js` | Progress map (all three views, their editors, comments, edit history); board Markdown export/import |
| `public/history.js`, `inference.js`, `corpus.js`, `cost.js` | History › Sessions, Inference, Corpus, the $ dialog |
| `public/people.js`, `pages.js` | Students and Courses tabs; sidebar tab switching |
| `public/uilog.js`, `main.js` | interaction logging; entry point and `window.__hw` |
| `dev/` | harness (headless Chrome + MCP) and sandbox |
| `scripts/` | tests, corpus seeding and tagging, DAG import, `migrate-v1.mjs` (preview the one-time v0 import) |
| `../api/`, `../workflows/`, `../scripts/vercel-build.mjs`, `../deploy/vercel/` | hosting on Vercel (see the main README) |

## Event log

Everything that happens goes to one log, printed by the server as it runs and appended to `ui/data/logs/app.jsonl`:
- `ui`: every click, change, typed value (after a pause), key, drag, zoom, file pick, dialog open/close and phase change in the browser, plus page errors.
- `http`: every API request with status and time.
- `claude`: each run's start, every tool call and result (web search, fetch, CAS, corpus), cost and end.
- `tex` and `dag`: compiles and progress-map guesses.

`GET /api/logs?since=<seq>` returns the same events.

## Tests

```
npm test                          # the four fast suites below
node ui/scripts/test.mjs          # ~50 checks: corpus, .tex split, preflight and brief, routing, status record, board Markdown, login, hw.db versioning/lineage/editors, answer checks (<1 s)
node ui/scripts/test-agent.mjs    # the agent loop against a scripted fake API
node ui/scripts/test-mirror.mjs   # the hosted mirror against an in-memory store
node ui/scripts/test-mcp.mjs      # one call per MCP tool: cas, check_answers, corpus_search, corpus_add (temp data dir)
node ui/scripts/test-ui-mcp.mjs   # the basic workflows (setup, outline, check & save, dialogs) via the harness MCP, on fixed anonymous fixtures (`scripts/fixtures/`) in a sandbox (~10 s); the sandbox and transcript are kept when a step fails, or always with KEEP=1
```
Run `npm test` after any change (a few seconds); run the UI test before a commit or after UI changes. None of them call Claude.
`node ui/scripts/tag-corpus.mjs [--all] [--dry]` tags any corpus problem that has no Wu DAG nodes (Haiku, about $0.002 per 25 problems). It also takes the retag queue a publish leaves; `--all` re-tags every problem from scratch (old tag sets stay in `hw.db`).

`node ui/dev/sandbox.mjs` makes a throwaway copy of the files; run the server on it with `HW_ROOT=<dir>/root HW_DATA=<dir>/data PORT=4757 node ui/server.mjs`.

## Live-debug harness

A persistent headless Chrome pointed at the app, driven from the shell (Node 22, no dependencies):

```
node ui/dev/harness.mjs serve        # leave running (control on :4749)
node ui/dev/harness.mjs state        # phase, week, messages, units, compile/lint status (from window.__hw)
node ui/dev/harness.mjs outline      # visible text + controls, with selectors
node ui/dev/harness.mjs shot [--full] [selector]   # PNG under ui/data/harness/
node ui/dev/harness.mjs click "text:We moved on"   # or a CSS selector
node ui/dev/harness.mjs type "#f-topics" "systems of inequalities"
node ui/dev/harness.mjs eval "__hw.summary().phase"
node ui/dev/harness.mjs key Escape | key Meta+Enter "#composer"
node ui/dev/harness.mjs drag "#f-topics .tchip:nth-child(2)" "#f-topics .tchip:nth-child(1)"   # or an offset "200,0"
node ui/dev/harness.mjs wheel "#dag-dlg .dag-svg" -300 | hover <sel> | upload "#dag-drop" notes.md
node ui/dev/harness.mjs wait "!__hw.week.running" 600000
node ui/dev/harness.mjs logs         # the app's event log + browser console, exceptions, failed requests since last call
node ui/dev/harness.mjs reload | goto "#new" | size 800 1000 | stop
```
It's a second client on the same server, so clicks are real: they change `hw.db` and talk to Claude just like the visible page. Use a sandbox (above) for experiments. `APP_URL`, `HARNESS_PORT` and `HARNESS_CDP_PORT` let several harnesses run at once.

### As an MCP server

`node ui/dev/harness.mjs mcp` serves the same commands as `ui_*` tools: `ui_click`, `ui_type`, `ui_select`, `ui_key`, `ui_drag`, `ui_wheel`, `ui_hover`, `ui_upload`, `ui_wait`, `ui_eval`, `ui_goto`, `ui_reload`, `ui_size`, `ui_state`, `ui_outline`, `ui_screenshot` (returns the image) and `ui_logs`. Every action returns its result, the log lines it produced, and what changed in the app state. It starts the harness if needed. `/.mcp.json` registers it for Claude Code as `hw-ui`.
