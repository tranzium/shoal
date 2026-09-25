import { cpus, tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page, type Worker } from "playwright";
import type { CapturedError } from "./types.js";
import type { QaGuardEvent } from "./qa.js";

export const DISPLAY_WIDTH = 1024;
export const DISPLAY_HEIGHT = 768;

/**
 * Launch flags with measured wins only (see docs/SCALING.md — flag-stacking beyond these
 * was measured at ~16MB total, and --single-process measurably INCREASES memory):
 *
 *  - process-per-site + no site isolation: Chromium documents 10–13% total memory in
 *    site-isolation overhead, and per-iframe processes multiply under it. A swarm points
 *    every agent at ONE target site, so renderer count collapses toward #distinct-sites.
 *  - max-old-space-size: a runaway page crashes its own renderer, not the machine.
 *  - the rest disable background work a test swarm never needs (network prefetch, audio).
 */
const LAUNCH_ARGS = [
  "--process-per-site",
  "--disable-features=IsolateOrigins,site-per-process",
  "--js-flags=--max-old-space-size=256",
  "--disable-background-networking",
  "--disable-extensions",
  "--mute-audio",
  "--hide-scrollbars",
];

/**
 * Agents share a small POOL of Chromium processes; each agent gets its own isolated
 * context (cookies, storage, viewport) on one of them.
 *
 * Why a pool and not one process: a single browser process serializes context+page
 * creation — measured at ~1.0 launches/second no matter how many are requested in
 * parallel (the cost is the renderer spawn, ~1-3s each, all funneled through one
 * browser process). K shards launch near-linearly faster (measured: 4 shards → 3.6/s),
 * so the swarm's in-flight count stops being launch-starved. Contexts stay fully
 * isolated per agent; the shards only spread the spawn work.
 */
let pool: Promise<Browser>[] = [];
let poolHeadless = true;
let nextShard = 0;

/** Effective concurrency, so the pool can size itself to the launch demand. */
let poolTarget = 0;
export function configureBrowserPool(concurrency: number): void {
  poolTarget = concurrency;
}

function poolSize(): number {
  // One browser process serializes context creation at ~1 launch/sec, so the shard count
  // sets how fast a swarm can ramp to full concurrency. Scale with both the machine and
  // the requested concurrency (each idle shard costs ~150-200MB, so stay bounded).
  const byCores = Math.max(2, Math.floor(cpus().length / 4));
  const byLoad = Math.max(2, Math.ceil(poolTarget / 15));
  return Math.min(12, Math.max(byCores, byLoad));
}

function sharedBrowser(headless: boolean): Promise<Browser> {
  if (pool.length === 0 || poolHeadless !== headless) {
    poolHeadless = headless;
    pool = Array.from({ length: poolSize() }, () => chromium.launch({ headless, args: LAUNCH_ARGS }));
  }
  return pool[nextShard++ % pool.length];
}

export async function closeSharedBrowser(): Promise<void> {
  const closing = pool;
  pool = [];
  await Promise.all(closing.map(async (p) => (await p).close().catch(() => {})));
}

/** Maps xdotool-style key names (what the computer-use model emits) to Playwright key names. */
const KEY_MAP: Record<string, string> = {
  return: "Enter",
  enter: "Enter",
  kp_enter: "Enter",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  escape: "Escape",
  esc: "Escape",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  home: "Home",
  end: "End",
  page_up: "PageUp",
  page_down: "PageDown",
  ctrl: "Control",
  control: "Control",
  alt: "Alt",
  shift: "Shift",
  super: "Meta",
  cmd: "Meta",
  meta: "Meta",
};

function toPlaywrightKey(key: string): string {
  const k = key.trim();
  return KEY_MAP[k.toLowerCase()] ?? (k.length === 1 ? k : k.charAt(0).toUpperCase() + k.slice(1));
}

function toPlaywrightCombo(combo: string): string {
  return combo.split("+").map(toPlaywrightKey).join("+");
}

const MODIFIERS: Record<string, "Control" | "Alt" | "Shift" | "Meta"> = {
  ctrl: "Control",
  control: "Control",
  alt: "Alt",
  shift: "Shift",
  super: "Meta",
  cmd: "Meta",
};

