import { test, expect } from "bun:test";
import {
  validateQaConfig,
  evaluate,
  resolveSession,
  evaluateGuards,
  aggregateExpectations,
  aggregateGuards,
  computeQaVerdict,
  exitCodeFor,
  verifyJudgeQuote,
  resolveJudgeCheck,
  qaNeedsCredentials,
  type QaSnapshot,
  type QaGuardEvent,
} from "./qa.js";
import type { QaExpectCheck, QaExpectationResult, QaGuardResult } from "./types.js";

// ---------------------------------------------------------------------------------------
// validateQaConfig
// ---------------------------------------------------------------------------------------

test("validateQaConfig requires hosts", () => {
  expect(() => validateQaConfig({ expect: [{ id: "a", kind: "url", when: "start", equals: "/x/" }] }, "m")).toThrow(
    /hosts/,
  );
});

test("validateQaConfig rejects duplicate ids", () => {
  const raw = {
    hosts: ["x.test"],
    expect: [
      { id: "a", kind: "url", when: "start", equals: "/x/" },
      { id: "a", kind: "url", when: "start", equals: "/y/" },
    ],
  };
  expect(() => validateQaConfig(raw, "m")).toThrow(/duplicate/);
});

test("validateQaConfig rejects an unknown kind", () => {
  const raw = { hosts: ["x.test"], expect: [{ id: "a", kind: "bogus", when: "start" }] };
  expect(() => validateQaConfig(raw, "m")).toThrow(/kind/);
});

test("validateQaConfig requires 'on' for reach checks except kind url", () => {
  const raw = { hosts: ["x.test"], expect: [{ id: "a", kind: "text", when: "reach", equals: "hi" }] };
  expect(() => validateQaConfig(raw, "m")).toThrow(/on/);
  const okUrl = { hosts: ["x.test"], expect: [{ id: "a", kind: "url", when: "reach", equals: "/y/" }] };
  expect(() => validateQaConfig(okUrl, "m")).not.toThrow();
});

test("validateQaConfig requires 'on' for judge checks", () => {
  const raw = { hosts: ["x.test"], expect: [{ id: "a", kind: "judge", ask: "q", answer: "yes" }] };
  expect(() => validateQaConfig(raw, "m")).toThrow(/on/);
});

test("validateQaConfig accepts a well-formed config with defaults filled in", () => {
  const cfg = validateQaConfig(
    {
      hosts: ["x.test", "static.x.test"],
      expect: [
        { id: "price", when: "start", kind: "text", selector: ".price", equals: "$1" },
        { id: "yearly", on: "/pricing/", kind: "text", selector: ".price", equals: "$10" },
      ],
    },
    "m",
  );
  expect(cfg.hosts).toEqual(["x.test", "static.x.test"]);
  expect(cfg.expect[0].when).toBe("start");
  expect(cfg.expect[1].when).toBe("reach"); // default
  expect(cfg.maxSteps).toBeUndefined();
});

// ---------------------------------------------------------------------------------------
// evaluate — one check against a literal snapshot
// ---------------------------------------------------------------------------------------

function snap(over: Partial<QaSnapshot> = {}): QaSnapshot {
  return {
    step: 0,
    url: "https://site.test/pricing/",
    docStatus: 200,
    bodyText: "",
    cookies: {},
    selectors: {},
    ...over,
  };
}

test("evaluate: url kind checks path equals", () => {
  const check: QaExpectCheck = { id: "a", kind: "url", when: "reach", equals: "/pricing/" };
  expect(evaluate(check, snap({ url: "https://site.test/pricing/" }))).toBe("hit");
  expect(evaluate(check, snap({ url: "https://site.test/other/" }))).toBe("miss");
});

test("evaluate: url kind checks query params", () => {
  const check: QaExpectCheck = { id: "a", kind: "url", when: "reach", equals: "/pricing/", query: { aff: "Q1" } };
  expect(evaluate(check, snap({ url: "https://site.test/pricing/?aff=Q1" }))).toBe("hit");
  expect(evaluate(check, snap({ url: "https://site.test/pricing/?aff=Q2" }))).toBe("miss");
  expect(evaluate(check, snap({ url: "https://site.test/pricing/" }))).toBe("miss");
});

