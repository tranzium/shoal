import type { CapturedError, ReproVerdict } from "./types.js";

/**
 * Repro mode: matches captured browser errors against `RunOptions.expect` and merges
 * per-agent capture lists into one task-level view. Split out from browser.ts/orchestrator.ts
 * so the matching and dedupe logic is unit-testable without a real browser.
 */

/** `/pattern/flags` is treated as a regex; anything else is a case-insensitive substring match. */
export function matchExpect(expect: string, text: string): boolean {
  const asRegex = expect.match(/^\/(.+)\/([a-z]*)$/);
  if (asRegex) {
    try {
      return new RegExp(asRegex[1], asRegex[2]).test(text);
    } catch {
      // Malformed regex — fall through to a literal match on the whole expect string.
    }
  }
  return text.toLowerCase().includes(expect.toLowerCase());
}

/** Merge capture lists from every agent in the swarm, deduping by (source, text) and
 *  summing counts. Keeps the smallest firstStep across agents that hit the same error. */
export function mergeCapturedErrors(perAgent: (CapturedError[] | undefined)[]): CapturedError[] {
  const byKey = new Map<string, CapturedError>();
  for (const list of perAgent) {
    for (const e of list ?? []) {
      const key = `${e.source}:${e.text}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.count += e.count;
        existing.firstStep = Math.min(existing.firstStep, e.firstStep);
      } else {
        byKey.set(key, { ...e });
      }
    }
  }
  return [...byKey.values()];
}

/**
 * The reproduction verdict for a task with `expect` set:
 *  - "reproduced": a captured error matched.
 *  - "inconclusive": nothing matched, but at least one agent errored out (crashed) before
 *    it could reasonably be said to have exercised the extension — the run doesn't tell us
 *    the fix worked, only that this attempt didn't prove the bug either way.
 *  - "not_reproduced": nothing matched and every agent completed its session normally.
 */
export function computeVerdict(
  expect: string,
  errors: CapturedError[],
  agentErrored: boolean,
): { status: ReproVerdict; evidence: string[] } {
  const matches = errors.filter((e) => matchExpect(expect, e.text));
  if (matches.length > 0) {
    return {
      status: "reproduced",
      evidence: matches.map((e) => `[${e.source}] ${e.text} (×${e.count}, first seen step ${e.firstStep})`),
    };
  }
  return { status: agentErrored ? "inconclusive" : "not_reproduced", evidence: [] };
}
