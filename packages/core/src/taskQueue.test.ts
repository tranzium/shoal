import { test, expect, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShoalServer } from "./server.js";
import { TaskQueue } from "./taskQueue.js";
import { DataStore } from "./dataStore.js";
import type { RunOptions } from "./types.js";

// These tests exercise submit() with provider "anthropic" as a stand-in "happy path" — they
// aren't about credentials, so give them one for the duration of this file (submit() now
// checks live, see the "credentials" tests below for that behavior itself) and restore
// whatever was there afterward.
const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = savedAnthropicKey ?? "sk-test-taskqueue-fixture";

/** swarm: 0 means runSwarm resolves with zero agents — no browser ever launches. */
function baseOpts(): RunOptions {
  return {
    url: "",
    task: "",
    swarm: 0,
    concurrency: 4,
    provider: "anthropic",
    model: "claude-opus-5",
    effort: "medium",
    verify: false,
    maxSteps: 1,
    headless: true,
    mock: false,
    port: 0,
    open: false,
  };
}

async function withServer<T>(fn: (server: ShoalServer, queue: TaskQueue) => Promise<T>): Promise<T> {
  const server = new ShoalServer();
  await server.start(0);
  const queue = new TaskQueue(server, baseOpts());
  try {
    return await fn(server, queue);
  } finally {
    await server.stop();
  }
}

/** Like withServer, but with a DataStore (missions live in a throwaway temp dir) wired up
 *  so `mission` submissions can resolve. */
async function withMissionServer<T>(
  missions: Record<string, string>,
  fn: (server: ShoalServer, queue: TaskQueue) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "shoal-missions-"));
  const missionsDir = join(dir, "missions");
  mkdirSync(missionsDir);
  for (const [name, yaml] of Object.entries(missions)) {
    writeFileSync(join(missionsDir, `${name}.yaml`), yaml, "utf8");
  }
  const server = new ShoalServer();
  await server.start(0);
  server.dataStore = new DataStore(dir);
  const queue = new TaskQueue(server, baseOpts());
  try {
    return await fn(server, queue);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const cleanupIds: string[] = [];
afterAll(async () => {
  await Promise.all(
    cleanupIds.flatMap((id) => [
      rm(join(process.cwd(), "reports", `${id}.md`), { force: true }),
      rm(join(process.cwd(), "reports", `${id}.json`), { force: true }),
      rm(join(process.cwd(), "reports", `${id}.log`), { force: true }),
    ]),
  );
  if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
});

test("submit rejects a missing url or task with a 400-style error", async () => {
  await withServer(async (_server, queue) => {
    expect(queue.submit({ url: "", task: "do it" })).toEqual({ ok: false, error: "url is required" });
    expect(queue.submit({ url: "http://x/", task: "" })).toEqual({ ok: false, error: "task is required" });
    expect(queue.submit({ url: "not a url", task: "do it" }).ok).toBe(false);
  });
});

test("submit accepts a valid body and assigns a FIFO position", async () => {
  await withServer(async (_server, queue) => {
    const r1 = queue.submit({ url: "http://x/", task: "task one", swarm: 0 });
    expect(r1.ok).toBe(true);
    if (r1.ok) cleanupIds.push(r1.task.id);
    const r2 = queue.submit({ url: "http://x/", task: "task two", swarm: 0 });
    if (r2.ok) cleanupIds.push(r2.task.id);
    // task one starts synchronously (JS runs an async fn up to its first await), so by the
    // time submit() returns for task two, task two is still behind it in the queue.
    expect(r2.ok && r2.task.position).toBe(0);
  });
});

test("exactly one task runs at a time, in submission order", async () => {
  await withServer(async (_server, queue) => {
    const r1 = queue.submit({ url: "http://x/", task: "first", swarm: 0 });
    const r2 = queue.submit({ url: "http://x/", task: "second", swarm: 0 });
    if (!r1.ok || !r2.ok) throw new Error("submit failed");
    cleanupIds.push(r1.task.id, r2.task.id);

    // task one is already running (synchronous run-to-first-await); task two still queued.
    expect(queue.get(r1.task.id)?.status).toBe("running");
    expect(queue.get(r2.task.id)?.status).toBe("queued");

    await waitFor(() => queue.get(r2.task.id)?.status === "done");
    const t1 = queue.get(r1.task.id)!;
    const t2 = queue.get(r2.task.id)!;
    expect(t1.status).toBe("done");
    expect(t2.status).toBe("done");
    // second never started before the first finished
    expect(t2.startedAt!).toBeGreaterThanOrEqual(t1.finishedAt!);
  });
});

test("each task writes its own reports/<id>.md and .json", async () => {
  await withServer(async (_server, queue) => {
    const r = queue.submit({ url: "http://x/", task: "report me", title: "Report Me", swarm: 0 });
    if (!r.ok) throw new Error("submit failed");
    cleanupIds.push(r.task.id);
    await waitFor(() => queue.get(r.task.id)?.status === "done");
    const report = await queue.getReport(r.task.id);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.md).toContain("Report Me");
    expect(report.md).toContain(r.task.id);
    expect((report.json as { id: string }).id).toBe(r.task.id);
  });
});

