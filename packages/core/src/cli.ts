#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RunController } from "./runController.js";
import { TaskQueue } from "./taskQueue.js";
import { safeConcurrency } from "./capacity.js";
import { hasSubscription, credentialsError } from "./subscriptionAuth.js";
import { briefFromText, briefFromLogs, briefFromUrl, synthesizePersonas, personasToYaml } from "./personaGen.js";
import { DataStore } from "./dataStore.js";
import { listScenes, sceneScales } from "./scenes.js";
import { fetchPostHog, fetchSentry, mergeExports } from "./connectors.js";
import { confirmTarget, isTargetAllowed, hostOf } from "./safety.js";
import { startMcpServer } from "./mcp.js";
import type { RunOptions } from "./types.js";

// Pick up a local .env before anything reads credentials. Putting ANTHROPIC_API_KEY in
// .env is the obvious thing to try (it's in .gitignore for exactly that reason), and
// silently ignoring it reads as "my key doesn't work". No dependency: Node's own loader.
try {
  process.loadEnvFile?.(".env");
} catch {
  /* no .env here — shell environment still applies */
}

// `--playwright-browsers-path <dir>` as an alternative to the PLAYWRIGHT_BROWSERS_PATH env
// var: some process supervisors (e.g. Warden/NSSM without AppEnvironmentExtra) can only pass
// command-line arguments, not per-service env vars. Playwright resolves this lazily at
// chromium.launch() rather than at import time, so setting it here — before any browser is
// launched, however deep in the call stack that happens — is early enough.
const playwrightBrowsersPathArg = arg("playwright-browsers-path");
if (playwrightBrowsersPathArg) process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPathArg;

