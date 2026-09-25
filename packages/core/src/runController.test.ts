import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunController } from "./runController.js";
import type { RunOptions } from "./types.js";

/** swarm: 0 means runSwarm resolves with zero agents — no browser ever launches. */
function testOpts(): RunOptions {
  return {
    url: "",
    task: "test task",
    swarm: 0,
    concurrency: 1,
    provider: "anthropic",
    model: "claude-opus-5",
    effort: "medium",
    verify: false,
    maxSteps: 1,
    headless: true,
    mock: false,
    port: 0,
    open: false, // never spawn a real browser window in tests
  };
}

test("serve (runImmediately: false) starts the server in idle with no swarm", async () => {
  const rc = new RunController(testOpts());
  await rc.start(false);
  try {
    const port = (rc as unknown as { server: { port: number } }).server.port;
    const res = await fetch(`http://localhost:${port}/api/health`);
    const body = await res.json();
    expect(body.phase).toBe("idle");
    expect(body.runId).toBeNull();
  } finally {
    await rc.shutdown();
  }
});

test("restart drives idle -> running -> finished and increments the run id", async () => {
  const rc = new RunController(testOpts());
  await rc.start(false);
  try {
    const controller = rc as unknown as {
      server: { port: number };
      handle: (cmd: { cmd: "restart"; swarm?: number }) => Promise<void>;
    };
    // /api/health reports "idle" once a run finishes (the service is ready for the next
    // restart), even though runId keeps the last completed run number.
    await controller.handle({ cmd: "restart", swarm: 0 });
    const res1 = await fetch(`http://localhost:${controller.server.port}/api/health`);
    const body1 = await res1.json();
    expect(body1.phase).toBe("idle");
    expect(body1.runId).toBe(1);

    await controller.handle({ cmd: "restart", swarm: 0 });
    const res2 = await fetch(`http://localhost:${controller.server.port}/api/health`);
    const body2 = await res2.json();
    expect(body2.phase).toBe("idle");
    expect(body2.runId).toBe(2);
  } finally {
    await rc.shutdown();
  }
});

test("--data threads through: a custom strategies.yaml is what the swarm and /api/strategies see", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shoal-rc-data-"));
  writeFileSync(join(dir, "strategies.yaml"), "strategies:\n  - id: only-one\n    name: Only One\n    directive: d\n", "utf8");
  const rc = new RunController({ ...testOpts(), dataDir: dir });
  await rc.start(false);
  try {
    const port = (rc as unknown as { server: { port: number; dataStore: { getStrategies: () => { id: string }[] } } }).server.port;
    const res = await fetch(`http://localhost:${port}/api/strategies`);
    const body = await res.json();
    expect(body.strategies).toEqual([{ id: "only-one", name: "Only One", directive: "d" }]);
  } finally {
    await rc.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("onDataChange does not reassert run phase once a task queue is attached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shoal-rc-data-"));
  const path = join(dir, "strategies.yaml");
  writeFileSync(path, "strategies:\n  - id: a\n    name: A\n    directive: d\n", "utf8");
  const rc = new RunController({ ...testOpts(), dataDir: dir });
  await rc.start(false);
  try {
    const controller = rc as unknown as {
      server: { port: number; tasks: unknown; setHealth: (phase: string, runId: number | null) => void };
      handle: (cmd: { cmd: "reload" }) => Promise<void>;
    };
    // Simulate `shoal serve`'s TaskQueue attachment and a task genuinely running — the
    // task queue, not this controller, owns phase/health once that's true.
    controller.server.tasks = {};
    controller.server.setHealth("running", 7);

    writeFileSync(path, "strategies:\n  - id: b\n    name: B\n    directive: d\n", "utf8");
    await controller.handle({ cmd: "reload" });

    const res = await fetch(`http://localhost:${controller.server.port}/api/health`);
    const body = await res.json();
    // Before the fix, onDataChange's broadcastState() would stomp this back to idle/null.
    expect(body.phase).toBe("running");
    expect(body.runId).toBe(7);
  } finally {
    await rc.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a WS 'reload' control command re-reads the data dir without touching run phase", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shoal-rc-data-"));
  const path = join(dir, "strategies.yaml");
  writeFileSync(path, "strategies:\n  - id: a\n    name: A\n    directive: d\n", "utf8");
  const rc = new RunController({ ...testOpts(), dataDir: dir });
  await rc.start(false);
  try {
    const controller = rc as unknown as {
      server: { port: number; dataStore: { getStrategies: () => { id: string }[] } };
      handle: (cmd: { cmd: "reload" }) => Promise<void>;
    };
    writeFileSync(path, "strategies:\n  - id: b\n    name: B\n    directive: d\n", "utf8");
    await controller.handle({ cmd: "reload" });
    expect(controller.server.dataStore.getStrategies().map((s) => s.id)).toEqual(["b"]);

    const res = await fetch(`http://localhost:${controller.server.port}/api/health`);
    expect((await res.json()).phase).toBe("idle"); // reload never touches run phase
  } finally {
    await rc.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
