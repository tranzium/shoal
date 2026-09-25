import type {
  QaCheckStatus,
  QaConfig,
  QaExpectCheck,
  QaExpectationResult,
  QaGuardKind,
  QaGuardResult,
  QaReport,
  QaSessionResult,
  QaVerdict,
  TokenUsage,
} from "./types.js";

/**
 * QA mode's pure grading core: mission-`qa`-block validation, per-snapshot check evaluation,
 * per-session resolution, guard evaluation, cross-repeat aggregation, and the final
 * pass/fail/inconclusive verdict (+ its CLI exit code). No browser, no model call — every
 * function here takes literal data and returns a literal verdict, so it's unit-testable
 * without Chromium (see qa.test.ts). The browser-driving half (snapshot capture, navigation
 * fencing, the navigator loop, the judge call) lives in qaAgent.ts.
 */

const VALID_KINDS = new Set(["url", "text", "attr", "cookie", "judge"]);

export function validateQaConfig(raw: unknown, missionName: string): QaConfig {
  const q = raw as Record<string, unknown> | null;
  if (!q || typeof q !== "object") throw new Error(`mission "${missionName}": qa must be an object`);
  if (!Array.isArray(q.hosts) || q.hosts.length === 0 || !q.hosts.every((h) => typeof h === "string" && h.trim())) {
    throw new Error(`mission "${missionName}": qa.hosts must be a non-empty list of hostnames`);
  }
  if (!Array.isArray(q.expect) || q.expect.length === 0) {
    throw new Error(`mission "${missionName}": qa.expect must be a non-empty list`);
  }

  const seenIds = new Set<string>();
  const expect = q.expect.map((raw, i) => {
    const c = raw as Record<string, unknown>;
    const where = `mission "${missionName}", qa.expect[${i}]`;
    if (!c || typeof c.id !== "string" || !c.id.trim()) throw new Error(`${where}: needs a string id`);
    if (seenIds.has(c.id)) throw new Error(`mission "${missionName}": duplicate qa.expect id "${c.id}"`);
    seenIds.add(c.id);
    if (typeof c.kind !== "string" || !VALID_KINDS.has(c.kind)) {
      throw new Error(`${where} ("${c.id}"): kind must be one of url|text|attr|cookie|judge`);
    }
    const kind = c.kind as QaExpectCheck["kind"];
    const when: "start" | "reach" = c.when === "start" ? "start" : "reach";
    if (c.when !== undefined && c.when !== "start" && c.when !== "reach") {
      throw new Error(`${where} ("${c.id}"): when must be "start" or "reach"`);
    }
    const on = typeof c.on === "string" ? c.on : undefined;
    if (kind === "judge" && !on) throw new Error(`${where} ("${c.id}"): kind "judge" requires "on"`);
    if (when === "reach" && kind !== "url" && !on) {
      throw new Error(`${where} ("${c.id}"): reach checks require "on" (except kind "url")`);
    }

    const check: QaExpectCheck = { id: c.id, kind, when, on };
    if (typeof c.selector === "string") check.selector = c.selector;
    if (typeof c.equals === "string") check.equals = c.equals;
    if (typeof c.contains === "string") check.contains = c.contains;
    if (typeof c.absent === "boolean" || typeof c.absent === "string") check.absent = c.absent;
    if (c.query && typeof c.query === "object") check.query = c.query as Record<string, string>;
    if (typeof c.name === "string") check.name = c.name;
    if (typeof c.startsWith === "string") check.startsWith = c.startsWith;
    if (typeof c.value === "string") check.value = c.value;
    if (typeof c.ask === "string") check.ask = c.ask;
    if (typeof c.answer === "string") check.answer = c.answer;

    if (kind === "text" && check.equals === undefined && check.contains === undefined && check.absent === undefined) {
      throw new Error(`${where} ("${c.id}"): kind "text" needs equals, contains, or absent`);
    }
    if (kind === "attr") {
      if (!check.name) throw new Error(`${where} ("${c.id}"): kind "attr" needs name`);
      if (check.startsWith === undefined && check.equals === undefined) {
        throw new Error(`${where} ("${c.id}"): kind "attr" needs startsWith or equals`);
      }
    }
    if (kind === "cookie" && !check.name) throw new Error(`${where} ("${c.id}"): kind "cookie" needs name`);
    if (kind === "url" && check.equals === undefined && check.contains === undefined && !check.query) {
      throw new Error(`${where} ("${c.id}"): kind "url" needs equals, contains, or query`);
    }
    if (kind === "judge" && (!check.ask || !check.answer)) {
      throw new Error(`${where} ("${c.id}"): kind "judge" needs ask and answer`);
    }
    return check;
  });

  const config: QaConfig = { hosts: q.hosts as string[], expect };
  if (typeof q.maxSteps === "number") config.maxSteps = q.maxSteps;
  if (Array.isArray(q.ignore) && q.ignore.every((r) => typeof r === "string")) config.ignore = q.ignore as string[];
  return config;
}

