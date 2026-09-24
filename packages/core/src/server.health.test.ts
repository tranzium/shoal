import { test, expect } from "bun:test";
import { ShoalServer } from "./server.js";

test("/api/health reports idle with no runId before any phase is set", async () => {
  const server = new ShoalServer();
  await server.start(0); // ephemeral port
  try {
    const res = await fetch(`http://localhost:${server.port}/api/health`);
    const body = await res.json();
    expect(body.phase).toBe("idle");
    expect(body.runId).toBeNull();
    expect(typeof body.startedAt).toBe("number");
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
  } finally {
    await server.stop();
  }
});

test("/api/health reflects the phase and runId set via setHealth", async () => {
  const server = new ShoalServer();
  await server.start(0);
  try {
    server.setHealth("running", 3);
    const res = await fetch(`http://localhost:${server.port}/api/health`);
    const body = await res.json();
    expect(body.phase).toBe("running");
    expect(body.runId).toBe(3);
  } finally {
    await server.stop();
  }
});