test("cancel removes a still-queued task without running it", async () => {
  await withServer(async (_server, queue) => {
    const r1 = queue.submit({ url: "http://x/", task: "first", swarm: 0 });
    const r2 = queue.submit({ url: "http://x/", task: "second", swarm: 0 });
    if (!r1.ok || !r2.ok) throw new Error("submit failed");
    cleanupIds.push(r1.task.id, r2.task.id);

    expect(queue.cancel(r2.task.id)).toBe(true);
    expect(queue.get(r2.task.id)?.status).toBe("cancelled");

    await waitFor(() => queue.get(r1.task.id)?.status === "done");
    expect(queue.get(r2.task.id)?.status).toBe("cancelled");
  });
});

test("cancel aborts a running task", async () => {
  await withServer(async (_server, queue) => {
    const r = queue.submit({ url: "http://x/", task: "abort me", swarm: 0 });
    if (!r.ok) throw new Error("submit failed");
    cleanupIds.push(r.task.id);
    expect(queue.get(r.task.id)?.status).toBe("running");
    expect(queue.cancel(r.task.id)).toBe(true);
    await waitFor(() => queue.get(r.task.id)?.status === "cancelled");
  });
});

test("cancel on an unknown id returns false", async () => {
  await withServer(async (_server, queue) => {
    expect(queue.cancel("nope")).toBe(false);
  });
});

test("a login is carried out-of-band, not appended to the task text", async () => {
  await withServer(async (_server, queue) => {
    const r = queue.submit({
      url: "http://x/",
      task: "log in and check the order history",
      login: { email: "shopper@example.com", password: "hunter2-secret" },
      swarm: 0,
    });
    if (!r.ok) throw new Error("submit failed");
    cleanupIds.push(r.task.id);
    expect(queue.get(r.task.id)?.task).toBe("log in and check the order history");
    await waitFor(() => queue.get(r.task.id)?.status === "done");
    const report = await queue.getReport(r.task.id);
    expect(report.ok).toBe(true);
    if (report.ok) expect(report.md).not.toContain("hunter2-secret");
  });
});

