# Homework generator

A local web app that writes weekly math homework sets with Claude. You keep a short status file (which units are
taught, what to review, this week's topics); Claude drafts an outline, you approve it, and it writes the finished
LaTeX set with an answer key, checked with a CAS and compiled to PDF. Every problem it writes is saved to a
searchable problem corpus that later sets draw from.

It was built for one student working through an algebra course in the style of H. Wu, so the curriculum ladder and
the two dependency graphs (DAGs) follow Wu's algebra. Everything course-specific lives in plain Markdown/JSON files
you can replace.

## Open the repo

```
git clone git@github.com:jtwaugh/homework-generator.git
cd homework-generator
```

There is no build step and nothing to `npm install`: the server is one zero-dependency Node file and the front end
is plain ES modules.

## Run it locally with a Claude account

You need:

- **Node 18+** for the app; **Node 22** for the UI test and debugging harness (they use Node's built-in WebSocket).
- **The `claude` CLI, logged in to your Claude account.** Install Claude Code
  (https://claude.com/claude-code), run `claude`, then `/login`. The app runs `claude -p` for every turn,
  so usage counts against your Claude plan. It ignores `ANTHROPIC_API_KEY` unless you opt in (see the next
  section), so you aren't billed through the API by accident.
- **Tectonic** for PDFs: `brew install tectonic` (or see https://tectonic-typesetting.github.io).
- *Optional:* **sympy** for checking answer keys. Claude uses it through a local `cas` tool:
  `uv venv ui/data/venv && uv pip install --python ui/data/venv sympy`. Without it the app still works; answers just
  aren't CAS-verified.

Then:

```
HW_STUDENT="Sam" node ui/server.mjs
```

and open http://localhost:4747. `HW_STUDENT` is the student's name as it appears in the header and prompts (leave it
out for a generic "the student"). On first run the server copies the files from `examples/` into the repo root:

| file | what it is |
|---|---|
| `project_instructions.md` | the workflow and house style Claude follows: gates, checkpoint, audit passes, LaTeX conventions |
| `curriculum_ladder.md` | the ordered units, what each needs first, and which are formal or informal |
| `weekly_status.md` | unit statuses, review priority, standing conventions, history and this week's input; the app edits this as you work |

Those copies are yours and are not tracked by git, so edit them freely.

### No Claude subscription? Use an API key

If `claude` isn't logged in to a Claude subscription, the app can use an Anthropic API key instead
(create one at https://console.anthropic.com). You still need the `claude` CLI installed; it doesn't need to be
logged in. Set the key and opt in:

```
ANTHROPIC_API_KEY=sk-ant-... HW_ALLOW_API_KEY=1 HW_STUDENT="Sam" node ui/server.mjs
```

At startup the server runs `claude auth status` and prints which one it is using (`Claude: subscription` or
`Claude: api-key`). A subscription always wins: with one logged in, the key is ignored even with
`HW_ALLOW_API_KEY=1`. On an API key every turn is billed per token to your API account, so the figures in the
**$** panel are real charges rather than API-equivalent estimates. `HW_BUDGET_USD=2` caps what each turn can spend.
A key without `HW_ALLOW_API_KEY=1` is ignored, and the setup screen shows a warning when there's no subscription and
no opted-in key.

The walkthrough of the screens, every option (`PORT`, `HW_MODEL`, `HW_BUDGET_USD`, …), the event log, the tests and
the debugging harness are in [ui/README.md](ui/README.md).

## Add your own homework data

1. **Put your past sets in the repo root** as `hw_M_D_YYYY.tex`, e.g. `hw_9_24_2026.tex`. The date in the name orders
   them. The three most recent go into every prompt as style examples ("gold files", `HW_GOLD_FILES` to change), so a
   few good sets in your own format matter more than anything else. To keep them elsewhere, set `HW_ROOT=/path/to/dir`
   (that folder then holds the `.tex` files and the three `.md` files).
2. **Edit `curriculum_ladder.md`** to match your course: one `- Uxx Name. Description. Needs Uyy. Formal.` line per
   unit. The app reads the unit ids, names and dependencies from these lines.
3. **Edit `weekly_status.md`**: set each unit to TAUGHT, CURRENT, NEXT or FUTURE. Claude only uses TAUGHT and CURRENT
   material. The app keeps this file up to date as you finish sets, so you mostly set it once.
4. **Edit `project_instructions.md`** for your own conventions (title format, number of sections, what to avoid).
5. Restart the server if it was running, then click **Make a set** or **Generate outline**.

Sets you save land in the root as new `hw_*.tex` files, so the gold files keep tracking your latest style.

## Start a problem-set corpus

The corpus is `ui/data/corpus/problems.jsonl`, one problem per line, with its units, answer, source, Wu DAG tags and
a status (favorite, used, rejected). It starts empty. Claude searches it before writing a set and prefers adapting
problems you've starred.

- **Seed it from your past sets**: `node ui/scripts/seed-corpus.mjs` splits every `hw_*.tex` into problems and tags
  them in one cheap Claude pass (Haiku). `--dry` shows what would be added; `--no-claude` uses keyword tagging only.
  It's safe to re-run: problems are keyed by a hash of their text.
- **It grows on its own**: every set you **Save & finish** adds its problems (tagged in the background), and problems
  Claude finds on the web during research are added as candidates.
- **Curate it** in the **Corpus** dialog: ★ to favor a problem, ✕ to keep it out for good.
- `node ui/scripts/tag-corpus.mjs` tags any problem that is missing tags.

## The DAGs are provisional

`ui/data/wu_dag.json` (content: definitions, theorems, skills) and `ui/data/wu_methods_dag.json` (solution methods)
are a first pass at mapping Wu's algebra into dependency graphs. Expect them to change: nodes split, merge, get
renumbered or re-wired. They drive the **Progress map** and every corpus problem's `wuNodes` tags.

**If you change either DAG, re-tag the corpus.** Existing tags point at node ids, so after an edit they can point at
nodes that moved, merged or no longer exist, and corpus search and the progress map will quietly use stale tags. Run

```
node ui/scripts/tag-corpus.mjs --all
```

to re-tag every problem from scratch (it backs up `problems.jsonl` first; a few hundred problems cost a few cents
of Haiku usage). `node ui/scripts/test.mjs` checks that both DAGs are acyclic and that every edge joins real nodes;
run it after editing them.

## Tests

```
node ui/scripts/test.mjs          # unit checks, under a second
node ui/scripts/test-mcp.mjs      # Claude's local tools (cas, corpus_search, corpus_add)
node ui/scripts/test-ui-mcp.mjs   # the main workflows in headless Chrome on anonymous fixtures (~10 s; needs Chrome)
```

None of them call Claude or touch your real files.

## License

MIT; see [LICENSE](LICENSE).
