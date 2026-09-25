#!/usr/bin/env node
// This file must stay import-free (besides node:url) until AFTER it has set
// PLAYWRIGHT_BROWSERS_PATH and loaded .env. playwright-core (1.62) computes its
// registryDirectory from PLAYWRIGHT_BROWSERS_PATH once, at module-import time — not lazily
// at chromium.launch() as an earlier fix here assumed. Anything imported statically above
// this point (cliMain.js -> orchestrator.js -> browser.js -> "playwright") would bake in
// the wrong path before `--playwright-browsers-path` (a supervisor's stand-in for the env
// var, e.g. Warden/NSSM without AppEnvironmentExtra) ever gets applied. Same story for
// .env: subscriptionAuth.ts reads SHOAL_CLAUDE_CREDENTIALS the moment it's imported. So the
// real CLI is loaded dynamically, after both are set, via cliMain.js.
import { pathToFileURL } from "node:url";

// Pick up a local .env before anything reads credentials. Putting ANTHROPIC_API_KEY in
// .env is the obvious thing to try (it's in .gitignore for exactly that reason), and
// silently ignoring it reads as "my key doesn't work". No dependency: Node's own loader.
try {
  process.loadEnvFile?.(".env");
} catch {
  /* no .env here — shell environment still applies */
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// `--playwright-browsers-path <dir>` as an alternative to the PLAYWRIGHT_BROWSERS_PATH env
// var: some process supervisors (e.g. Warden/NSSM without AppEnvironmentExtra) can only pass
// command-line arguments, not per-service env vars.
const playwrightBrowsersPathArg = arg("playwright-browsers-path");
if (playwrightBrowsersPathArg) process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPathArg;

// `--claude-credentials <path>` as an alternative to SHOAL_CLAUDE_CREDENTIALS: points
// subscriptionAuth.ts at a specific .credentials.json, for the common case where `shoal
// serve` runs under a supervisor (Warden/NSSM) as a different account than the one logged
// in to Claude Code, so the default ~/.claude/.credentials.json resolves to the wrong home.
const claudeCredentialsArg = arg("claude-credentials");
if (claudeCredentialsArg) process.env.SHOAL_CLAUDE_CREDENTIALS = claudeCredentialsArg;

// Only run when executed directly (`node dist/cli.js ...`), not when imported by tests —
// cli.argparse.test.ts imports arg/args/serveOpts from cliMain.js instead, so this branch
// never fires under the test runner.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { main } = await import("./cliMain.js");
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