test("evaluate: text kind equals/contains against a selector", () => {
  const equalsCheck: QaExpectCheck = { id: "a", kind: "text", when: "reach", on: "/pricing/", selector: ".amt", equals: "$39.99" };
  const s = snap({ selectors: { ".amt": { text: "$39.99", attrs: {} } } });
  expect(evaluate(equalsCheck, s)).toBe("hit");
  expect(evaluate(equalsCheck, snap({ selectors: { ".amt": { text: "$40", attrs: {} } } }))).toBe("miss");

  const containsCheck: QaExpectCheck = { id: "b", kind: "text", when: "reach", on: "/pricing/", contains: "hello" };
  expect(evaluate(containsCheck, snap({ selectors: { "": { text: "well hello there", attrs: {} } } }))).toBe("hit");
});

test("evaluate: text kind absent=true means selector missing or empty", () => {
  const check: QaExpectCheck = { id: "a", kind: "text", when: "start", selector: "#grid", absent: true };
  expect(evaluate(check, snap({ selectors: { "#grid": null } }))).toBe("hit");
  expect(evaluate(check, snap({ selectors: { "#grid": { text: "  ", attrs: {} } } }))).toBe("hit");
  expect(evaluate(check, snap({ selectors: { "#grid": { text: "Loading…", attrs: {} } } }))).toBe("miss");
});

test("evaluate: text kind absent=<string> means that text must not appear", () => {
  const check: QaExpectCheck = { id: "a", kind: "text", when: "start", selector: "#grid", absent: "Loading exchanges" };
  expect(evaluate(check, snap({ selectors: { "#grid": { text: "BTC/USD 50000", attrs: {} } } }))).toBe("hit");
  expect(evaluate(check, snap({ selectors: { "#grid": { text: "Loading exchanges…", attrs: {} } } }))).toBe("miss");
});

test("evaluate: attr kind startsWith/equals", () => {
  const check: QaExpectCheck = { id: "a", kind: "attr", when: "start", selector: "a.out", name: "href", startsWith: "https://partner.test/" };
  expect(evaluate(check, snap({ selectors: { "a.out": { text: "", attrs: { href: "https://partner.test/x" } } } }))).toBe("hit");
  expect(evaluate(check, snap({ selectors: { "a.out": { text: "", attrs: { href: "https://other.test/" } } } }))).toBe("miss");
  expect(evaluate(check, snap({ selectors: { "a.out": null } }))).toBe("miss");
});

test("evaluate: cookie kind presence and exact value", () => {
  const presence: QaExpectCheck = { id: "a", kind: "cookie", when: "start", name: "daffiliate" };
  expect(evaluate(presence, snap({ cookies: { daffiliate: "Q1" } }))).toBe("hit");
  expect(evaluate(presence, snap({ cookies: {} }))).toBe("miss");

  const exact: QaExpectCheck = { id: "b", kind: "cookie", when: "start", name: "daffiliate", value: "Q1" };
  expect(evaluate(exact, snap({ cookies: { daffiliate: "Q1" } }))).toBe("hit");
  expect(evaluate(exact, snap({ cookies: { daffiliate: "Q2" } }))).toBe("miss");
});

test("evaluate: n/a when the snapshot's page is out of the check's 'on' scope", () => {
  const check: QaExpectCheck = { id: "a", kind: "text", when: "reach", on: "/register/", equals: "x" };
  expect(evaluate(check, snap({ url: "https://site.test/pricing/" }))).toBe("n/a");
});

test("evaluate: start checks only apply to step 0", () => {
  const check: QaExpectCheck = { id: "a", kind: "text", when: "start", equals: "x" };
  expect(evaluate(check, snap({ step: 0, selectors: { "": { text: "x", attrs: {} } } }))).toBe("hit");
  expect(evaluate(check, snap({ step: 1, selectors: { "": { text: "x", attrs: {} } } }))).toBe("n/a");
});

// ---------------------------------------------------------------------------------------
// resolveSession — resolution across an ordered snapshot sequence
// ---------------------------------------------------------------------------------------

test("resolveSession: a start check that misses fails", () => {
  const checks: QaExpectCheck[] = [{ id: "a", kind: "text", when: "start", selector: ".price", equals: "$39.99" }];
  const snapshots = [snap({ step: 0, selectors: { ".price": { text: "$40", attrs: {} } } })];
  const result = resolveSession(checks, snapshots);
  expect(result[0].status).toBe("fail");
  expect(result[0].gradedBy).toBe("code");
});