const HELP = `
  🐟 shoal — a swarm of AI users that attack your website

  Usage:
    shoal demo [--swarm <n>]            Run the scripted demo swarm against the bundled bait shop
                                        (no API key needed; try --swarm 100 for the school view)
    shoal demo --race --swarm 5         Race-condition demo: agents strike one item together
    shoal demo --scene marketplace      Multi-user demo: a seller and a buyer, and the bug between them
    shoal run <url> [options]           Unleash a real LLM swarm on a URL
    shoal serve [--url <url>] [options] Start the dashboard as a resident service — stays up
                                        until SIGINT/SIGTERM. With --url, restart from the
                                        dashboard runs that target; without it, stays idle
                                        until a restart command supplies one. Pass --no-open
                                        for unattended (service/Warden) use
    shoal personas generate [options]   Synthesize a persona panel and print/save it as YAML
    shoal strategies                    List the attack strategies (the second axis)
    shoal scenes                        List multi-user scenes (seller/buyer, doc, chat…)
    shoal connect [options]             Pull analytics into a persona brief (PostHog/Sentry)
    shoal mcp                           Run as an MCP server (stdio) for Claude Code / Cursor

  Attack strategies (the second axis — persona is WHO, strategy is WHAT they do to the app):
    --strategy <ids>     Comma-separated: complete-task, explore, adversarial-input,
                         rage-quit, dark-patterns, state-breaker, race. Cycled across the swarm.
    --race               Race mode: all agents sync at a barrier and hit one contended
                         action simultaneously, to surface concurrency bugs.
    --scene <id>         Multi-user scene: cast agents in interacting roles to find bugs
                         BETWEEN users. Try: --scene marketplace | flash-sale | collab-doc | chat
                         Scaled scenes (flash-sale) use --swarm to size the crowd:
                         shoal demo --scene flash-sale --swarm 500

  Dynamic personas (instead of the built-in library):
    --generate <n>       Synthesize <n> personas for this run
    --audience "<text>"  Product outlook to synthesize from (who it's for, what it does).
                         Omit with --generate and shoal infers it from the target URL (vision).
    --from-logs <file>   Ground personas in real analytics (PostHog/Sentry/Clarity export JSON —
                         see docs/GENERATION.md for the shape)
    --out <file>         (personas generate) write the YAML here instead of stdout

  Options:
    --task "<text>"      What the swarm should try to do        (default: "Buy any product and complete checkout")
    --swarm <n>          Number of agents                       (default: 8)
    --concurrency <n>    Agents running at once; rest queue     (default: min(swarm, 12))
    --provider <p>       anthropic | openai | subscription      (default: anthropic)
    --model <id>         Model id for the chosen provider       (default: claude-opus-5)
    --base-url <url>     OpenAI-compatible endpoint             (default: https://openrouter.ai/api/v1)
                         e.g. Ollama http://localhost:11434/v1, DashScope, Zhipu, vLLM
    --effort <level>     low|medium|high|xhigh|max (anthropic)  (default: medium)
    --no-verify          Skip the Claude verify pass over findings
    --price-in <usd>     $/M input tokens for unpriced models (with --price-out)
    --price-out <usd>    $/M output tokens — enables the live cost meter for any model
    --personas <ids>     Comma-separated persona ids            (default: all, cycled)
    --max-steps <n>      Hard cap on actions per agent          (default: 30)
    --port <n>           Dashboard port                         (default: 4321)
    --host <addr>        Bind address                           (default: all interfaces)
    --headed             Show the real browser windows
    --no-open            Don't auto-open the dashboard in a browser
    --allow-domain <d>   Permit a non-local target (repeatable). Public hosts otherwise
                         require interactive confirmation — you are pointing a swarm at them.
    --yes                Skip that confirmation (CI / trusted automation)
    --data <dir>         Load strategies.yaml/personas.yaml/missions/*.yaml from here instead
                         of the packaged library (env: SHOAL_DATA). Missing files fall back to
                         the packaged defaults. \`shoal serve\` watches this dir and reloads on
                         edit — no restart needed; a broken YAML edit keeps the last good copy.
    --extension <dir>    Repro mode: load this unpacked Chrome extension (--load-extension).
                         Each agent gets its own persistent context instead of the shared pool.
    --expect <text>      Repro mode: text or /regex/flags to match against captured console/
                         pageerror/network/extension errors. Report gets a reproduced |
                         not_reproduced | inconclusive verdict with the matching evidence.
    --playwright-browsers-path <dir>
                         Same as the PLAYWRIGHT_BROWSERS_PATH env var, as a flag — for
                         supervisors (Warden/NSSM) that can only pass arguments, not env vars.

  Providers & keys:
    anthropic            ANTHROPIC_API_KEY (or \`ant auth login\`) — native computer use, metered
    subscription         Your Claude Code Pro/Max login — no API key, flat fee. Runs the swarm
                         on your subscription (small swarms; shares your Claude Code rate pool).
    openai               OPENAI_API_KEY (or SHOAL_OPENAI_API_KEY) — any vision+tools model
                         behind an OpenAI-compatible endpoint (Qwen-VL, GLM-V, OpenRouter, Ollama)
                         The verify pass still uses Anthropic credentials when available.

  The live dashboard runs at http://localhost:<port>. Reports land in ./shoal-report.md.
`;

export function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** Repeatable flag (--allow-domain a --allow-domain b). */
export function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
}

/** `--data <dir>` or `SHOAL_DATA` — external strategies.yaml/personas.yaml/missions/*.yaml. */
export function dataDirArg(): string | undefined {
  return arg("data") ?? process.env.SHOAL_DATA;
}

function listStrategiesCmd(): void {
  console.log("\n  🎯 Attack strategies — pair any of these with any persona:\n");
  for (const s of new DataStore(dataDirArg()).getStrategies()) {
    const first = s.directive.trim().split("\n")[0].slice(0, 96);
    console.log(`    ${s.id.padEnd(19)} ${s.name}`);
    console.log(`    ${" ".repeat(19)} ${first}…\n`);
  }
  console.log("  Use: shoal run <url> --strategy rage-quit,dark-patterns\n");
}

