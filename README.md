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

There is no build step. `npm install` fetches the dependencies (the Anthropic SDK, plus the S3 client for R2 and
Vercel's Blob and functions SDKs, which only load when hosted); the front end is plain ES modules.

## Run it locally

You need:

- **Node 22** (the UI test and debugging harness use Node's built-in WebSocket).
- **An Anthropic API key** (https://console.anthropic.com). Every turn calls the Claude API directly and is billed per
  token to your API account; the **$** panel shows the real charges. `HW_BUDGET_USD=2` caps what each turn can spend.
- **Tectonic** for PDFs: `brew install tectonic` (or see https://tectonic-typesetting.github.io).
- *Optional:* **sympy** for checking answer keys. Claude uses it through a `cas` tool:
  `uv venv ui/data/venv && uv pip install --python ui/data/venv sympy`. Without it the app still works; answers just
  aren't CAS-verified.

Then:

```
npm install
ANTHROPIC_API_KEY=sk-ant-... HW_STUDENT="Sam" node ui/server.mjs
```

(or put the key in `.env` and run `node --env-file=.env ui/server.mjs`), and open http://localhost:4747. `HW_STUDENT` is the student's name as it appears in the header and prompts (leave it
out for a generic "the student"). On first run the server copies two files from `examples/` into the repo root:

| file | what it is |
|---|---|
| `project_instructions.md` | the workflow and house style Claude follows: gates, checkpoint, audit passes, LaTeX conventions |
| `curriculum_ladder.md` | the ordered units, what each needs first, and which are formal or informal |

Those copies are yours and are not tracked by git, so edit them freely.

The walkthrough of the screens, every option (`PORT`, `HW_MODEL`, `HW_BUDGET_USD`, …), the event log, the tests and
the debugging harness are in [ui/README.md](ui/README.md).

## Host it for someone else

Two ways: on Vercel (no server to run; see the end of this section), or as a long-running Node process on a small
Linux VM or an always-on computer at home. The steps below are for a machine of your own.

**1. Install the same tools as above** on the server: Node 22, Tectonic, and optionally the sympy venv. Then clone the
repo and run `npm install`.

**2. Make a password hash.** On the server, run

```
node ui/scripts/hash-password.mjs
```

and type a password of at least 10 characters. It prints a line like `scrypt$16384$8$1$…`. The server stores only this
hash, never the password itself.

**3. Put the settings in an env file** that only you can read, e.g. `/etc/homework.env` (`chmod 600`):

```
ANTHROPIC_API_KEY=sk-ant-...
HW_PASSWORD_HASH=scrypt$16384$8$1$...
HW_TRUST_PROXY=1
HW_BUDGET_USD=3
HW_STUDENT=Sam
```

If you `export` these in a shell instead, wrap the hash in single quotes: it contains `$`.

**4. Run it behind HTTPS.** Leave the app listening on `127.0.0.1` (the default) and put
[Caddy](https://caddyserver.com) in front of it. Caddy gets a certificate for your domain automatically. The whole
`/etc/caddy/Caddyfile`:

```
homework.example.com {
    reverse_proxy 127.0.0.1:4747
}
```

`HW_TRUST_PROXY=1` tells the app it is behind a proxy, so it rate-limits logins per real client IP and marks the login
cookie `Secure`. Only set it when a proxy really is in front.

**5. Keep it running** with systemd, e.g. `/etc/systemd/system/homework.service`:

```
[Unit]
Description=Homework generator
After=network.target

[Service]
User=hw
WorkingDirectory=/home/hw/homework-generator
EnvironmentFile=/etc/homework.env
ExecStart=/usr/bin/node ui/server.mjs
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

then `sudo systemctl enable --now homework`. The startup log (`journalctl -u homework`) should show
`Claude: Anthropic API` and `Login: password required`.

**How the login works.** With `HW_PASSWORD_HASH` set, every page and API call needs a session. You get one by
entering the password at `/login`. Sessions last 30 days and survive restarts. **Log out** in the header ends yours.
After 8 wrong passwords from one address (or 40 in total) the app refuses logins for 15 minutes. To change the
password, make a new hash and restart; to log everyone out, also delete `ui/data/sessions.json`. Without a hash
there's no login, and the server refuses to listen on anything but localhost (`HW_HOST=0.0.0.0` is only allowed
with a password). Use a strong password: anyone who logs in can spend your API credit, and Claude's `cas` tool
runs Python on the server.

### Or: on Vercel

The repo deploys to Vercel as it is (`vercel.json`): the Node app runs as one function (`api/index.mjs`), the sympy
tool as a Python function (`api/cas.py`, with no network and a clean environment), and the build step bundles a
static Linux Tectonic. A function's disk is temporary, so the homework files and `ui/data` live in a private
[Cloudflare R2](https://developers.cloudflare.com/r2/) bucket (or, if no `R2_*` variables are set, a
[Vercel Blob](https://vercel.com/docs/vercel-blob) store), mirrored to `/tmp` on each instance (`ui/lib/mirror.mjs`):
changes are pulled before each request and pushed after each write. Running jobs, their live progress and Stop
requests go through the same store, so they work across instances. Preview deployments use their own copy of the
data (`hw-preview/`), so testing never touches production.

```
vercel link --project homework                                       # once; then create an R2 bucket and an
                                                                     # R2 API token (Object Read & Write, that bucket)
for v in R2_ACCOUNT_ID R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do vercel env add $v production --sensitive; done
vercel env add ANTHROPIC_API_KEY production --sensitive              # and HW_PASSWORD_HASH, HW_BUDGET_USD, HW_STUDENT
openssl rand -hex 32 | vercel env add HW_INTERNAL_TOKEN production --sensitive   # app -> cas function
node --env-file=.env.r2 deploy/vercel/migrate-data.mjs --yes        # copy local data in, once (.env.r2 holds
                                                                     #   the R2_* values); refuses if not empty
vercel deploy --prod
vercel domains add homework.example.com homework
```

Moving from Vercel Blob to R2: `deploy/vercel/copy-blob-to-r2.mjs` copies every blob across with the same keys
(see its header). The free tiers differ a lot for this app, which lists the store on every request: Blob's Hobby plan
allows about 2,000 list/put operations a month, R2's about a million.

Hobby plans cap a request at 300 s (`maxDuration` in `vercel.json`; Pro allows 800). A turn still running at that
point is cut off and can be retried. Logins on Vercel are always treated as behind a proxy (`HW_TRUST_PROXY` is
implied).

## Add your own homework data

1. **Put your past sets in the repo root** as `hw_M_D_YYYY.tex`, e.g. `hw_9_24_2026.tex`. The date in the name orders
   them. The three most recent go into every prompt as style examples ("gold files", `HW_GOLD_FILES` to change), so a
   few good sets in your own format matter more than anything else. To keep them elsewhere, set `HW_ROOT=/path/to/dir`
   (that folder then holds the `.tex` files and the two `.md` files).
2. **Edit `curriculum_ladder.md`** to match your course: one `- Uxx Name. Description. Needs Uyy. Formal.` line per
   unit. The app reads the unit ids, names and dependencies from these lines.
3. **Set the unit statuses** in the app (Create Homework): each unit is TAUGHT, CURRENT, NEXT or FUTURE. Claude only
   uses TAUGHT and CURRENT material. The status (statuses, review priority, standing conventions, history) lives in
   `ui/data/hw.db`, starts from `examples/weekly_status.md`, and the app keeps it up to date as you finish sets. Export or
   upload it as `status.md` on Progress map › Lesson plan. (A `weekly_status.md` already in the root is imported once,
   when `hw.db` is first created, and not read after that.)
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
