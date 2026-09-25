import { test, expect, afterAll } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeTaskReport } from "./report.js";
import { redactFinding, redactText } from "./redact.js";
import type { Finding, RunOptions, RunSummary } from "./types.js";

function opts(): RunOptions {
  return {
    url: "http://x/",
    task: "sign in and check the order history",
    swarm: 1,
    concurrency: 1,
    provider: "anthropic",
    model: "claude-opus-5",
    effort: "medium",
    verify: false,
    maxSteps: 1,
    headless: true,
    mock: false,
    port: 0,
  };
}

function summary(): RunSummary {
  return {
    total: 1,
    completed: 1,
    gaveUp: 0,
    errored: 0,
    durationMs: 10,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
  };
}

const cleanupIds: string[] = [];
afterAll(async () => {
  await Promise.all(
    cleanupIds.flatMap((id) => [
      rm(join(process.cwd(), "reports", `${id}.md`), { force: true }),
      rm(join(process.cwd(), "reports", `${id}.json`), { force: true }),
    ]),
  );
});

test("redactText strips every occurrence of a secret", () => {
  expect(redactText("password is hunter2-secret, repeat: hunter2-secret", ["hunter2-secret"])).toBe(
    "password is [redacted], repeat: [redacted]",
  );
  expect(redactText("nothing to see here", [])).toBe("nothing to see here");
});

test("redactFinding scrubs title, description, and evidence", () => {
  const f: Finding = {
    agentId: "a-0",
    personaName: "tester",
    severity: "low",
    title: "used password hunter2-secret to sign in",
    description: "typed hunter2-secret into the password field",
    ts: Date.now(),
    evidence: { recent: ["action: typed hunter2-secret"] },
  };
  const safe = redactFinding(f, ["hunter2-secret"]);
  expect(safe.title).not.toContain("hunter2-secret");
  expect(safe.description).not.toContain("hunter2-secret");
  expect(safe.evidence!.recent[0]).not.toContain("hunter2-secret");
});

test("writeTaskReport writes reports/<id>.md and reports/<id>.json with the required header fields", async () => {
  const id = "test-report-1";
  cleanupIds.push(id);
  const meta = { id, title: "Checkout flow", startedAt: Date.now() - 5000, finishedAt: Date.now() };
  const { mdPath, jsonPath } = await writeTaskReport([], summary(), opts(), meta);
  expect(mdPath).toBe(join(process.cwd(), "reports", `${id}.md`));
  expect(jsonPath).toBe(join(process.cwd(), "reports", `${id}.json`));

  const md = await readFile(mdPath, "utf8");
  expect(md).toContain(id);
  expect(md).toContain("Checkout flow");
  expect(md).toContain(opts().url);
  expect(md).toContain(opts().task);

  const json = JSON.parse(await readFile(jsonPath, "utf8"));
  expect(json.id).toBe(id);
  expect(json.title).toBe("Checkout flow");
  expect(json.summary.total).toBe(1);
});

test("writeTaskReport records a failure's status and error in both the markdown and JSON report", async () => {
  const id = "test-report-failed";
  cleanupIds.push(id);
  const meta = {
    id,
    title: "Broken run",
    startedAt: Date.now() - 2000,
    finishedAt: Date.now(),
    status: "failed" as const,
    error: "No ANTHROPIC_API_KEY found.",
  };
  const failedSummary: RunSummary = { ...summary(), total: 0, completed: 0 };
  const { mdPath, jsonPath } = await writeTaskReport([], failedSummary, opts(), meta);

  const md = await readFile(mdPath, "utf8");
  expect(md).toContain("**Status:** failed — No ANTHROPIC_API_KEY found.");

  const json = JSON.parse(await readFile(jsonPath, "utf8"));
  expect(json.status).toBe("failed");
  expect(json.error).toBe("No ANTHROPIC_API_KEY found.");
});

test("writeTaskReport redacts a supplied secret from both the markdown and JSON report", async () => {
  const id = "test-report-2";
  cleanupIds.push(id);
  const secret = "hunter2-secret";
  const findings: Finding[] = [
    {
      agentId: "a-0",
      personaName: "tester",
      severity: "low",
      title: `used password ${secret} to sign in`,
      description: `typed ${secret} into the password field`,
      ts: Date.now(),
    },
  ];
  const meta = { id, title: "Login check", startedAt: Date.now() - 1000, finishedAt: Date.now() };
  const { mdPath, jsonPath } = await writeTaskReport(findings, summary(), opts(), meta, [secret]);

  const md = await readFile(mdPath, "utf8");
  expect(md).not.toContain(secret);

  const jsonRaw = await readFile(jsonPath, "utf8");
  expect(jsonRaw).not.toContain(secret);
});