async function connectCmd(): Promise<void> {
  const out = arg("out", "analytics.json")!;
  const parts = [];

  if (arg("posthog-key")) {
    parts.push(
      await fetchPostHog({
        host: arg("posthog-host"),
        projectId: arg("posthog-project")!,
        apiKey: arg("posthog-key")!,
        funnelInsightId: arg("posthog-funnel"),
        breakdownInsightId: arg("posthog-breakdown"),
      }),
    );
    console.error("  ✓ pulled PostHog");
  }
  if (arg("sentry-token")) {
    parts.push(
      await fetchSentry({
        host: arg("sentry-host"),
        org: arg("sentry-org")!,
        project: arg("sentry-project")!,
        token: arg("sentry-token")!,
      }),
    );
    console.error("  ✓ pulled Sentry");
  }
  if (parts.length === 0) {
    console.error(
      "  shoal connect needs at least one source:\n" +
        "    --posthog-key <k> --posthog-project <id> [--posthog-funnel <insightId>] [--posthog-breakdown <insightId>]\n" +
        "    --sentry-token <t> --sentry-org <o> --sentry-project <p>\n" +
        "  Already have an export? Skip this and pass it straight to --from-logs (docs/GENERATION.md).",
    );
    process.exit(1);
  }
  if (arg("product")) parts.push({ product: arg("product") });

  const merged = mergeExports(...parts);
  writeFileSync(out, JSON.stringify(merged, null, 2), "utf8");
  console.error(`  📊 ${out} written — now: shoal run <url> --generate 12 --from-logs ${out}`);
}

async function generatePersonasCmd() {
  const provider = (arg("provider", "anthropic") as RunOptions["provider"]);
  const n = Number(arg("n", "8"));
  const audience = arg("audience");
  const fromLogs = arg("from-logs");
  const fromUrl = arg("from-url");
  const out = arg("out");

  if (!audience && !fromLogs && !fromUrl) {
    console.error("  personas generate needs --audience \"<text>\", --from-logs <file>, or --from-url <url>.");
    process.exit(1);
  }

  const brief = fromLogs
    ? briefFromLogs(fromLogs)
    : audience
      ? briefFromText(audience)
      : await briefFromUrl(fromUrl!, provider);
  console.error(`  🧬 synthesizing ${n} personas from ${brief.source === "logs" ? "log data" : "product outlook"}…`);
  const personas = await synthesizePersonas(brief, n, provider);
  const yaml = personasToYaml(personas);

  if (out) {
    writeFileSync(out, yaml, "utf8");
    console.error(`  🧬 ${personas.map((p) => p.emoji).join("")}  →  ${out} (${personas.length} personas)`);
  } else {
    process.stdout.write(yaml);
  }
}

/**
 * `run`/`serve` share the same subscription-aware defaults: Haiku + concurrency 3 on
 * `--provider subscription` (the binding constraint there is the shared Claude Code rate
 * pool, not cost), otherwise Opus + min(swarm, 12) for LLM runs.
 */
function defaultModelAndConcurrency(
  provider: RunOptions["provider"],
  swarm: number,
): { model: string; concurrency: number } {
  const isSub = provider === "subscription";
  return {
    model: provider === "openai" ? "qwen/qwen3-vl-plus" : isSub ? "claude-haiku-4-5" : "claude-opus-5",
    concurrency: isSub ? Math.min(swarm, 3) : Math.min(swarm, 12),
  };
}

/** Builds the options `shoal serve` boots with. `--url` (or a later `restart` control
 *  command from the dashboard / task API) supplies the target; without either, serve
 *  stays idle. */
export function serveOpts(): RunOptions {
  const provider = (arg("provider", "anthropic") as RunOptions["provider"]);
  const swarm = Number(arg("swarm", "8"));
  const { model: defaultModel, concurrency: defaultConcurrency } = defaultModelAndConcurrency(provider, swarm);
  return {
    url: arg("url", "")!,
    task: arg("task", "Buy any product and complete checkout.")!,
    swarm,
    concurrency: Number(arg("concurrency", String(defaultConcurrency))),
    concurrencyPinned: process.argv.includes("--concurrency"),
    provider,
    baseUrl: arg("base-url"),
    model: arg("model", defaultModel)!,
    effort: (arg("effort", "medium") as RunOptions["effort"]),
    verify: !process.argv.includes("--no-verify"),
    personaIds: arg("personas")?.split(",").map((s) => s.trim()),
    allowDomains: args("allow-domain"),
    yes: process.argv.includes("--yes"),
    maxSteps: Number(arg("max-steps", "30")),
    headless: !process.argv.includes("--headed"),
    mock: false,
    port: Number(arg("port", "4321")),
    host: arg("host"),
    open: !process.argv.includes("--no-open"),
    dataDir: dataDirArg(),
    extension: arg("extension"),
    expect: arg("expect"),
  };
}

/** Same depth from src/cli.ts and dist/cli.js to the dashboard's built assets (server.ts's DASHBOARD_DIST). */
function dashboardBuilt(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  return existsSync(join(here, "..", "..", "..", "apps", "dashboard", "dist", "index.html"));
}

