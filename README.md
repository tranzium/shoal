# 🐟 shoal

**What if a thousand AI users tried to use your product at once — and told you where they got stuck?**

That's shoal. Point it at a URL and a swarm of persona-driven agents descends in real
browsers: an impatient speedrunner, a confused first-timer, a skeptic hunting for hidden
fees, a keyboard-only user, someone who reads nothing and clicks everything. Each one sees
the page as pixels (Claude computer use + Playwright), attempts the task in character,
narrates its confusion out loud, and files a finding the moment something breaks, misleads,
or silently fails.

It all streams to a live dashboard, and when the swarm is done you get a **friction map** —
every wall they hit, ranked by how many of them hit it ("312 stalled on the checkout
button"), not a thousand raw transcripts.

![The shoal — 1000 agents](docs/images/aquarium-1000.png)

**Every agent is a fish, and depth is your funnel.** They enter at the surface, swim down
as they get through your flow, and end up in one of two places: a gold carpet on the
seabed (converted) or a grey raft of belly-up fish at the surface (rage-quit). The water
level rises as the swarm grows. Orange flashes are agents filing a finding.

You can read the funnel in one glance — no chart required.

Alongside the tank, the **friction map** builds in real time: every distinct issue the
swarm found, ranked by how many agents hit it, each a bar you can read at a glance. That
ranking is the whole point — a wall 300 users hit matters more than one that tripped a
single agent.

**Click any fish** to see exactly what that agent is looking at, what it just thought, and
how far it got:

![Drill-down](docs/images/aquarium-drilldown.png)

The dashboard is also a **control surface** — stop the swarm mid-flight, relaunch it, and
change swarm size or attack strategy without touching the terminal. Toggle `▦ cams` for
the classic camera wall of live browser viewports:

![Camera wall](docs/images/dashboard-camera-wall.png)

<details>
<summary><b>More views</b> — race mode</summary>

**Race mode** — six agents claim the same single-stock item simultaneously. All six get an
order confirmation, and the finding is server-verified ground truth.

![Race mode](docs/images/dashboard-race-mode.png)

</details>

## Quick start — the 60-second demo (no API key)

Runs on macOS, Windows, and Linux — Node 18+ and a few GB of free RAM is all it needs.

```bash
bun install
bunx playwright install chromium
bun run build
node packages/core/dist/cli.js demo
```

Open **http://localhost:4321** and watch 8 scripted agents (real Chromium browsers, zero
API cost) tear into the bundled bait shop — a deliberately flawed demo store with four
planted UX traps:

1. A checkout button that silently ignores the first two clicks
2. A working submit button styled to look disabled
3. A form that fails validation with no error message
4. A $19.50 shipping fee revealed only at the last step

Watch how many agents each trap catches. Then try the concurrency demo:

```bash
node packages/core/dist/cli.js demo --race --swarm 5
```

Five agents converge on a "last one in stock" page, park at a barrier, and claim it in the
same instant. All five get an order confirmation for one unit — and shoal reports the
oversell as **server-verified ground truth**, not an agent's opinion.

Then the multi-user demos — where agents don't just test alone, they interact:

```bash
node packages/core/dist/cli.js demo --scene marketplace              # seller ↔ buyer: the sale the seller never sees
node packages/core/dist/cli.js demo --scene flash-sale --swarm 1000  # 1 unit, 1000 buyers rush it — how many oversell?
node packages/core/dist/cli.js demo --scene collab-doc               # two editors at once: the silently-lost edit
node packages/core/dist/cli.js demo --scene chat                     # sent ≠ delivered: the message that vanishes
```

A scene casts agents in interacting **roles** that coordinate live over the real site. In
`marketplace`, a **seller** lists an item and hands off to a **buyer**, who buys it — the
buyer gets a confirmation, but the seller's dashboard never shows the sale.

