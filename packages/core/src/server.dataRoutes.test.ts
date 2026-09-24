import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShoalServer } from "./server.js";
import { DataStore } from "./dataStore.js";

async function withDataServer<T>(dataDir: string | undefined, fn: (server: ShoalServer) => Promise<T>): Promise<T> {
  const server = new ShoalServer();
  await server.start(0);
  server.dataStore = new DataStore(dataDir);
  try {
    return await fn(server);
  } finally {
    await server.stop();
  }
}

test("GET /api/strategies without a data store returns 404", async () => {
  const server = new ShoalServer();
  await server.start(0);
  try {
    const res = await fetch(`http://localhost:${server.port}/api/strategies`);
    expect(res.status).toBe(404);
  } finally {
    await server.stop();
  }
});

test("GET /api/strategies lists the packaged library with source and loadedAt", async () => {
  await withDataServer(undefined, async (server) => {
    const res = await fetch(`http://localhost:${server.port}/api/strategies`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(Array.isArray(body.strategies)).toBe(true);
    expect(body.strategies.length).toBeGreaterThan(0);
    expect(typeof body.source).toBe("string");
    expect(typeof body.loadedAt).toBe("number");
    expect(body.error).toBeNull();
  });
});

test("GET /api/missions lists what's in <dataDir>/missions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shoal-routes-"));
  const missionsDir = join(dir, "missions");
  mkdirSync(missionsDir);
  writeFileSync(join(missionsDir, "signup.yaml"), "title: Signup\nurl: https://x.test/\ntask: sign up\n", "utf8");
  try {
    await withDataServer(dir, async (server) => {
      const res = await fetch(`http://localhost:${server.port}/api/missions`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.missions).toEqual([{ name: "signup", title: "Signup", url: "https://x.test/", task: "sign up" }]);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /api/reload re-reads the data dir and reports whether anything changed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shoal-routes-"));
  const path = join(dir, "strategies.yaml");
  writeFileSync(path, "strategies:\n  - id: a\n    name: A\n    directive: d\n", "utf8");
  try {
    await withDataServer(dir, async (server) => {
      const first = await fetch(`http://localhost:${server.port}/api/reload`, { method: "POST" });
      expect((await first.json()).changed).toBe(false); // nothing changed since construction

      writeFileSync(path, "strategies:\n  - id: b\n    name: B\n    directive: d\n", "utf8");
      const second = await fetch(`http://localhost:${server.port}/api/reload`, { method: "POST" });
      const body = await second.json();
      expect(body.changed).toBe(true);
      expect(body.strategies.count).toBe(1);
      expect(server.dataStore!.getStrategies()[0].id).toBe("b");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /api/reload without a data store returns 404", async () => {
  const server = new ShoalServer();
  await server.start(0);
  try {
    const res = await fetch(`http://localhost:${server.port}/api/reload`, { method: "POST" });
    expect(res.status).toBe(404);
  } finally {
    await server.stop();
  }
});

test("/api/health surfaces a data-dir parse error without crashing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shoal-routes-"));
  const path = join(dir, "strategies.yaml");
  writeFileSync(path, "strategies:\n  - id: a\n    name: A\n    directive: d\n", "utf8");
  try {
    await withDataServer(dir, async (server) => {
      writeFileSync(path, "not valid: [yaml", "utf8");
      server.dataStore!.reload();
      const res = await fetch(`http://localhost:${server.port}/api/health`);
      const body = await res.json();
      expect(body.data.strategiesError).not.toBeNull();
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