async function serveCmd(): Promise<void> {
  const opts = serveOpts();

  if (!dashboardBuilt()) {
    console.error("  ⚠ dashboard not built — run `bun run build` first, or the dashboard will 404\n");
  }

  // A service has no terminal to confirm against, so this is a hard gate, not a prompt:
  // an unset or allowlisted URL proceeds, anything else public needs --allow-domain/--yes
  // up front (same policy `run` enforces interactively via confirmTarget).
  if (opts.url && !isTargetAllowed(opts.url, opts.allowDomains) && !opts.yes) {
    console.error(`  ✗ Target is not local: ${hostOf(opts.url)}`);
    console.error(`    shoal serve never prompts — pass --allow-domain ${hostOf(opts.url)} or --yes to confirm.`);
    process.exit(1);
  }

  // A service has no terminal to refuse a bad/expired credential interactively either — so,
  // unlike `run`/`demo`, this warns and boots anyway (the dashboard should still come up),
  // and records the reason on /api/health. The task queue re-checks live at submission time
  // (a subscription token rotates hourly and can expire under a long-lived service), so this
  // boot-time check is a diagnostic, not the enforcement point.
  const credError = credentialsError(opts.provider);
  if (credError) {
    console.error(`  ⚠ ${credError}`);
    console.error("    shoal serve is booting anyway to serve the dashboard, but every submitted task will fail until this is fixed.");
  }

  const controller = new RunController(opts);
  await controller.start(false); // stay in `idle` — no swarm until a restart command arrives
  controller.shoalServer.credentialsError = credError;
  // One task at a time, FIFO: POST /api/tasks queues work, the queue runs it and returns
  // to idle before starting the next. Queue is in-memory — a restart drops anything queued.
  controller.shoalServer.tasks = new TaskQueue(controller.shoalServer, opts);
  const waiting = opts.url ? `target set: ${opts.url}` : "idle, waiting for a task";
  console.log(`  🐟 shoal serve — dashboard at http://localhost:${opts.port} (${waiting})`);
  console.log(`  📬 POST http://localhost:${opts.port}/api/tasks to submit one`);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n  ${signal} received — shutting down`);
    controller.shutdown().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // SIGBREAK (Ctrl+Break) is the one console-close signal Windows delivers to a handler —
  // an external kill/SIGTERM there is unconditional and cannot be intercepted.
  if (process.platform === "win32") process.on("SIGBREAK", () => shutdown("SIGBREAK"));
  // No await this.run(): the http/ws server keeps the event loop (and the process) alive.
}

async function main() {
  const [, , command, maybeUrl] = process.argv;

  if (command === "personas" && process.argv[3] === "generate") {
    await generatePersonasCmd();
    return;
  }
  if (command === "strategies") {
    listStrategiesCmd();
    return;
  }
  if (command === "scenes") {
    console.log("\n  🎭 Multi-user scenes — agents in interacting roles, to find bugs BETWEEN users:\n");
    for (const s of listScenes()) {
      console.log(`    ${s.id.padEnd(13)} ${s.name}${sceneScales(s) ? "  (scales with --swarm, up to ~1000)" : ""}`);
      console.log(`    ${" ".repeat(13)} ${s.summary}\n`);
    }
    console.log("  Use: shoal demo --scene flash-sale --swarm 500\n");
    return;
  }
  if (command === "connect") {
    await connectCmd();
    return;
  }
  if (command === "mcp") {
    startMcpServer();
    return; // stdio server owns the process from here
  }
  if (command === "serve") {
    await serveCmd();
    return; // resident process — the server keeps it alive until SIGINT/SIGTERM
  }

  if (command !== "demo" && command !== "run") {
    console.log(HELP);
    process.exit(command ? 1 : 0);
  }

  const mock = command === "demo";
  if (!mock && (!maybeUrl || maybeUrl.startsWith("--"))) {
    console.error("  shoal run needs a URL. See: shoal --help");
    process.exit(1);
  }

  const provider = (arg("provider", "anthropic") as RunOptions["provider"]);
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY || process.env.SHOAL_OPENAI_API_KEY);

  if (!mock) {
    if (provider === "anthropic" && !hasAnthropic) {
      console.error("  No ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / ant profile) found.");
      console.error("  On a Claude Pro/Max plan? Run on your subscription: --provider subscription");
      console.error("  Or try the zero-cost demo first: shoal demo");
      process.exit(1);
    }
    if (provider === "openai" && !hasOpenAI) {
      console.error("  --provider openai needs OPENAI_API_KEY (or SHOAL_OPENAI_API_KEY).");
      console.error("  For Ollama any non-empty value works: OPENAI_API_KEY=ollama");
      process.exit(1);
    }
    if (provider === "subscription" && !hasSubscription()) {
      console.error("  --provider subscription needs a logged-in Claude Code (Pro/Max) session.");
      console.error("  Run any Claude Code command first, or use --provider anthropic with an API key.");
      process.exit(1);
    }
  }

  const swarm = Number(arg("swarm", "8"));
  // Subscription mode's binding constraint is the shared Claude Code RATE POOL, not cost
  // (it's flat-fee, so model choice is free). We default to Haiku because it's the lightest
  // load on that pool — the most agent-steps before you throttle your own Claude Code — not
  // because it's cheap. Upgrade grounding with --model claude-sonnet-4-6 at the cost of
  // draining the pool faster. Testing showed one small run can rate-limit the whole sub.
  const isSub = provider === "subscription";
  const defaultModel =
    provider === "openai" ? "qwen/qwen3-vl-plus" : isSub ? "claude-haiku-4-5" : "claude-opus-5";
  // Mock swarms are bound by the machine (resident browsers, freeze-tiered), not by an
  // API rate pool — so let them fill the measured capacity. LLM runs stay conservative:
  // the provider's rate limits bind long before RAM does.
  const defaultConcurrency = mock
    ? Math.min(swarm, safeConcurrency())
    : isSub
      ? Math.min(swarm, 3)
      : Math.min(swarm, 12);

  if (isSub && !mock) {
    console.log("  ⚠️  Subscription mode draws on the SAME rate pool as your Claude Code usage.");
    console.log("     One small swarm can rate-limit the whole subscription for a while — keep");
    console.log("     runs tiny. Default model is Haiku (lightest on the pool); for better");
    console.log("     grounding use --model claude-sonnet-4-6 and expect faster throttling.\n");
  }

  const opts: RunOptions = {
    url: mock ? "" : maybeUrl,
    task: arg("task", "Buy any product and complete checkout.")!,
    swarm,
    concurrency: Number(arg("concurrency", String(defaultConcurrency))),
    concurrencyPinned: process.argv.includes("--concurrency"),
    provider,
    baseUrl: arg("base-url"),
    model: arg("model", defaultModel)!,
    effort: (arg("effort", "medium") as RunOptions["effort"]),
    verify: !process.argv.includes("--no-verify"),
    price:
      arg("price-in") && arg("price-out")
        ? { inPerM: Number(arg("price-in")), outPerM: Number(arg("price-out")) }
        : undefined,
    personaIds: arg("personas")?.split(",").map((s) => s.trim()),
    strategyIds: arg("strategy")?.split(",").map((s) => s.trim()),
    scene: arg("scene"),
    generate: arg("generate")
      ? { n: Number(arg("generate")), audience: arg("audience"), fromLogs: arg("from-logs") }
      : undefined,
    race: process.argv.includes("--race") ? { path: arg("race-path") } : undefined,
    allowDomains: args("allow-domain"),
    yes: process.argv.includes("--yes"),
    maxSteps: Number(arg("max-steps", "30")),
    headless: !process.argv.includes("--headed"),
    mock,
    port: Number(arg("port", "4321")),
    host: arg("host"),
    open: !process.argv.includes("--no-open"),
    dataDir: dataDirArg(),
    extension: arg("extension"),
    expect: arg("expect"),
  };

  // A swarm is a lot of automated traffic. Make an unfamiliar target a deliberate choice.
  if (!mock && !(await confirmTarget(opts.url, { allow: opts.allowDomains, yes: opts.yes, swarm: opts.swarm }))) {
    process.exit(1);
  }

  // The controller owns the server, so the dashboard's stop/restart buttons work and
  // the UI stays connected across runs.
  await new RunController(opts).start();
}

// Only run when executed directly (`node dist/cli.js ...`), not when imported by tests.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
