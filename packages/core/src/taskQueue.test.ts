import { test, expect, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ShoalServer } from "./server.js";
import { TaskQueue } from "./taskQueue.js";
import type { RunOptions } from "./types.js";

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
    ]),
  );
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
    expect(report).toBeDefined();
    expect(report!.md).toContain("Report Me");
    expect(report!.md).toContain(r.task.id);
    expect((report!.json as { id: string }).id).toBe(r.task.id);
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
    expect(report!.md).not.toContain("hunter2-secret");
  });
});
