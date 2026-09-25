import { test, expect } from "bun:test";
import { ShoalServer } from "./server.js";
import type { TaskQueue } from "./taskQueue.js";

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

test("/api/health reports credentialsError null by default, and whatever `serve` set it to", async () => {
  const server = new ShoalServer();
  await server.start(0);
  try {
    const before = await (await fetch(`http://localhost:${server.port}/api/health`)).json();
    expect(before.credentialsError).toBeNull();

    server.credentialsError = "No ANTHROPIC_API_KEY found.";
    const after = await (await fetch(`http://localhost:${server.port}/api/health`)).json();
    expect(after.credentialsError).toBe("No ANTHROPIC_API_KEY found.");
  } finally {
    await server.stop();
  }
});

test("/api/health reports browserError null by default, and whatever `serve` set it to", async () => {
  const server = new ShoalServer();
  await server.start(0);
  try {
    const before = await (await fetch(`http://localhost:${server.port}/api/health`)).json();
    expect(before.browserError).toBeNull();

    server.browserError = "Chromium headless shell not found at /nope — run `npx playwright install chromium`.";
    const after = await (await fetch(`http://localhost:${server.port}/api/health`)).json();
    expect(after.browserError).toBe("Chromium headless shell not found at /nope — run `npx playwright install chromium`.");
  } finally {
    await server.stop();
  }
});

test("reconcileAgents flips any cached agent still mid-flight to stopped", async () => {
  const server = new ShoalServer();
  await server.start(0);
  try {
    server.broadcast({
      type: "agent_state",
      state: {
        agentId: "a-0",
        personaId: "p",
        personaName: "Test Persona",
        emoji: "🐟",
        status: "queued",
        step: 0,
        lastThought: "",
        lastAction: "",
      },
      ts: Date.now(),
    });

    server.reconcileAgents();

    const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
    const events: { type: string; state?: { agentId: string; status: string } }[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.onmessage = (msg) => events.push(JSON.parse(msg.data as string));
      ws.onopen = () => setTimeout(resolve, 80); // give the replay a moment to land
      ws.onerror = () => reject(new Error("ws error"));
    });
    ws.close();

    const seeded = events.find((e) => e.type === "agent_state" && e.state?.agentId === "a-0");
    expect(seeded?.state?.status).toBe("stopped");
  } finally {
    await server.stop();
  }
});

test("WS stop/restart is refused server-side once a task queue is attached; reload still works", async () => {
  const server = new ShoalServer();
  await server.start(0);
  const calls: string[] = [];
  server.onControl = (cmd) => calls.push(cmd.cmd);
  server.tasks = {} as unknown as TaskQueue; // only its presence is checked on this path
  try {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("ws error"));
    });
    ws.send(JSON.stringify({ cmd: "stop" }));
    ws.send(JSON.stringify({ cmd: "restart" }));
    ws.send(JSON.stringify({ cmd: "reload" }));
    await new Promise((r) => setTimeout(r, 80));
    ws.close();
    expect(calls).toEqual(["reload"]);
  } finally {
    await server.stop();
  }
});