// ---------------------------------------------------------------------------------------
// Snapshot evaluation
// ---------------------------------------------------------------------------------------

export interface QaSelectorResult {
  text: string;
  attrs: Record<string, string>;
}

/** One point-in-time capture of navigator state, taken after the start load and after every
 *  action. Pure data — the browser layer resolves it, qa.ts only reads it. */
export interface QaSnapshot {
  step: number;
  url: string;
  /** HTTP status of the last main-document response observed, if any. */
  docStatus: number | null;
  /** Whole-page innerText, capped at 20k chars. */
  bodyText: string;
  cookies: Record<string, string>;
  /** Keyed by the selector string a check asked for ("" = whole body). */
  selectors: Record<string, QaSelectorResult | null>;
  /** Base64 JPEG, when captured for this snapshot. */
  screenshot?: string;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Does this snapshot's page fall within the check's `on` scope? "url" checks have no scope
 *  gate of their own — they watch every snapshot for their destination. */
function inScope(check: QaExpectCheck, snapshot: QaSnapshot): boolean {
  if (check.kind === "url") return true;
  if (check.when === "start") return snapshot.step === 0;
  if (!check.on) return true;
  return pathOf(snapshot.url).startsWith(check.on);
}

function resolvedText(check: QaExpectCheck, snapshot: QaSnapshot): string | null {
  const sel = snapshot.selectors[check.selector ?? ""];
  return sel ? sel.text : null;
}

/** Evaluates one check against one snapshot. "n/a" = this snapshot's page is out of the
 *  check's scope (not a hit, not a miss — irrelevant to this check). */
export function evaluate(check: QaExpectCheck, snapshot: QaSnapshot): "hit" | "miss" | "n/a" {
  if (!inScope(check, snapshot)) return "n/a";

  switch (check.kind) {
    case "url": {
      const u = (() => {
        try {
          return new URL(snapshot.url);
        } catch {
          return null;
        }
      })();
      if (!u) return "miss";
      if (check.equals !== undefined && u.pathname !== check.equals) return "miss";
      if (check.contains !== undefined && !u.pathname.includes(check.contains)) return "miss";
      if (check.query) {
        for (const [k, v] of Object.entries(check.query)) {
          if (u.searchParams.get(k) !== v) return "miss";
        }
      }
      return "hit";
    }
    case "text": {
      const text = resolvedText(check, snapshot);
      if (check.absent !== undefined) {
        if (typeof check.absent === "string") {
          return text && text.toLowerCase().includes(check.absent.toLowerCase()) ? "miss" : "hit";
        }
        return !text || text.trim() === "" ? "hit" : "miss";
      }
      if (text === null) return "miss";
      if (check.equals !== undefined) return text.trim() === check.equals ? "hit" : "miss";
      if (check.contains !== undefined) return text.toLowerCase().includes(check.contains.toLowerCase()) ? "hit" : "miss";
      return "miss";
    }
    case "attr": {
      const sel = snapshot.selectors[check.selector ?? ""];
      const val = sel?.attrs[check.name!];
      if (val === undefined) return "miss";
      if (check.equals !== undefined) return val === check.equals ? "hit" : "miss";
      if (check.startsWith !== undefined) return val.startsWith(check.startsWith) ? "hit" : "miss";
      return "miss";
    }
    case "cookie": {
      const val = snapshot.cookies[check.name!];
      if (val === undefined) return "miss";
      if (check.value !== undefined) return val === check.value ? "hit" : "miss";
      return "hit";
    }
    case "judge":
      // Judge checks are graded by gradeJudgeChecks, not against a single snapshot.
      return "n/a";
    default:
      return "miss";
  }
}

function expectedLabel(check: QaExpectCheck): string {
  switch (check.kind) {
    case "url":
      return [
        check.equals ? `path = ${check.equals}` : check.contains ? `path contains ${check.contains}` : null,
        check.query ? `query ${JSON.stringify(check.query)}` : null,
      ]
        .filter(Boolean)
        .join(", ");
    case "text":
      return check.absent !== undefined
        ? `absent: ${check.absent === true ? "(selector/text empty)" : check.absent}`
        : check.equals !== undefined
          ? `equals "${check.equals}"`
          : `contains "${check.contains}"`;
    case "attr":
      return `${check.name} ${check.equals !== undefined ? `equals "${check.equals}"` : `startsWith "${check.startsWith}"`}`;
    case "cookie":
      return check.value !== undefined ? `cookie ${check.name}=${check.value}` : `cookie ${check.name} present`;
    case "judge":
      return `judge: "${check.ask}" → "${check.answer}"`;
  }
}

/**
 * Resolves every code-graded (non-judge) check across one session's ordered snapshots.
 * `start` checks grade only against snapshot 0. `reach` checks grade against every in-scope
 * snapshot: pass on the first hit; if the `on` page was visited but never hit, fail; if never
 * visited, not_reached (a navigator miss, not a site fact).
 */
export function resolveSession(checks: QaExpectCheck[], snapshots: QaSnapshot[]): QaExpectationResult[] {
  return checks
    .filter((c) => c.kind !== "judge")
    .map((check) => {
      let visited = false;
      for (const snap of snapshots) {
        const r = evaluate(check, snap);
        if (r === "n/a") continue;
        visited = true;
        if (r === "hit") {
          return {
            id: check.id,
            kind: check.kind,
            when: check.when ?? "reach",
            status: "pass" as QaCheckStatus,
            gradedBy: "code" as const,
            expected: expectedLabel(check),
            actual: resolvedActual(check, snap),
            evidence: { url: snap.url, step: snap.step, screenshot: snap.screenshot },
          };
        }
      }
      const status: QaCheckStatus = check.when === "start" ? "fail" : visited ? "fail" : "not_reached";
      return {
        id: check.id,
        kind: check.kind,
        when: check.when ?? "reach",
        status,
        gradedBy: "code" as const,
        expected: expectedLabel(check),
      };
    });
}

function resolvedActual(check: QaExpectCheck, snap: QaSnapshot): string | undefined {
  if (check.kind === "url") return snap.url;
  if (check.kind === "cookie") return snap.cookies[check.name!];
  if (check.kind === "attr") return snap.selectors[check.selector ?? ""]?.attrs[check.name!];
  if (check.kind === "text") return resolvedText(check, snap) ?? undefined;
  return undefined;
}

// ---------------------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------------------

export interface QaGuardEvent {
  kind: QaGuardKind;
  /** Hostname this event is attributed to (the response/page/console-message host). */
  host: string;
  text: string;
}

function hostAllowed(host: string, hosts: string[]): boolean {
  const h = host.toLowerCase();
  return hosts.some((d) => {
    const dd = d.toLowerCase().replace(/^\*\./, "");
    return h === dd || h.endsWith(`.${dd}`);
  });
}

function isIgnored(text: string, ignore: string[]): boolean {
  return ignore.some((pattern) => {
    const m = pattern.match(/^\/(.+)\/([a-z]*)$/);
    try {
      const re = m ? new RegExp(m[1], m[2]) : new RegExp(pattern, "i");
      return re.test(text);
    } catch {
      return text.toLowerCase().includes(pattern.toLowerCase());
    }
  });
}

const GUARD_KINDS: QaGuardKind[] = ["http", "pageerror", "console", "body"];

/** http/console guards are scoped to `hosts`; pageerror/body are not (they only ever fire
 *  on the current page, which the navigation fence already keeps within `hosts`). `ignore`
 *  drops matching evidence before grading, applied first. */
export function evaluateGuards(events: QaGuardEvent[], hosts: string[], ignore: string[] = []): QaGuardResult[] {
  return GUARD_KINDS.map((kind) => {
    const items = events
      .filter((e) => e.kind === kind)
      .filter((e) => (kind === "http" || kind === "console" ? hostAllowed(e.host, hosts) : true))
      .filter((e) => !isIgnored(e.text, ignore))
      .map((e) => e.text);
    return { kind, status: items.length > 0 ? ("fail" as const) : ("pass" as const), items };
  });
}

// ---------------------------------------------------------------------------------------
// Judge (quote verification only — the LLM call itself lives in qaAgent.ts)
// ---------------------------------------------------------------------------------------

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** A judge verdict is only trusted if its quote is verbatim (whitespace-normalized) present
 *  in the text the judge was actually shown — a missing/invented quote can't be trusted, so
 *  it downgrades to inconclusive regardless of what the model claimed. */
export function verifyJudgeQuote(quote: string, capturedText: string): boolean {
  if (!quote.trim()) return false;
  return normalizeWhitespace(capturedText).includes(normalizeWhitespace(quote));
}

export function resolveJudgeCheck(
  check: QaExpectCheck,
  visited: boolean,
  verdict?: { status: "pass" | "fail"; quote: string },
  capturedText?: string,
): QaExpectationResult {
  const base = { id: check.id, kind: check.kind, when: check.when ?? "reach", expected: expectedLabel(check) };
  if (!visited) return { ...base, status: "not_reached", gradedBy: "judge" };
  if (!verdict) return { ...base, status: "not_reached", gradedBy: "judge" };
  const quoteOk = verifyJudgeQuote(verdict.quote, capturedText ?? "");
  if (!quoteOk) return { ...base, status: "not_reached", gradedBy: "judge", actual: verdict.quote };
  return { ...base, status: verdict.status, gradedBy: "judge", actual: verdict.quote, evidence: { text: verdict.quote } };
}

// ---------------------------------------------------------------------------------------
// Cross-repeat aggregation + verdict
// ---------------------------------------------------------------------------------------

/** Per expectation id, across repeats: any fail -> fail; else any pass -> pass; else not_reached. */
export function aggregateExpectations(perRepeat: QaExpectationResult[][]): QaExpectationResult[] {
  const byId = new Map<string, QaExpectationResult[]>();
  for (const results of perRepeat) {
    for (const r of results) {
      if (!byId.has(r.id)) byId.set(r.id, []);
      byId.get(r.id)!.push(r);
    }
  }
  return [...byId.entries()].map(([, results]) => {
    const failed = results.find((r) => r.status === "fail");
    const passed = results.find((r) => r.status === "pass");
    const winner = failed ?? passed ?? results[0];
    return winner;
  });
}

/** Any guard failure in any repeat fails that guard kind for the mission. */
export function aggregateGuards(perRepeat: QaGuardResult[][]): QaGuardResult[] {
  return GUARD_KINDS.map((kind) => {
    const items = perRepeat.flatMap((guards) => guards.find((g) => g.kind === kind)?.items ?? []);
    return { kind, status: items.length > 0 ? ("fail" as const) : ("pass" as const), items: [...new Set(items)] };
  });
}

/** fail if any expectation or guard failed; else inconclusive if any not_reached; else pass. */
export function computeQaVerdict(expectations: QaExpectationResult[], guards: QaGuardResult[]): QaVerdict {
  if (expectations.some((e) => e.status === "fail") || guards.some((g) => g.status === "fail")) return "fail";
  if (expectations.some((e) => e.status === "not_reached")) return "inconclusive";
  return "pass";
}

/** exit code: 0 pass, 1 fail, 2 inconclusive, 3 could not run. */
export function exitCodeFor(verdict: QaVerdict | "could_not_run"): number {
  switch (verdict) {
    case "pass":
      return 0;
    case "fail":
      return 1;
    case "inconclusive":
      return 2;
    case "could_not_run":
      return 3;
  }
}

export function buildQaReport(
  mission: string,
  url: string,
  meta: { model?: string; repeats: number; startedAt: number; finishedAt: number; usage: TokenUsage },
  sessions: QaSessionResult[],
): QaReport {
  const expectations = aggregateExpectations(sessions.map((s) => s.expectations));
  const guards = aggregateGuards(sessions.map((s) => s.guards));
  const blockedNavigations = [...new Set(sessions.flatMap((s) => s.blockedNavigations))];
  return {
    mission,
    url,
    model: meta.model,
    repeats: meta.repeats,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    verdict: computeQaVerdict(expectations, guards),
    expectations,
    guards,
    blockedNavigations,
    usage: meta.usage,
  };
}

/** A qa mission needs no model/credentials at all when every check is graded purely from the
 *  start snapshot: no "reach" checks (which need the navigator to move) and no "judge" checks
 *  (which need an LLM call). Used to skip credential checks the same way a zero-swarm task does. */
export function qaNeedsCredentials(qa: QaConfig): boolean {
  return qa.expect.some((c) => c.kind === "judge" || (c.when ?? "reach") === "reach");
}
