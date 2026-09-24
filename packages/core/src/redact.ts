import type { Finding } from "./types.js";

/**
 * Login credentials are passed to agents out-of-band (never appended to the task text),
 * but an agent can still narrate them back in a thought or finding. This is the backstop:
 * strip any exact match of a secret from outgoing text before it reaches a log, a WS
 * event, or a report.
 */
export function redactText(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join("[redacted]");
  }
  return out;
}

export function redactFinding(f: Finding, secrets: string[]): Finding {
  if (secrets.length === 0) return f;
  return {
    ...f,
    title: redactText(f.title, secrets),
    description: redactText(f.description, secrets),
    evidence: f.evidence
      ? { ...f.evidence, recent: f.evidence.recent.map((r) => redactText(r, secrets)) }
      : undefined,
  };
}
