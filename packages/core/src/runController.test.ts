import { test, expect } from "bun:test";
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
