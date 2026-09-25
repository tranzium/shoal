import { readFileSync } from "node:fs";
import { homedir } from "node:os";
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

const CREDS_PATH = join(homedir(), ".claude", ".credentials.json");

export function readSubscriptionCreds(): SubCreds {
  let raw: string;
  try {
    raw = readFileSync(CREDS_PATH, "utf8");
  } catch {
    throw new Error(
      `No Claude Code credentials at ${CREDS_PATH}. ` +
        `Log in to Claude Code first (it uses your Pro/Max subscription), or use --provider anthropic with an API key.`,
    );
  }

  const oauth = JSON.parse(raw)?.claudeAiOauth;
  if (!oauth?.accessToken) {
    throw new Error(
      "Claude Code credentials found, but no subscription token in them. " +
        "If you logged in with an API key, use --provider anthropic instead.",
    );
  }
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt < Date.now()) {
    throw new Error(
      "Your Claude Code subscription token has expired. " +
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

/** True if Claude Code subscription creds are present and unexpired (for CLI preflight). */
export function hasSubscription(): boolean {
  try {
    readSubscriptionCreds();
    return true;
  } catch {
    return false;
  }
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
  if (provider === "subscription" && !hasSubscription()) {
    return "--provider subscription needs a logged-in Claude Code (Pro/Max) session — run any Claude Code command (or /login) to refresh it, then retry.";
  }
  return null;
}