export interface ComputerAction {
  action: string;
  coordinate?: [number, number];
  start_coordinate?: [number, number];
  text?: string;
  scroll_direction?: "up" | "down" | "left" | "right";
  scroll_amount?: number;
  duration?: number;
}

/**
 * Repro mode: dedupes console/pageerror/network/extension-worker errors observed during
 * one agent's session, so a chatty error doesn't drown the report — the report wants
 * "this error, N times, first seen at step K", not N near-identical lines.
 */
class ErrorCapture {
  private byKey = new Map<string, CapturedError>();
  /** Set by the agent loop before each step so new errors land with the right step number. */
  step = 0;

  record(source: CapturedError["source"], text: string): void {
    const key = `${source}:${text}`;
    const existing = this.byKey.get(key);
    if (existing) {
      existing.count++;
      return;
    }
    this.byKey.set(key, { source, text, count: 1, firstStep: this.step });
  }

  list(): CapturedError[] {
    return [...this.byKey.values()];
  }
}

/** Matches a hostname against a QA mission's `hosts` allowlist ("x.test" also matches
 *  "static.x.test"'s subdomains the same way `safety.ts`'s domain allowlist does). */
function qaHostAllowed(host: string, hosts: string[]): boolean {
  const h = host.toLowerCase();
  return hosts.some((d) => {
    const dd = d.toLowerCase().replace(/^\*\./, "");
    return h === dd || h.endsWith(`.${dd}`);
  });
}

export class AgentBrowser {
  private context!: BrowserContext;
  private cdp?: CDPSession;
  private extensionUserDataDir?: string;
  page!: Page;
  readonly errors = new ErrorCapture();
  /** QA mode only: top-level navigations fenced off because their host isn't in `hosts`. */
  readonly blockedNavigations: string[] = [];
  /** QA mode only: guard evidence (>=400 responses, pageerrors, console errors) for qa.ts's evaluateGuards. */
  readonly qaGuardEvents: QaGuardEvent[] = [];
  /** QA mode only: HTTP status of the last main-document response seen. */
  qaDocStatus: number | null = null;