test("resolveSession: a reach check whose page was visited but never hit fails", () => {
  const checks: QaExpectCheck[] = [{ id: "a", kind: "text", when: "reach", on: "/pricing/", selector: ".price", equals: "$399.99" }];
  const snapshots = [
    snap({ step: 0, url: "https://site.test/pricing/", selectors: { ".price": { text: "$39.99", attrs: {} } } }),
    snap({ step: 1, url: "https://site.test/pricing/", selectors: { ".price": { text: "$39.99", attrs: {} } } }),
  ];
  expect(resolveSession(checks, snapshots)[0].status).toBe("fail");
});

test("resolveSession: a reach check whose page was never visited is not_reached", () => {
  const checks: QaExpectCheck[] = [{ id: "a", kind: "text", when: "reach", on: "/register/", equals: "x" }];
  const snapshots = [snap({ step: 0, url: "https://site.test/pricing/" })];
  expect(resolveSession(checks, snapshots)[0].status).toBe("not_reached");
});

test("resolveSession: a reach check passes on its first hit and records evidence", () => {
  const checks: QaExpectCheck[] = [{ id: "a", kind: "text", when: "reach", on: "/pricing/", selector: ".price", equals: "$399.99" }];
  const snapshots = [
    snap({ step: 0, url: "https://site.test/pricing/", selectors: { ".price": { text: "$39.99", attrs: {} } } }),
    snap({ step: 1, url: "https://site.test/pricing/", selectors: { ".price": { text: "$399.99", attrs: {} } } }),
  ];
  const result = resolveSession(checks, snapshots)[0];
  expect(result.status).toBe("pass");
  expect(result.evidence?.step).toBe(1);
  expect(result.actual).toBe("$399.99");
});

// ---------------------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------------------

test("evaluateGuards: http/console scoped to hosts; unlisted hosts don't fail the guard", () => {
  const events: QaGuardEvent[] = [
    { kind: "http", host: "site.test", text: "GET /x — 500" },
    { kind: "http", host: "some-cdn.example", text: "GET /y — 404" },
  ];
  const guards = evaluateGuards(events, ["site.test"]);
  const http = guards.find((g) => g.kind === "http")!;
  expect(http.status).toBe("fail");
  expect(http.items).toEqual(["GET /x — 500"]);
});

test("evaluateGuards: ignore drops matching evidence before grading", () => {
  const events: QaGuardEvent[] = [{ kind: "console", host: "site.test", text: "posthog tracking blocked" }];
  const guards = evaluateGuards(events, ["site.test"], ["/posthog/i"]);
  expect(guards.find((g) => g.kind === "console")!.status).toBe("pass");
});

test("evaluateGuards: pageerror and body guards apply without host scoping", () => {
  const events: QaGuardEvent[] = [
    { kind: "pageerror", host: "site.test", text: "TypeError: boom" },
    { kind: "body", host: "site.test", text: "Worker threw exception" },
  ];
  const guards = evaluateGuards(events, ["other.test"]);
  expect(guards.find((g) => g.kind === "pageerror")!.status).toBe("fail");
  expect(guards.find((g) => g.kind === "body")!.status).toBe("fail");
});

test("evaluateGuards: no events means every kind passes with empty items", () => {
  const guards = evaluateGuards([], ["site.test"]);
  expect(guards).toHaveLength(4);
  expect(guards.every((g) => g.status === "pass" && g.items.length === 0)).toBe(true);
});

// ---------------------------------------------------------------------------------------
// Aggregation + verdict + exit code
// ---------------------------------------------------------------------------------------

function expectation(over: Partial<QaExpectationResult>): QaExpectationResult {
  return { id: "a", kind: "text", when: "reach", status: "pass", gradedBy: "code", expected: "x", ...over };
}

test("aggregateExpectations: any fail beats any pass", () => {
  const perRepeat = [[expectation({ status: "pass" })], [expectation({ status: "fail" })]];
  expect(aggregateExpectations(perRepeat)[0].status).toBe("fail");
});

test("aggregateExpectations: any pass beats not_reached when nothing failed", () => {
  const perRepeat = [[expectation({ status: "not_reached" })], [expectation({ status: "pass" })]];
  expect(aggregateExpectations(perRepeat)[0].status).toBe("pass");
});

