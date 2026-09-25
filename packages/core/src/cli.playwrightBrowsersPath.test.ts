import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const cliPath = join(here, "cli.ts");

/**
 * Regression guard for the bug this file's sibling change fixed: playwright-core (1.62)
 * resolves PLAYWRIGHT_BROWSERS_PATH once, when it is first imported — not lazily at
 * chromium.launch(). `cli.ts` must apply `--playwright-browsers-path` before anything that
 * transitively imports "playwright" (cliMain.js -> orchestrator.js -> browser.js) loads, or
 * the flag silently does nothing (what shipped for the NSSM/Warden service until now). This
 * spawns the real entry file as a subprocess (env can only be observed process-wide, so an
 * in-process test can't isolate it) and checks the resolved Chromium path — surfaced via
 * browser.ts's browserPreflightError() on `shoal serve` boot — actually lands under the
 * fake browsers dir, not the default OS cache location.
 */
test("cli.ts applies --playwright-browsers-path before importing anything that loads playwright", async () => {
  const fakeDir = mkdtempSync(join(tmpdir(), "shoal-pw-"));
  const env = { ...process.env };
  delete env.PLAYWRIGHT_BROWSERS_PATH;

  const child = spawn(
    "bun",
    ["run", cliPath, "serve", "--no-open", "--port", "0", "--playwright-browsers-path", fakeDir],
    { cwd: here, env },
  );

  let stderr = "";
  try {
    const sawPreflight = await new Promise<boolean>((resolve) => {
      const onData = (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.includes("Chromium headless shell not found at")) resolve(true);
      };
      child.stderr?.on("data", onData);
      child.on("exit", () => resolve(false));
      child.on("error", () => resolve(false));
      setTimeout(() => resolve(false), 15000);
    });

    expect(sawPreflight).toBe(true);
    expect(stderr).toContain(fakeDir);
  } finally {
    child.kill();
    rmSync(fakeDir, { recursive: true, force: true });
  }
}, 20000);