`flash-sale` is the scale showpiece: one seller drops a **single unit**, then a crowd of up
to **~1000 buyers rush checkout in the same instant** — and every one of them gets an order
confirmation. That's a textbook oversell from a **non-atomic stock check** (the "is it in
stock?" read and the "mark it sold" write straddle an async gap, so every concurrent request
passes the stale check). The crowd runs as lightweight **concurrent clients** hitting the
server's real checkout path in-process — because proving a server-side race needs a thousand
*simultaneous requests*, not a thousand browsers, which is exactly what lets it fit on a
laptop and show all 1000 fish at once. The coordinator and the two-party scenes still drive
full vision browsers.

None of these bugs is any single agent's opinion: shoal reports them as **server-verified
ground truth** from comparing what every participant actually experienced. `shoal scenes`
lists them all.

![Multi-user scene](docs/images/scene-marketplace.png)

## What's in the box

| | |
|---|---|
| **Friction map** | Findings clustered into distinct issues and ranked by how many of the swarm hit each one — the payoff view, built live |
| **Two axes** | 9 personas × 7 strategies — *who* the user is × *what they do to your app* → [STRATEGIES.md](docs/STRATEGIES.md) |
| **Multi-user scenes** | Agents in interacting roles catch bugs *between* users — the sale the seller never sees, one unit oversold to a crowd, the edit that's silently lost, the message that's sent but never delivered. Scales to ~1000 participants (`shoal scenes`) |
| **Dynamic personas** | Synthesized from your product outlook or real analytics → [GENERATION.md](docs/GENERATION.md) |
| **MCP server** | The swarm inside Claude Code / Cursor: find → fix → re-run → [MCP.md](docs/MCP.md) |
| **Accessibility modality** | A screen-reader persona that perceives the a11y tree, never pixels |
| **Race mode** | Barrier-synced agents that surface real concurrency bugs |
| **Verify pass** | Every finding marked confirmed / suspect before you act on it |
| **Cost meter** | Live dollar counter; $0 on local models or a Claude subscription |