test("aggregateExpectations: all not_reached stays not_reached", () => {
  const perRepeat = [[expectation({ status: "not_reached" })], [expectation({ status: "not_reached" })]];
  expect(aggregateExpectations(perRepeat)[0].status).toBe("not_reached");
});

function guard(over: Partial<QaGuardResult>): QaGuardResult {
  return { kind: "http", status: "pass", items: [], ...over };
}

test("aggregateGuards: any repeat's failure fails the guard for the mission, items deduped", () => {
  const perRepeat = [
    [guard({ kind: "http", status: "fail", items: ["500 on /x"] })],
    [guard({ kind: "http", status: "fail", items: ["500 on /x"] })],
  ];
  const agg = aggregateGuards(perRepeat);
  expect(agg.find((g) => g.kind === "http")!.status).toBe("fail");
  expect(agg.find((g) => g.kind === "http")!.items).toEqual(["500 on /x"]);
});

test("computeQaVerdict: fail beats inconclusive beats pass", () => {
  expect(computeQaVerdict([expectation({ status: "pass" })], [guard({ status: "pass" })])).toBe("pass");
  expect(computeQaVerdict([expectation({ status: "not_reached" })], [guard({ status: "pass" })])).toBe("inconclusive");
  expect(computeQaVerdict([expectation({ status: "fail" })], [guard({ status: "pass" })])).toBe("fail");
  expect(computeQaVerdict([expectation({ status: "not_reached" })], [guard({ status: "fail" })])).toBe("fail");
});

test("exitCodeFor maps verdicts to the documented exit codes", () => {
  expect(exitCodeFor("pass")).toBe(0);
  expect(exitCodeFor("fail")).toBe(1);
  expect(exitCodeFor("inconclusive")).toBe(2);
  expect(exitCodeFor("could_not_run")).toBe(3);
});

// ---------------------------------------------------------------------------------------
// Judge quote verification
// ---------------------------------------------------------------------------------------

test("verifyJudgeQuote passes a real, whitespace-normalized substring", () => {
  const captured = "Yes — testnet and demo\naccounts are always free to use.";
  expect(verifyJudgeQuote("testnet and demo accounts are always free", captured)).toBe(true);
});

test("verifyJudgeQuote fails an invented quote", () => {
  expect(verifyJudgeQuote("accounts cost $5/month", "Yes, testnet accounts are free.")).toBe(false);
});

test("resolveJudgeCheck: an invented quote downgrades to not_reached even if the model said pass", () => {
  const check: QaExpectCheck = { id: "a", kind: "judge", on: "/pricing/", ask: "free?", answer: "yes" };
  const result = resolveJudgeCheck(check, true, { status: "pass", quote: "totally made up text" }, "the real captured page text");
  expect(result.status).toBe("not_reached");
});

test("resolveJudgeCheck: a verified quote carries the model's verdict through", () => {
  const check: QaExpectCheck = { id: "a", kind: "judge", on: "/pricing/", ask: "free?", answer: "yes" };
  const result = resolveJudgeCheck(check, true, { status: "pass", quote: "demo accounts are free" }, "Our demo accounts are free forever.");
  expect(result.status).toBe("pass");
});

test("resolveJudgeCheck: an unvisited 'on' page is not_reached", () => {
  const check: QaExpectCheck = { id: "a", kind: "judge", on: "/pricing/", ask: "free?", answer: "yes" };
  expect(resolveJudgeCheck(check, false).status).toBe("not_reached");
});

// ---------------------------------------------------------------------------------------
// qaNeedsCredentials
// ---------------------------------------------------------------------------------------

test("qaNeedsCredentials: false when every check is a start check with no judge", () => {
  expect(qaNeedsCredentials({ hosts: ["x.test"], expect: [{ id: "a", kind: "text", when: "start", equals: "x" }] })).toBe(false);
});

test("qaNeedsCredentials: true when any check is 'reach'", () => {
  expect(
    qaNeedsCredentials({ hosts: ["x.test"], expect: [{ id: "a", kind: "url", when: "reach", equals: "/x/" }] }),
  ).toBe(true);
});

test("qaNeedsCredentials: true when any check is a judge check, even 'start'", () => {
  expect(
    qaNeedsCredentials({ hosts: ["x.test"], expect: [{ id: "a", kind: "judge", when: "start", on: "/x/", ask: "q", answer: "a" }] }),
  ).toBe(true);
});