  /**
   * `extensionDir`, when set, loads that unpacked extension via `--load-extension` instead
   * of drawing a context from the shared headless pool — extensions require their own
   * persistent context (`launchPersistentContext`), one Chromium process per agent. Repro
   * tasks run small swarms, so the pool's per-context-creation-rate optimization doesn't
   * apply here anyway.
   *
   * `channel: "chromium"` pins this to the full Chromium binary. Playwright's default
   * headless launch (what the shared pool uses) runs `chrome-headless-shell` instead — a
   * stripped build with no extension support — so extensions need the full binary's "new"
   * headless mode (Chromium's own default headless behavior today), which does support them,
   * headed or not. `timeout` is explicit (Playwright's persistent-context default is 3
   * minutes) so a broken extension/profile fails a repro task in seconds, not minutes.
   */
  async launch(url: string, headless: boolean, extensionDir?: string, qaHosts?: string[]): Promise<void> {
    if (extensionDir) {
      this.extensionUserDataDir = await mkdtemp(join(tmpdir(), "shoal-ext-"));
      this.context = await chromium.launchPersistentContext(this.extensionUserDataDir, {
        headless,
        channel: "chromium",
        timeout: 30000,
        viewport: { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT },
        deviceScaleFactor: 1,
        ignoreHTTPSErrors: process.env.SHOAL_INSECURE_TLS === "1",
        args: [
          ...LAUNCH_ARGS.filter((a) => a !== "--disable-extensions"),
          `--disable-extensions-except=${extensionDir}`,
          `--load-extension=${extensionDir}`,
        ],
      });
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      const captureWorker = (worker: Worker) => {
        if (!worker.url().startsWith("chrome-extension://")) return; // page workers are noise here
        worker.on("console", (msg) => {
          if (msg.type() === "error") this.errors.record("extension", msg.text());
        });
      };
      this.context.on("serviceworker", captureWorker);
      for (const w of this.context.serviceWorkers()) captureWorker(w);
    } else {
      const browser = await sharedBrowser(headless);
      this.context = await browser.newContext({
        viewport: { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT },
        deviceScaleFactor: 1,
        ignoreHTTPSErrors: process.env.SHOAL_INSECURE_TLS === "1",
      });
      this.page = await this.context.newPage();
    }

    this.page.on("console", (msg) => {
      if (msg.type() === "error") this.errors.record("console", msg.text());
    });
    this.page.on("pageerror", (err) => this.errors.record("pageerror", err.message));
    this.page.on("requestfailed", (req) => {
      const failure = req.failure();
      this.errors.record("network", `${req.method()} ${req.url()} — ${failure?.errorText ?? "failed"}`);
    });

    if (qaHosts) {
      // Navigation fence: a top-level document navigation to a host outside `hosts` is
      // aborted rather than followed — it's listed as blocked, never counted as a network
      // error (an external link the navigator clicks is expected behavior, not a guard hit).
      await this.context.route("**/*", (route) => {
        const req = route.request();
        if (req.isNavigationRequest() && req.frame() === this.page.mainFrame()) {
          let host = "";
          try {
            host = new URL(req.url()).hostname;
          } catch {
            /* malformed URL — treat as not allowed */
          }
          if (!qaHostAllowed(host, qaHosts)) {
            this.blockedNavigations.push(req.url());
            return route.abort();
          }
        }
        return route.continue();
      });
      this.page.on("response", (res) => {
        let host = "";
        try {
          host = new URL(res.url()).hostname;
        } catch {
          return;
        }
        const type = res.request().resourceType();
        if (type === "document" && res.url() === this.page.url()) this.qaDocStatus = res.status();
        if ((type === "document" || type === "xhr" || type === "fetch") && res.status() >= 400) {
          this.qaGuardEvents.push({ kind: "http", host, text: `${res.request().method()} ${res.url()} — ${res.status()}` });
        }
      });
      this.page.on("pageerror", (err) => {
        this.qaGuardEvents.push({ kind: "pageerror", host: new URL(this.page.url()).hostname, text: err.message });
      });
      this.page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        let host = "";
        try {
          host = new URL(this.page.url()).hostname;
        } catch {
          /* no current URL yet */
        }
        this.qaGuardEvents.push({ kind: "console", host, text: msg.text() });
      });
    }

    const response = await this.page.goto(url, { waitUntil: "domcontentloaded" });
    if (qaHosts && response) this.qaDocStatus = response.status();
  }

  /**
   * QA mode: resolves the selector text/attrs a check list needs, plus cookies and the
   * capped body text, into the literal shape qa.ts's pure `evaluate` reads. `selectors`
   * is the distinct set of selector strings in play ("" = whole document body).
   */
  async qaSnapshot(selectors: string[]): Promise<{
    bodyText: string;
    selectors: Record<string, { text: string; attrs: Record<string, string> } | null>;
    cookies: Record<string, string>;
  }> {
    const resolved = (await this.page.evaluate((keys: string[]) => {
      const out: Record<string, { text: string; attrs: Record<string, string> } | null> = {};
      for (const sel of keys) {
        const el = sel ? document.querySelector(sel) : document.body;
        if (!el) {
          out[sel] = null;
          continue;
        }
        const attrs: Record<string, string> = {};
        for (const a of Array.from((el as Element).attributes ?? [])) attrs[a.name] = a.value;
        out[sel] = { text: (el as HTMLElement).innerText ?? el.textContent ?? "", attrs };
      }
      return out;
    }, selectors)) as Record<string, { text: string; attrs: Record<string, string> } | null>;
    const cookiesList = await this.context.cookies();
    const cookies = Object.fromEntries(cookiesList.map((c) => [c.name, c.value]));
    const bodyText = (resolved[""]?.text ?? "").slice(0, 20000);
    return { bodyText, selectors: resolved, cookies };
  }

  /** Correlates newly captured errors with the agent's current step (docs/report: "first-seen step"). */
  setStep(step: number): void {
    this.errors.step = step;
  }

  private async lifecycle(state: "frozen" | "active"): Promise<void> {
    // Best-effort: a failed freeze just means this page stays active (old behavior).
    try {
      this.cdp ??= await this.context.newCDPSession(this.page);
      await this.cdp.send("Page.setWebLifecycleState", { state });
    } catch {
      this.cdp = undefined;
    }
  }

  /**
   * Freeze the page while this agent waits (on the model, a scene signal, a scripted
   * pause): JS, timers, and rendering stop; full state stays in RAM. This is what lets
   * hundreds of agents be RESIDENT while only the CPU-bound active set renders
   * (docs/SCALING.md — the same lifecycle state Chrome's Energy Saver uses).
   */
  freeze(): Promise<void> {
    return this.lifecycle("frozen");
  }

  /** Thaw before acting or screenshotting — a frozen page won't process input. */
  unfreeze(): Promise<void> {
    return this.lifecycle("active");
  }

  async screenshot(): Promise<string> {
    const buf = await this.page.screenshot({ type: "jpeg", quality: 60 });
    return buf.toString("base64");
  }

  /** Executes one computer-use action. Returns a human-readable description of what ran. */
  async execute(input: ComputerAction): Promise<string> {
    const { page } = this;
    const [x, y] = input.coordinate ?? [0, 0];
    const modifier = input.text && MODIFIERS[input.text.toLowerCase()];

    const withModifier = async (fn: () => Promise<void>) => {
      if (modifier) await page.keyboard.down(modifier);
      try {
        await fn();
      } finally {
        if (modifier) await page.keyboard.up(modifier);
      }
    };

    switch (input.action) {
      case "screenshot":
        return "screenshot";
      case "left_click":
        await withModifier(() => page.mouse.click(x, y));
        return `click (${x}, ${y})`;
      case "right_click":
        await withModifier(() => page.mouse.click(x, y, { button: "right" }));
        return `right-click (${x}, ${y})`;
      case "middle_click":
        await page.mouse.click(x, y, { button: "middle" });
        return `middle-click (${x}, ${y})`;
      case "double_click":
        await withModifier(() => page.mouse.dblclick(x, y));
        return `double-click (${x}, ${y})`;
      case "triple_click":
        await withModifier(() => page.mouse.click(x, y, { clickCount: 3 }));
        return `triple-click (${x}, ${y})`;
      case "left_mouse_down":
        await page.mouse.move(x, y);
        await page.mouse.down();
        return `mouse down (${x}, ${y})`;
      case "left_mouse_up":
        await page.mouse.move(x, y);
        await page.mouse.up();
        return `mouse up (${x}, ${y})`;
      case "left_click_drag": {
        const [sx, sy] = input.start_coordinate ?? [x, y];
        await page.mouse.move(sx, sy);
        await page.mouse.down();
        await page.mouse.move(x, y, { steps: 12 });
        await page.mouse.up();
        return `drag (${sx}, ${sy}) → (${x}, ${y})`;
      }
      case "mouse_move":
        await page.mouse.move(x, y);
        return `move (${x}, ${y})`;
      case "type":
        await page.keyboard.type(input.text ?? "", { delay: 25 });
        return `type "${(input.text ?? "").slice(0, 40)}"`;
      case "key":
        await page.keyboard.press(toPlaywrightCombo(input.text ?? ""));
        return `key ${input.text}`;
      case "hold_key": {
        const k = toPlaywrightKey(input.text ?? "");
        await page.keyboard.down(k);
        await page.waitForTimeout((input.duration ?? 1) * 1000);
        await page.keyboard.up(k);
        return `hold ${input.text}`;
      }
      case "scroll": {
        await page.mouse.move(x, y);
        const amount = (input.scroll_amount ?? 3) * 120;
        const dir = input.scroll_direction ?? "down";
        const dx = dir === "left" ? -amount : dir === "right" ? amount : 0;
        const dy = dir === "up" ? -amount : dir === "down" ? amount : 0;
        await page.mouse.wheel(dx, dy);
        return `scroll ${dir}`;
      }
      case "wait":
        await page.waitForTimeout((input.duration ?? 1) * 1000);
        return "wait";
      default:
        return `unsupported action: ${input.action}`;
    }
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    if (this.extensionUserDataDir) await rm(this.extensionUserDataDir, { recursive: true, force: true }).catch(() => {});
  }
}
