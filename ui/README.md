# Homework generator: local UI

```
node ui/server.mjs
```
Then open http://localhost:4747.

Requires Node 22, an Anthropic API key (`ANTHROPIC_API_KEY`; see the main README), `npm install`, and `brew install tectonic` for PDFs.

The page is split in two: the conversation with Claude on the left (every tool call shown as a chip, with a cost footer per turn), and the current step's work on the right. The pill in the header always says what to do next.

1. **Set up the week.**
   - The unit card shows the unit you're teaching now. If you're still on it, do nothing. If you moved on, click **We moved on →**: the current unit is marked taught, and you pick the next one from the units the student is now ready for. You can undo this.
   - **show all units** opens the full timeline.
   - **Make a set on Uxx →** (or **Make a set →** next to any unit under **We moved on**) is the one-click path: it marks that unit current, sets the date a week after the last saved set, keeps the rest of last week's input, and has Claude write the finished set in one pass, with no questions and no outline. The reply opens with a **Judgment calls** list; correct any of them in one chat message, or go straight to step 3.
   - To steer the set instead, fill in the date and topics and click **Generate outline**.
   - Everything autosaves to `weekly_status.md`. **view MD** shows the raw file.
2. **Review the outline.**
   - If Claude asks questions, answer them or click **Use your defaults**.
   - When it sends the checkpoint, approve it or send changes.
3. **Check and save.**
   - The PDF compiles automatically, with checks for banned or gated words and for lines that run past the margin.
   - If something is flagged, one click asks Claude to fix it.
   - Changes to next week's status are shown as a list. **view MD** shows the diff.
   - **Save & finish** writes the `.tex` into the project folder and updates `weekly_status.md`. The old status file is backed up to `ui/data/backups/`. The set's problems go into the corpus and are tagged by content and solution method in the background (`tag` lines in the log).

Header buttons:
- **$ badge**: what each turn cost on your API account, tokens, searches, tool calls, and an estimated research vs writing split. `HW_BUDGET_USD=2` caps each turn.
- **Progress map**: Wu's school algebra as two DAGs (Content and Methods). **Guess progress** has Claude read every homework file and your uploaded notes and mark each block done / partly / not yet; click a block to see its evidence or override it.
- **Corpus**: every problem Claude can reuse (past homework, problems it saved from research). ★ to prefer, ✕ to never offer again.
- **History**: a searchable list of sessions (one per homework, grouped by date). Each opens read-only in place: the **Conversation** (your inputs and Claude's steps, tool calls, replies and cost) and the **Homework** it produced (PDF / Source / Compile log). Older `.tex` files with no session are listed at the bottom; ← → between sessions.

Claude has three local tools (`ui/mcp/hw-tools.mjs`): `cas` (sympy, to check answer keys), `corpus_search` and `corpus_add`. Install the CAS once: `uv venv ui/data/venv && uv pip install --python ui/data/venv sympy`.

Claude keeps working if you close the tab. Each week is one resumable Claude session, stored in `ui/data/weeks/`.

Options: `HW_STUDENT=<name>` (shown in the UI and prompts; default generic), `HW_CURRICULUM=<name>` (sidebar header; default Wu Algebra), `PORT=5000`, `HW_TAG_MODEL` (default Haiku), `HW_NO_TAG=1`, `HW_GOLD_FILES=3` (how many recent sets go in every prompt as style examples), `HW_MODEL=claude-sonnet-5-5`, `HW_GUESS_MODEL`, `HW_BUDGET_USD`, `HW_PASSWORD_HASH` (require a login; from `node ui/scripts/hash-password.mjs`), `HW_HOST` (listen address, default 127.0.0.1; anything else needs a password), `HW_TRUST_PROXY=1` (behind a reverse proxy), `HW_LOG_QUIET=1`. Open `/#new` to skip an unfinished week.

## Where things live

| File | Owns |
|---|---|
| `server.mjs` | HTTP API, `weekly_status.md` read/write, the Claude runs (`runClaude`, `buildSystemPrompt`), compiles, save & finish (`/finish`, `saveManifest`) |
| `lib/tagger.mjs` | tags problems with Wu content and methods nodes (one cheap Claude pass), used by Save & finish, seeding and `tag-corpus.mjs` |
| `lib/corpus.mjs` | problem corpus: load/save, search, `splitTex`, `attachTex` (manifest → problem LaTeX) |
| `mcp/hw-tools.mjs` | the MCP tools Claude calls: `cas`, `corpus_search`, `corpus_add` |
| `public/state.js` | app state, phases (`phaseOf`), `send`, polling, `currentFinal`, status autosave |
| `public/lib.js` | shared helpers: `S` (server state), weekly_status parsing/writing, `lintTex`, `mathify`, `nextSetDate` |
| `public/work.js` | right pane: units widget and **Make a set** (`quickSet`), setup form, outline view, final checks and save bar |
| `public/chat.js` | left pane: conversation, tool chips, composer |
| `public/topics.js` | topic chips |
| `public/dag.js`, `history.js`, `corpus.js`, `cost.js` | the header dialogs |
| `public/uilog.js`, `main.js` | interaction logging; entry point and `window.__hw` |
| `dev/` | harness (headless Chrome + MCP) and sandbox |
| `scripts/` | tests, corpus seeding, DAG import |

## Event log

Everything that happens goes to one log, printed by the server as it runs and appended to `ui/data/logs/app.jsonl`:
- `ui`: every click, change, typed value (after a pause), key, drag, zoom, file pick, dialog open/close and phase change in the browser, plus page errors.
- `http`: every API request with status and time.
- `claude`: each run's start, every tool call and result (web search, fetch, CAS, corpus), cost and end.
- `tex` and `dag`: compiles and progress-map guesses.

`GET /api/logs?since=<seq>` returns the same events.

## Tests

```
node ui/scripts/test.mjs          # 12 checks: corpus search/save, .tex split, manifest matching, tagger reply, next set date, topic chips, final-check gating, DAG integrity, map states (<1 s)
node ui/scripts/test-mcp.mjs      # one call per MCP tool: cas, corpus_search, corpus_add (temp copy of the corpus)
node ui/scripts/test-ui-mcp.mjs   # the basic workflows (setup, outline, check & save, dialogs) via the harness MCP, on fixed anonymous fixtures (`scripts/fixtures/`) in a sandbox (~10 s); the sandbox and transcript are kept when a step fails, or always with KEEP=1
```
Run the first two after any change (under a second); run the UI test before a commit or after UI changes. None of them call Claude.
`node ui/scripts/tag-corpus.mjs [--all] [--dry]` tags any corpus problem that has no Wu DAG nodes (Haiku, about $0.002 per 25 problems). `--all` re-tags every problem from scratch (after a DAG edit); it backs up the corpus first.

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
It's a second client on the same server, so clicks are real: they edit `weekly_status.md` and talk to Claude just like the visible page. Use a sandbox (above) for experiments. `APP_URL`, `HARNESS_PORT` and `HARNESS_CDP_PORT` let several harnesses run at once.

### As an MCP server

`node ui/dev/harness.mjs mcp` serves the same commands as `ui_*` tools: `ui_click`, `ui_type`, `ui_select`, `ui_key`, `ui_drag`, `ui_wheel`, `ui_hover`, `ui_upload`, `ui_wait`, `ui_eval`, `ui_goto`, `ui_reload`, `ui_size`, `ui_state`, `ui_outline`, `ui_screenshot` (returns the image) and `ui_logs`. Every action returns its result, the log lines it produced, and what changed in the app state. It starts the harness if needed. `/.mcp.json` registers it for Claude Code as `hw-ui`.