test("submit expands a mission into url/task/swarm", async () => {
  await withMissionServer(
    { signup: "title: Signup\nurl: https://x.test/\ntask: sign up\nswarm: 3\n" },
    async (_server, queue) => {
      const r = queue.submit({ mission: "signup" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      cleanupIds.push(r.task.id);
      const t = queue.get(r.task.id)!;
      expect(t.url).toBe("https://x.test/");
      expect(t.task).toBe("sign up");
      expect(t.swarm).toBe(3);
      expect(t.title).toBe("Signup");
    },
  );
});

test("submit overrides mission defaults with fields also present in the body", async () => {
  await withMissionServer(
    { signup: "title: Signup\nurl: https://x.test/\ntask: sign up\nswarm: 3\n" },
    async (_server, queue) => {
      const r = queue.submit({ mission: "signup", url: "https://override.test/", swarm: 0 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      cleanupIds.push(r.task.id);
      const t = queue.get(r.task.id)!;
      expect(t.url).toBe("https://override.test/");
      expect(t.task).toBe("sign up"); // not overridden — inherited from the mission
      expect(t.swarm).toBe(0);
    },
  );
});

test("submit rejects an unknown mission name", async () => {
  await withMissionServer({}, async (_server, queue) => {
    expect(queue.submit({ mission: "does-not-exist" })).toEqual({ ok: false, error: "unknown mission: does-not-exist" });
  });
});

test("submit with a mission name but no data store attached is rejected, not a crash", async () => {
  await withServer(async (_server, queue) => {
    expect(queue.submit({ mission: "signup" }).ok).toBe(false);
  });
});

test("submit rejects an unknown strategy id when a data store is attached", async () => {
  await withMissionServer({}, async (_server, queue) => {
    const r = queue.submit({ url: "http://x/", task: "do it", strategy: "does-not-exist" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("does-not-exist");
  });
});

test("submit rejects unknown persona ids when a data store is attached", async () => {
  await withMissionServer({}, async (_server, queue) => {
    const r = queue.submit({ url: "http://x/", task: "do it", personas: ["not-a-real-persona"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not-a-real-persona");
  });
});

test("submit does not validate strategy/persona ids without a data store", async () => {
  await withServer(async (_server, queue) => {
    const r = queue.submit({ url: "http://x/", task: "do it", swarm: 0, strategy: "whatever", personas: ["whoever"] });
    expect(r.ok).toBe(true);
    if (r.ok) cleanupIds.push(r.task.id);
  });
});

test("submit rejects a task when the provider has no credentials", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await withServer(async (_server, queue) => {
      const r = queue.submit({ url: "http://x/", task: "do it", swarm: 1 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("ANTHROPIC_API_KEY");
    });
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("submit does not check credentials for a zero-agent task", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await withServer(async (_server, queue) => {
      const r = queue.submit({ url: "http://x/", task: "do it", swarm: 0 });
      expect(r.ok).toBe(true);
      if (r.ok) cleanupIds.push(r.task.id);
    });
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("submit accepts a start-only qa mission with no model creds, and its report carries the qa block", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await withMissionServer(
      {
        "qa-check":
          "title: QA Check\nurl: https://x.test/\ntask: check start state\nswarm: 0\nqa:\n  hosts: [x.test]\n  expect:\n    - id: home\n      kind: url\n      when: start\n      equals: /\n",
      },
      async (_server, queue) => {
        const r = queue.submit({ mission: "qa-check" });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        cleanupIds.push(r.task.id);
        await waitFor(() => queue.get(r.task.id)?.status === "done");
        const t = queue.get(r.task.id)!;
        expect(t.qaVerdict).toBeDefined();
        const report = await queue.getReport(r.task.id);
        expect(report.ok).toBe(true);
        if (report.ok) expect((report.json as { summary: { qa: unknown } }).summary.qa).toBeTruthy();
      },
    );
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("getReport distinguishes an unknown task from one with no report yet", async () => {
  await withServer(async (_server, queue) => {
    const unknown = await queue.getReport("nope");
    expect(unknown).toEqual({ ok: false, reason: "not_found" });

    const r = queue.submit({ url: "http://x/", task: "still running", swarm: 0 });
    if (!r.ok) throw new Error("submit failed");
    cleanupIds.push(r.task.id);
    const notReady = await queue.getReport(r.task.id);
    expect(notReady.ok).toBe(false);
    if (!notReady.ok) expect(notReady.reason).toBe("not_ready");
  });
});
