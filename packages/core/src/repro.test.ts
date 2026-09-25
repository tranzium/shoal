import { test, expect } from "bun:test";
import { matchExpect, mergeCapturedErrors, computeVerdict } from "./repro.js";
import type { CapturedError } from "./types.js";

test("matchExpect does a case-insensitive substring match by default", () => {
  expect(matchExpect("cannot read properties", "TypeError: Cannot read properties of undefined")).toBe(true);
  expect(matchExpect("nope", "TypeError: Cannot read properties of undefined")).toBe(false);
});

test("matchExpect treats /pattern/flags as a regex", () => {
  expect(matchExpect("/TypeError.*undefined/", "TypeError: Cannot read properties of undefined")).toBe(true);
  expect(matchExpect("/typeerror/i", "TypeError: boom")).toBe(true);
  expect(matchExpect("/typeerror/", "TypeError: boom")).toBe(false); // no 'i' flag
});

test("matchExpect falls back to a literal match on a malformed regex", () => {
  expect(matchExpect("/[unterminated/", "text containing /[unterminated/ verbatim")).toBe(true);
  expect(matchExpect("/[unterminated/", "nope")).toBe(false);
});

test("mergeCapturedErrors dedupes by (source, text) across agents, summing counts and keeping the earliest step", () => {
  const agentA: CapturedError[] = [{ source: "console", text: "boom", count: 2, firstStep: 3 }];
  const agentB: CapturedError[] = [
    { source: "console", text: "boom", count: 1, firstStep: 1 },
    { source: "pageerror", text: "boom", count: 1, firstStep: 5 }, // different source — not merged with the console one
  ];
  const merged = mergeCapturedErrors([agentA, agentB, undefined]);
  expect(merged).toHaveLength(2);
  const consoleBoom = merged.find((e) => e.source === "console")!;
  expect(consoleBoom.count).toBe(3);
  expect(consoleBoom.firstStep).toBe(1);
  const pageerrorBoom = merged.find((e) => e.source === "pageerror")!;
  expect(pageerrorBoom.count).toBe(1);
});

test("computeVerdict reports reproduced with matching evidence when expect matches a captured error", () => {
  const errors: CapturedError[] = [
    { source: "extension", text: "Uncaught TypeError: chrome.runtime is undefined", count: 3, firstStep: 2 },
    { source: "console", text: "unrelated warning", count: 1, firstStep: 1 },
  ];
  const v = computeVerdict("chrome.runtime is undefined", errors, false);
  expect(v.status).toBe("reproduced");
  expect(v.evidence).toHaveLength(1);
  expect(v.evidence[0]).toContain("chrome.runtime is undefined");
  expect(v.evidence[0]).toContain("×3");
  expect(v.evidence[0]).toContain("step 2");
});

test("computeVerdict reports not_reproduced when nothing matches and no agent errored", () => {
  const errors: CapturedError[] = [{ source: "console", text: "unrelated", count: 1, firstStep: 1 }];
  expect(computeVerdict("does not appear", errors, false).status).toBe("not_reproduced");
});

test("computeVerdict reports inconclusive when nothing matches but an agent crashed", () => {
  expect(computeVerdict("does not appear", [], true).status).toBe("inconclusive");
});