## The real thing — unleash an LLM swarm

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # or `ant auth login`
bun run build
node packages/core/dist/cli.js run http://localhost:3000 --task "Sign up and buy something" --swarm 8
```

**Want proof before you spend anything?** [`examples/real-run-report.md`](examples/real-run-report.md)
is the unedited output of a real four-agent run — real vision agents, their own words,
$0.64 metered. (The `demo` above is scripted on purpose: it makes the tool free to try
and gives CI something deterministic to run.)

Each agent runs a Claude [computer-use](https://platform.claude.com/docs/en/agents-and-tools/computer-use) loop
against its own Playwright browser: screenshot → decide → act. Agents get two extra tools —
`report_finding` (file a UX issue the moment it happens) and `task_result` (declare
victory or ragequit, in character).

### Options

| Flag | Default | Notes |
|---|---|---|
| `--task "<text>"` | "Buy any product and complete checkout." | What the swarm attempts |
| `--swarm <n>` | 8 | Number of agents (hundreds work — see Scale) |
| `--concurrency <n>` | auto | Demo: measured machine capacity. LLM runs: min(swarm, 12) — rate limits bind first |
| `--provider <p>` | `anthropic` | or `openai` for any OpenAI-compatible endpoint |
| `--model <id>` | `claude-opus-5` | see Model tiers below |
| `--base-url <url>` | OpenRouter | OpenAI-compatible endpoint (Ollama, DashScope, Zhipu, vLLM…) |
| `--effort <level>` | `medium` | Anthropic only. `low` → cheaper, `high` → more thorough |
| `--no-verify` | verify on | Skip the Claude review of findings |
| `--personas <ids>` | all, cycled | e.g. `--personas speedrun-sam,newbie-nora` |
| `--strategy <ids>` | complete-task | The second axis — `rage-quit`, `dark-patterns`, … |
| `--race` | off | Barrier-synced concurrency run |
| `--scene <id>` | off | Multi-user scene: `marketplace`, `flash-sale` (scales with `--swarm`), `collab-doc`, `chat`. See `shoal scenes` |
| `--allow-domain <d>` | — | Permit a non-local target (else confirm interactively) |
| `--max-steps <n>` | 30 | Hard cap per agent (personas also have patience budgets) |
| `--headed` | off | Show the actual browser windows |
| `--port <n>` | 4321 | Dashboard port |
| `--host <addr>` | all interfaces | Bind address, e.g. a specific NIC or loopback-alias IP |
| `--data <dir>` | packaged library | External `strategies.yaml`/`personas.yaml`/`missions/*.yaml` (env: `SHOAL_DATA`). Missing files fall back to the packaged defaults |

Reports land in `./shoal-report.md` + `./shoal-report.json`, findings clustered by
similarity and ranked by how many agents hit them.

## Run as a service — `shoal serve`

`shoal run` exits once the swarm finishes (the dashboard stays up to view the report, but
nothing else happens). `shoal serve` is the resident form: it starts the dashboard and
stays up — idle, or immediately running if you pass `--url` — until it gets SIGINT/SIGTERM.
Runs are (re)started from the dashboard's restart button, or by submitting tasks over HTTP.

```bash
bun run build
node packages/core/dist/cli.js serve --port 4340 --no-open \
  --url https://your-app.test --provider subscription --model claude-haiku-4-5 \
  --task "Sign up and buy something"
```

| Flag | Default | Notes |
|---|---|---|
| `--port <n>` | 4321 | Fixed dashboard port |
| `--host <addr>` | all interfaces | Bind address — pin the service to one IP (see Warden example below) |
| `--no-open` | off | Always pass this for a service — otherwise every start opens a browser tab. Honored on both `run` and `serve` |
| `--url <url>` | — | Target for the first (and each restart's) run. Without it, serve stays idle until a restart command or task submission supplies one |
| `--headed` | off | Show the real browser windows |
| `--provider`, `--model`, `--base-url`, `--effort`, `--max-steps`, `--no-verify`, `--personas`, `--task`, `--swarm`, `--concurrency` | as `run` | Starting values for every run the dashboard triggers; model/concurrency default the same way `run` does (Haiku + 3 on `--provider subscription`, Opus + min(swarm, 12) otherwise) |
| `--allow-domain <d>`, `--yes` | — | Same non-local-target policy as `run`, but checked once at startup and never prompts — refuses to start instead (a service has no terminal) |
| `--data <dir>` | packaged library | As `run` — and for `serve` specifically, this directory is **watched and reloaded live** (see below) |

Health probe: `GET /api/health` → `{ "phase": "idle"|"running"|"stopping", "runId": n|null, "startedAt": ms, "uptimeMs": ms, "credentialsError": string|null, "data": { "strategiesError": string|null, "personasError": string|null, "missionsError": string|null } }`.
`phase` reports `idle` again once a run finishes (ready for the next restart) even though
the dashboard itself keeps showing the finished report until you trigger another run.
The `data` block is only present once a data store is attached (always true under `serve`);
a non-null error means the *last* edit failed to parse and the previous good copy is still
what's actually loaded — see "Live data — strategies, personas, missions" below.
`credentialsError` is a **boot-time** preflight (e.g. no `ANTHROPIC_API_KEY` for the chosen
`--provider`) — `serve` warns and boots anyway rather than exiting, since the dashboard
should still come up. It's a diagnostic, not the enforcement point: every `POST /api/tasks`
re-checks live (a `--provider subscription` token rotates hourly and can expire hours into a
long-lived service, long after this field was last true), and refuses the task with a 400
naming the problem before any agent runs.

### Task intake — `POST /api/tasks`

Feed it tasks over HTTP instead of (or as well as) the dashboard's restart button:

```bash
curl -X POST http://localhost:4321/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"url": "http://localhost:3000", "task": "Reproduce the checkout error", "swarm": 5}'
# -> {"id": "t1a2b3c", "position": 0}
```

| Endpoint | What it does |
|---|---|
| `POST /api/tasks` | Queue a task — body `{ url, task, swarm?=1, strategy?, personas?, title?, login?, extension?, expect? }`. Returns `201 { id, position }`; `400` if `url`/`task` are missing or invalid, or if the configured provider has no credentials right now (a swarm of 0 skips that check — nothing would run anyway) |
| `GET /api/tasks` | `{ queue, history }` — what's running/queued, and the last 50 finished |
| `GET /api/tasks/:id` | Status (`queued`/`running`/`done`/`failed`/`cancelled`), timings, outcome |
| `GET /api/tasks/:id/report` | The task's report — markdown by default, or `?format=json`. `404` if the id is unknown (never existed, or lost to a restart); `409 { status, error }` if the task exists but hasn't produced a report yet (still `queued`/`running`, or ended `cancelled` with nothing written) |
| `DELETE /api/tasks/:id` | Cancels a queued task, or aborts one already running |

**Polling contract:** poll `GET /api/tasks/:id` until `status` is terminal
(`done`/`failed`/`cancelled`), then fetch the report. Don't poll `/report` to infer whether a
task is still alive — a `404` there is ambiguous (unknown id vs. simply not ready yet) on
older behavior, and even now it can't distinguish "still running" from "gave up 30 seconds
ago" the way `GET /api/tasks/:id`'s `status` field can.

Tasks run **one at a time, FIFO** — the server returns to idle between them. Each task gets
its own `reports/<id>.md` + `reports/<id>.json` (gitignored), so nothing gets overwritten by
the next task the way `shoal run`'s shared `shoal-report.md` would be. This holds even for a
task that never got as far as running an agent (e.g. a credential failure) — the report's
header carries a `- **Status:** failed — <reason>` line instead of no file existing at all.
Each task also gets `reports/<id>.log` (gitignored) — the full run transcript (per-agent
thoughts, actions, findings) that the service console itself stays quiet about, so a task
that hung or failed still leaves something to read afterward.

An optional `login: { email, password }` is handed to the agent out-of-band — appended to
its system prompt, never to the task text — and redacted from every report, log line, and
WebSocket event, even if an agent narrates it back.

The queue is **in-memory only**: restarting `shoal serve` drops anything still queued or
mid-run (finished tasks' reports on disk survive, since those are just files).

#### Sign-up codes and magic links — testmail.app

When a task asks personas to register a new account, shoal can hand each of them a real,
disposable email address and let them read back whatever the target site sends to it — a
verification code or a magic link — without any human touching a mailbox.

Sign up for a free plan at [testmail.app](https://testmail.app) (100 emails/month), then set:

```
SHOAL_TESTMAIL_NAMESPACE=<your namespace>
SHOAL_TESTMAIL_API_KEY=<your api key>
```

Both are read from the environment (or `.env`) at startup — the feature is **off** (no address
handed out, no extra tool offered) unless both are set. With both set, every agent in a run
gets its own address, `<namespace>.<run id>.<persona index>@inbox.testmail.app`, injected into
its system prompt the same out-of-band way `login.email` is (`agent.ts`'s `systemPrompt`) —
for sign-up only, never for signing in with existing credentials.

Agents also get a new `check_inbox` tool. It waits up to 60 seconds for mail addressed to that
agent since the run started, and returns the subject, the first 4-8 digit code and the first
`https://` link found in the body, plus a trimmed excerpt. It never sends or deletes mail.

The run report records which personas actually received mail and how long delivery took, under
`## Inbox delivery (testmail.app)` — delivery time is itself a product signal worth watching.

The API key is added to the run's secret-redaction list alongside any `login` password, so it
never appears in a log line, report, or WebSocket event, even if an agent narrates it back.
Keep the free plan's 100 emails/month cap in mind — each persona in a run uses at most one.

A task can also be submitted by mission name instead of spelling out `url`/`task`:

```bash
curl -X POST http://localhost:4321/api/tasks -d '{"mission": "signup", "url": "https://real-app.test/"}'
```

`mission` looks up `<dataDir>/missions/<name>.yaml` and uses its fields as defaults; any
other field in the same request body overrides that mission's value (handy for supplying a
real `url` or a `login` per submission instead of baking either into the YAML). See
[`examples/missions/signup.yaml`](examples/missions/signup.yaml) and
[`paid.yaml`](examples/missions/paid.yaml) — copy either into your data dir's `missions/` to
try it.

#### Repro mode — Chrome extensions, captured errors, a verdict

For "an extension error came in, reproduce it and check the fix": pass `extension` (path to
an unpacked extension directory) and, optionally, `expect` (text or `/regex/flags` to match
against what gets captured):

```bash
curl -X POST http://localhost:4321/api/tasks -d '{
  "url": "https://app.test/",
  "task": "Open the popup and add an item to the cart",
  "extension": "/path/to/unpacked-extension",
  "expect": "chrome.runtime is undefined"
}'
```

- With `extension` set, that task's agents load it via `--load-extension` (each gets its own
  persistent browser context instead of the shared pool — extensions require one). Tasks
  without `extension` are unaffected.
- Every agent's page console errors, uncaught `pageerror`s, failed network requests, and the
  extension's own service-worker console errors are captured, deduped by (source, text), and
  merged into the task report as `## Captured browser errors`, each with a repeat count and
  the step it first appeared on.
- With `expect` also set, the report gets a `## Verdict`: `reproduced` (an error matched, with
  the matching evidence lines), `not_reproduced` (nothing matched and every agent completed
  normally), or `inconclusive` (nothing matched but an agent crashed, so the run doesn't prove
  the bug is gone). Run once before a fix (`expect` set to the error) and once after — the
  verdict flips from `reproduced` to `not_reproduced` when the fix lands.

Notes:
- The report is written to `shoal-report.md` / `.json` in the **working directory**, and each run overwrites the last one.
- `.env` in the working directory is loaded at startup (API keys, `SHOAL_INSECURE_TLS`).
- `--provider subscription` reads `~/.claude/.credentials.json`, so run the service as the user who is logged in to Claude Code.
- Shutdown: Ctrl+C / SIGINT (and SIGBREAK on Windows) stops any running swarm, closes the browsers, and exits 0. An external SIGTERM on Windows is a hard kill regardless of the handler — that's Node's documented platform behavior, not a bug here.
- The dashboard has no authentication. Anyone who can reach the port can start a swarm on your credentials.

### Live data — strategies, personas, missions

By default shoal reads its strategy and persona libraries from the package
(`packages/core/strategies/strategies.yaml`, `packages/core/personas/personas.yaml`) and has
no missions at all. Pass `--data <dir>` (or set `SHOAL_DATA`) to point at your own directory
instead:

```
<dataDir>/
  strategies.yaml   # optional — falls back to the packaged library if absent
  personas.yaml     # optional — falls back to the packaged library if absent
  missions/
    signup.yaml      # { title, url, task, strategy?, swarm?, personas? }
    paid.yaml
```

Under `shoal serve`, this directory is **polled every 2 seconds** and reloaded on change —
edit `strategies.yaml`, save, and `GET /api/strategies` (and the dashboard's strategy
dropdown) reflect it within a couple of seconds, with **no restart**. A run already in
flight keeps using whatever it started with; only the *next* run/task sees the new data.
Reload can also be triggered on demand:

- `POST /api/reload` — re-read now, returns `{ changed, strategies, personas, missions }` counts/errors
- WS control command `{ "cmd": "reload" }` — same effect, from the dashboard's own socket

If an edit doesn't parse, shoal **keeps serving the last good copy** and records the parse
error — it's surfaced in `GET /api/health`'s `data` block and in `GET /api/strategies` /
`GET /api/missions`'s `error` field. It never crashes the service or blanks the dashboard
over one bad YAML file. For missions specifically, a broken file only affects *that* mission
(others keep working; a mission that never parsed successfully just doesn't appear).

| Endpoint | What it does |
|---|---|
| `GET /api/strategies` | `{ strategies, source, loadedAt, error }` — what's currently loaded |
| `GET /api/missions` | `{ missions, source, loadedAt, error }` — same, for `missions/*.yaml` |
| `POST /api/reload` | Re-read the data dir immediately instead of waiting for the next poll |

### Running under Warden (always-on, no terminal)

`serve` is meant to be launched once by a process supervisor and left running — Warden,
systemd, pm2, NSSM, whatever manages long-lived services on your box. It never exits on
its own; it only stops on SIGINT/SIGTERM (or SIGBREAK on Windows).

```bash
bun run start -- \
  --host 127.172.0.4 --port 80 --no-open \
  --data data --provider subscription --model claude-haiku-4-5 \
  --playwright-browsers-path C:\Users\<you>\AppData\Local\ms-playwright
```

`bun run start` resolves to `node packages/core/dist/cli.js serve` (`package.json`'s `start`
script) — a fixed, supervisor-friendly command line, with your flags appended after `--`. If
your supervisor invokes commands directly instead of through `bun run start`, the equivalent
is `node packages/core/dist/cli.js serve <flags>` — either form works since `node` is the
real process either way.

- **No `--url`/`--allow-domain` above, on purpose** — those make `serve` immediately launch a
  swarm against that target on every boot. Omit them so the service starts **idle** and waits
  for work via `POST /api/tasks` (below); add them back only if you want a fixed restart
  target baked into the service definition.
- **Working directory** — set it to the repo root (or wherever `.env` and reports should
  live): `.env` is read from there, and `reports/<id>.md`/`.json` land there per task.
- **Autostart** — configure the service to start on boot/login and restart on crash; `serve`
  has no retry loop of its own, it just stays up until killed.
- **`--playwright-browsers-path <dir>`** does the same job as the `PLAYWRIGHT_BROWSERS_PATH`
  env var, as a flag instead — for supervisors (like Warden/NSSM without
  `AppEnvironmentExtra`) that can only pass command-line arguments, not per-service env vars.
  Point it at wherever `bunx playwright install chromium` put the browsers (the path it prints
  at install time, usually `%LOCALAPPDATA%\ms-playwright` on Windows). Any other env var your
  setup needs (API keys, `SHOAL_INSECURE_TLS`, ...) still needs a real env var or `.env` — only
  the browsers path has a CLI-flag escape hatch, since that's the one Playwright itself reads
  outside the app's own option parsing.
- **`--host 127.172.0.4 --port 80`** binds the dashboard to one specific address instead of
  every interface — the shape you want when a hostname (below) is expected to resolve to
  exactly this service and nothing else on the box.
- **`shoal.test` hostname** — point the DNS name at the same address `--host` binds to
  (e.g. `shoal.test → 127.172.0.4`), so `http://shoal.test/` reaches the service directly
  with no reverse proxy needed for port 80.
- **Health check** — poll `GET http://127.172.0.4/api/health`; a 200 with `"phase"` in
  `idle`/`running`/`stopping` means the process is up (see the payload shape above).

## Model tiers — premium, subscription, cheap, free

Agents see pixels, so any **vision + tool-calling** model can drive one. Three providers:

**`--provider anthropic`** (default) uses Claude's native
[computer use](https://platform.claude.com/docs/en/agents-and-tools/computer-use) —
the strongest driving, grounding, and in-character narration, metered per token.
`claude-opus-5` for quality, `claude-haiku-4-5` for cheap swarms.

**`--provider subscription`** runs the swarm on your **Claude Code Pro/Max login** — no
API key, no metering, just the flat fee you already pay. If you're logged into Claude
Code, this works with zero setup:

```bash
node packages/core/dist/cli.js run https://your-app.test --provider subscription --swarm 3
```

It reads your Claude Code token live (the token rotates hourly — Claude Code keeps it
fresh) and drives small, gently-paced swarms. The **binding constraint is the rate pool
you share with your own Claude Code usage** — in testing, a single 2-agent run was enough
to rate-limit the whole subscription for a while. So the default model is `claude-haiku-4-5`
not because it's cheap (the sub is flat-fee — model choice costs nothing) but because it's
the **lightest load on that shared pool**, giving you the most agent-steps before you
throttle your own coding. For better grounding and better-worded findings, use
`--model claude-sonnet-4-6` — and expect to hit the limit faster. The cost meter reads
`$0 · sub` and still shows what the run *would* have cost on the metered API.

> This uses a subscription credential outside the first-party Claude Code app. It works,
> it's great for personal/local use, and it's the honest cheapest path for a solo dev —
> but keep swarms modest, and don't build production automation on it (the token rotates
> and the shared rate pool is real). For big or unattended swarms, use `--provider openai`
> with a local/cheap model, or `--provider anthropic` with an API key.
>
> **macOS note:** Claude Code on macOS stores its token in the Keychain rather than
> `~/.claude/.credentials.json`, so subscription mode currently finds no credentials
> there — use `--provider anthropic` or `--provider openai` on a Mac. Everything else
> (demo, scenes, LLM swarms) is fully cross-platform.

**`--provider openai`** speaks to any OpenAI-compatible endpoint through a generic
computer tool. This is the scale tier:

```bash
# Qwen-VL via OpenRouter (cheap, good GUI grounding)
OPENAI_API_KEY=sk-or-... node packages/core/dist/cli.js run <url> --provider openai \
  --model qwen/qwen3-vl-plus --swarm 50 --concurrency 10

# GLM-V via Zhipu's endpoint
OPENAI_API_KEY=... node packages/core/dist/cli.js run <url> --provider openai \
  --base-url https://open.bigmodel.cn/api/paas/v4 --model glm-4.6v

# Local model via Ollama — zero marginal cost per agent
OPENAI_API_KEY=ollama node packages/core/dist/cli.js run <url> --provider openai \
  --base-url http://localhost:11434/v1 --model qwen3-vl
```

**The verify pass keeps cheap swarms honest.** Weak models produce artifact findings —
"the button doesn't work" when the agent simply missed the button. After the swarm
finishes, one strong Claude call reviews every finding against the agent's action trail
and screenshot, and marks it **✓ confirmed** or **⚠ suspect** (kept in the report,
flagged for human review — never silently dropped). This is the tiered pattern: *many
cheap explorers, one smart editor.* Skip with `--no-verify`; it runs whenever Anthropic
credentials are present, whatever provider drove the swarm.

## Scale: up to 1,000 agents

Agents share a small **pool of Chromium processes** (isolated context each) and are
**freeze-tier scheduled**: an agent's page is frozen — zero CPU — whenever it's waiting
on the model, a scene signal, or a scripted pause, and thaws only for the instant it
acts and screenshots. So hundreds of agents can be *resident* (memory-bound, measured
~57MB each) while only a CPU-bound active set renders at any moment. Past 24 agents the
camera wall shows the agents that are streaming video — a rotating set, since not every
agent in a big swarm can push frames — while the tank view is what represents the whole
swarm at once.

```bash
node packages/core/dist/cli.js demo --swarm 100 --concurrency 16     # 100 scripted agents, zero API cost
```

Mock mode scales as far as your RAM; LLM mode scales as far as your budget and your
provider's rate limits — which usually means waves of 10–50 on Claude, and much larger
swarms on the cheap tier.

How far one machine actually goes, with the measurements:
**[Running 1,000 browser sessions on one machine](docs/SCALING.md)**.

### Cost — measured, not claimed

Shoal meters every token. The dashboard shows a **live dollar counter** while the swarm
runs, the CLI prints the total, and the report includes cost per agent-session plus a
what-if table pricing the same token volume at each tier:

| Tier | Same swarm costs |
|---|---|
| `claude-opus-5` | $$$ (premium: best driving + narration) |
| `claude-haiku-4-5` | ~5× cheaper |
| Qwen/GLM-tier APIs | ~25–50× cheaper |
| local model (Ollama) | $0.00 |

A browser agent step is one vision API call; a session is ~15–25 steps. For models
shoal doesn't know prices for, pass `--price-in`/`--price-out` ($ per million tokens)
to enable the meter. Start small with `--effort low`, scale what works.

## Personas are the whole trick

The failure mode of simulated users is that all your "different" users are secretly the
same user. Shoal's personas force behavioral diversity: distinct goals, knowledge limits,
patience budgets, and quirks.

The built-in library ([`personas.yaml`](packages/core/personas/personas.yaml)) is a
starting point — ⚡ Speedrun Sam · 🧐 Careful Carl · 🌱 Newbie Nora · 🌀 Chaos Cathy ·
🕵️ Skeptic Saul · ⌨️ Keyboard Kai · 📱 Distracted Dee · 📖 Literal Lena — and adding one
is ~10 lines of YAML.

But the real power is **generating personas dynamically** so the swarm mirrors *your*
audience, from either the **product outlook** or **real analytics**:

```bash
# From what the product is (or inferred from the URL by vision)
node packages/core/dist/cli.js run https://your-app.test --generate 15 \
  --audience "impulse-buy streetwear store, Gen-Z, almost entirely mobile"

# Grounded in real PostHog/Sentry/Clarity data — weighted by your actual traffic,
# primed to hit your actual drop-offs and errors
node packages/core/dist/cli.js run https://your-app.test --generate 15 --from-logs ./analytics.json
```

Product-outlook generation is the zero-setup on-ramp; the **log-data path is where it gets
interesting** — personas shaped by your real traffic, primed to hit your real drop-offs.
Full guide, including the analytics JSON shape: **[docs/GENERATION.md](docs/GENERATION.md)**.

## How it works

```
┌─ CLI ─────────────────────────────────────────────────────┐
│ orchestrator                                              │
│   ├─ agent #1 ── Playwright browser ⇄ Claude computer use │
│   ├─ agent #2 ── Playwright browser ⇄ Claude computer use │
│   ├─ …                                                    │
│   └─ events ──► one server, one port:                     │
│        /      dashboard (camera wall, React)              │
│        /ws    live event stream (screenshots, thoughts,   │
│        /shop  the bait shop                    findings)  │
└───────────────────────────────────────────────────────────┘
```

- **Vision, not DOM.** Agents see rendered pixels, so they catch what selector-based
  tests can't: buttons that *look* disabled, invisible focus states, error messages
  that never appear.
- **Findings are the point.** Every agent narrates in first person and files findings
  in the moment. The report clusters near-duplicates across agents — a trap hit by 5
  personas ranks above one hit by 1.
- **Mock mode is a feature, not a stub.** `shoal demo` drives real browsers through
  scripted sessions — reproducible demos, CI smoke tests, and dashboard development,
  all at zero token cost.

## What shoal is not

It's a **filter, not an oracle**. Agent behavior correlates with human behavior
imperfectly; treat findings as cheap leads for real user testing, not a replacement.
The five humans you do test with should never waste their session on a bug an agent
would have caught for pennies.

## Development

```bash
bun install
bun run build                          # dashboard + core
bun run --cwd apps/dashboard dev       # Vite dev server (proxies /ws to :4321)
node packages/core/dist/cli.js demo    # scripted swarm
```

Built in the open. Fork it, break it, send a PR — or just point it at your own site and
watch the shoal go. A hosted version may happen — ⭐ star and watch the repo if you'd
use one. MIT. 🐟
