import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

/**
 * Reads the Claude Code / Pro-Max subscription token so the swarm can run on the
 * developer's existing subscription instead of a metered API key.
 *
 * The token rotates every few hours, so this is read LIVE (per agent start), never
 * cached — Claude Code keeps the file refreshed while it's in use. The swarm draws on
 * the same rate pool as the developer's own Claude Code usage, which is why
 * subscription mode runs at low concurrency with patient retries (see cli.ts).
 */

export interface SubCreds {
  token: string;
  subscriptionType: string; // "max" | "pro" | ...
  tier: string; // e.g. "default_claude_max_5x"
  expiresAt: number;
}

/**
 * Resolved on every call, never cached in a module-level const: `--claude-credentials`
 * (cli.ts turns it into SHOAL_CLAUDE_CREDENTIALS) and `.env` are both only available
 * after this module has already been imported, so a value baked in at import time would
 * silently ignore either override. Precedence: explicit override, then Claude Code's own
 * CLAUDE_CONFIG_DIR, then the default `~/.claude`. This matters most when shoal serve runs
 * under a process supervisor (Warden/NSSM) as a different Windows/Unix account than the
 * one logged in to Claude Code — homedir() then resolves to the service account's home,
 * not the developer's.
 */
function credsPath(): string {
  if (process.env.SHOAL_CLAUDE_CREDENTIALS) return process.env.SHOAL_CLAUDE_CREDENTIALS;
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(configDir, ".credentials.json");
}

export function readSubscriptionCreds(): SubCreds {
  const path = credsPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `No Claude Code credentials at ${path} (running as ${userInfo().username}). ` +
        `Log in to Claude Code first (it uses your Pro/Max subscription), point at the right ` +
        `file with --claude-credentials <path> or SHOAL_CLAUDE_CREDENTIALS if shoal is running ` +
        `as a different user, or use --provider anthropic with an API key.`,
    );
  }

  const oauth = JSON.parse(raw)?.claudeAiOauth;
  if (!oauth?.accessToken) {
    throw new Error(
      `Claude Code credentials found at ${path}, but no subscription token in them. ` +
        "If you logged in with an API key, use --provider anthropic instead.",
    );
  }
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt < Date.now()) {
    throw new Error(
      `Your Claude Code subscription token at ${path} has expired. ` +
        "Run any Claude Code command (or /login) to refresh it, then retry shoal.",
    );
  }

  return {
    token: oauth.accessToken,
    subscriptionType: oauth.subscriptionType ?? "unknown",
    tier: oauth.rateLimitTier ?? "unknown",
    expiresAt: oauth.expiresAt ?? 0,
  };
}

/**
 * Whether the given provider can actually run right now — same checks `shoal run`/`demo`
 * already gate on in `main()`, factored out so `shoal serve` (which has no terminal to
 * refuse a task at) and the task queue (which re-checks per submission, since a subscription
 * token rotates hourly and can expire under a long-lived service) can both use them.
 * Returns a human-readable reason, or null when the provider is ready.
 */
export function credentialsError(provider: "anthropic" | "openai" | "subscription"): string | null {
  if (provider === "anthropic" && !(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)) {
    return "No ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / ant profile) found. On a Claude Pro/Max plan, use --provider subscription instead.";
  }
  if (provider === "openai" && !(process.env.OPENAI_API_KEY || process.env.SHOAL_OPENAI_API_KEY)) {
    return "--provider openai needs OPENAI_API_KEY (or SHOAL_OPENAI_API_KEY).";
  }
  if (provider === "subscription") {
    try {
      readSubscriptionCreds();
    } catch (err) {
      return (err as Error).message;
    }
  }
  return null;
}
