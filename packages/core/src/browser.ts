import { cpus } from "node:os";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright";

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

export interface SemanticBrowserAction {
  action: "click" | "fill" | "press" | "select" | "check" | "uncheck" | "hover";
  ref: string;
  text?: string;
}

interface SemanticRef {
  kind: "role" | "placeholder";
  role?: SemanticRole;
  name: string;
  occurrence: number;
  tag: string;
  type: string;
  href: string;
  placeholder: string;
  ariaLabel: string;
  inForm: boolean;
  submit: boolean;
  targetBlank: boolean;
  download: boolean;
  disabled: boolean;
}

interface SemanticElement extends Omit<SemanticRef, "role"> {
  role: string;
  displayHref: string;
}

type SemanticRole = "link" | "button" | "textbox" | "searchbox" | "combobox" | "checkbox" | "radio" | "switch" | "tab" | "menuitem" | "option";

const RISKY_ACTION_LABEL =
  /\b(?:buy|purchase|place order|order now|checkout|cart|book|reserve|payment|pay|subscribe|sign\s*up|register|log\s*in|login|sign\s*in|accept|agree|submit|send)\b/i;
const RISKY_CONNECTION_LABEL =
  /\b(?:connect|link|add|authorize|enable|start|launch|run)\b.{0,40}\b(?:exchange|broker|account|wallet|api\s*keys?|trading\s*bots?)\b|\b(?:exchange|broker|account|wallet|api\s*keys?|trading\s*bots?)\b.{0,40}\b(?:connect|link|add|authorize|enable|start|launch|run|trade)\b/i;
const RISKY_ACTION_PATH =
  /(?:^|\/)(?:checkout|cart|purchase|orders?|place-order|booking|book|reserve|payment|pay|signup|sign-up|register|login|log-in|signin|sign-in|account|wallet|deposit|withdraw(?:al)?|exchange\/connect|connect\/exchange|broker\/connect|connect\/broker|api[-_]?keys?|connect|authorize|bot\/start|bots?\/(?:start|launch|run|create)|trade-now)(?:\/|[.?_-]|$)/i;

function riskyLabel(label: string): boolean {
  return RISKY_ACTION_LABEL.test(label) || RISKY_CONNECTION_LABEL.test(label);
}

export class AgentBrowser {
  private context!: BrowserContext;
  private cdp?: CDPSession;
  private readOnly = false;
  private initialHost = "";
  private semanticRefs = new Map<string, SemanticRef>();
  private semanticRefSequence = 0;
  page!: Page;

  async launch(url: string, headless: boolean, readOnly = false): Promise<void> {
    this.readOnly = readOnly;
    this.initialHost = new URL(url).hostname.toLowerCase();
    const browser = await sharedBrowser(headless);
    this.context = await browser.newContext({
      viewport: { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT },
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: process.env.SHOAL_INSECURE_TLS === "1",
    });
    if (readOnly) {
      // Read-only runs may render ordinary pages, but no mutating HTTP method can leave
      // the browser context even if page code tries to submit something unexpectedly.
      await this.context.route("**/*", async (route) => {
        const method = route.request().method().toUpperCase();
        if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
          await route.abort("blockedbyclient");
          return;
        }
        if (route.request().isNavigationRequest()) {
          const targetHost = new URL(route.request().url()).hostname.toLowerCase().replace(/^www\./, "");
          const siteHost = this.initialHost.replace(/^www\./, "");
          if (targetHost !== siteHost) {
            await route.abort("blockedbyclient");
            return;
          }
        }
        await route.continue();
      });
    }
    this.page = await this.context.newPage();
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
    this.initialHost = new URL(this.page.url()).hostname.toLowerCase();
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

  /** A compact, fresh map of visible page controls for grounded Codex actions. */
  async semanticSnapshot(): Promise<string> {
    const snapshot = await this.page.evaluate(() => {
      const selector = [
        "a[href]", "button", "input:not([type=hidden])", "textarea", "select", "summary",
        "[role=link]", "[role=button]", "[role=textbox]", "[role=searchbox]", "[role=combobox]",
        "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=tab]", "[role=menuitem]", "[role=option]",
        "[contenteditable=true]", "[placeholder]",
      ].join(",");
      const supported = new Set([
        "link", "button", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "tab", "menuitem", "option",
      ]);
      const roleOf = (el: HTMLElement): string | undefined => {
        const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
        if (explicit && supported.has(explicit)) return explicit;
        const tag = el.tagName.toLowerCase();
        if (tag === "a" && (el as HTMLAnchorElement).hasAttribute("href")) return "link";
        if (tag === "button" || tag === "summary") return "button";
        if (tag === "textarea" || el.isContentEditable) return "textbox";
        if (tag === "select") return "combobox";
        if (tag === "input") {
          const type = (el as HTMLInputElement).type.toLowerCase();
          if (["button", "submit", "reset", "image"].includes(type)) return "button";
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (type === "search") return "searchbox";
          return "textbox";
        }
        return undefined;
      };
      const nameOf = (el: HTMLElement): string => {
        const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
        const aria = normalize(el.getAttribute("aria-label"));
        if (aria) return aria;
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy) {
          const names = labelledBy.split(/\s+/).map((id) => normalize(document.getElementById(id)?.textContent)).filter(Boolean);
          if (names.length) return names.join(" ");
        }
        const labels = "labels" in el ? Array.from((el as HTMLInputElement).labels ?? []).map((label) => normalize(label.textContent)).filter(Boolean) : [];
        if (labels.length) return labels.join(" ");
        const id = el.id;
        if (id) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim();
          if (label) return label;
        }
        const wrappingLabel = el.closest("label")?.textContent?.trim();
        if (wrappingLabel) return wrappingLabel;
        if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes((el as HTMLInputElement).type)) {
          return (el as HTMLInputElement).value.trim();
        }
        const text = normalize(el.innerText || el.textContent);
        if (text) return text;
        const imageAlt = normalize(el.querySelector("img[alt]")?.getAttribute("alt"));
        return imageAlt || normalize(el.getAttribute("title"));
      };
      const visible = (el: HTMLElement): boolean => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
      };
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector));
      const occurrences = new Map<string, number>();
      const placeholderOccurrences = new Map<string, number>();
      const elements = [] as Array<{
        role: string;
        name: string;
        kind: "role" | "placeholder";
        occurrence: number;
        tag: string;
        type: string;
        href: string;
        displayHref: string;
        placeholder: string;
        ariaLabel: string;
        inForm: boolean;
        submit: boolean;
        targetBlank: boolean;
        download: boolean;
        disabled: boolean;
      }>;
      for (const el of candidates) {
        const placeholder = el.getAttribute("placeholder")?.replace(/\s+/g, " ").trim() ?? "";
        const placeholderOccurrence = placeholderOccurrences.get(placeholder) ?? 0;
        if (placeholder) placeholderOccurrences.set(placeholder, placeholderOccurrence + 1);
        const role = roleOf(el);
        if (!role) continue;
        const accessibleName = nameOf(el);
        const kind = accessibleName ? "role" : placeholder ? "placeholder" : undefined;
        const name = accessibleName || placeholder;
        if (!kind || !name) continue;
        const key = JSON.stringify([kind, role, name]);
        const occurrence = kind === "placeholder" ? placeholderOccurrence : occurrences.get(key) ?? 0;
        // Role locators only match visible elements; placeholder locators count every matching attribute.
        if (kind === "role" && visible(el)) occurrences.set(key, occurrence + 1);
        if (!visible(el)) continue;
        const anchor = el.tagName === "A" ? (el as HTMLAnchorElement) : undefined;
        let displayHref = "";
        if (anchor?.href) {
          try {
            const url = new URL(anchor.href);
            displayHref = `${url.origin}${url.pathname}`;
          } catch {
            displayHref = "";
          }
        }
        const input = el.tagName === "INPUT" ? (el as HTMLInputElement) : undefined;
        const button = el.tagName === "BUTTON" ? (el as HTMLButtonElement) : undefined;
        elements.push({
          role,
          name,
          kind,
          occurrence,
          tag: el.tagName.toLowerCase(),
          type: input?.type ?? button?.type ?? "",
          href: anchor?.href ?? "",
          displayHref,
          placeholder,
          ariaLabel: el.getAttribute("aria-label")?.trim() ?? "",
          inForm: Boolean(el.closest("form")),
          submit: input?.type === "submit" || input?.type === "image" || button?.type === "submit",
          targetBlank: anchor?.target === "_blank",
          download: Boolean(anchor?.hasAttribute("download")),
          disabled: "disabled" in el && Boolean((el as HTMLButtonElement).disabled) || el.getAttribute("aria-disabled") === "true",
        });
      }
      const headings = Array.from(document.querySelectorAll<HTMLElement>("h1,h2,h3"))
        .filter(visible)
        .map((heading) => `${heading.tagName.toLowerCase()}: ${(heading.innerText || heading.textContent || "").replace(/\s+/g, " ").trim()}`)
        .filter((text) => !text.endsWith(": "))
        .slice(0, 18);
      const pageText = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 2600);
      return {
        title: document.title,
        url: `${location.host}${location.pathname}`,
        headings,
        pageText,
        elements: elements.slice(0, 80),
      };
    });

    this.semanticRefs = new Map();
    const lines = [
      `Page: ${snapshot.title || "(untitled)"}`,
      `URL: ${snapshot.url}`,
      ...(snapshot.headings.length ? [`Headings: ${snapshot.headings.join(" | ")}`] : []),
      ...(snapshot.pageText ? [`Visible page text (first 2600 characters): ${snapshot.pageText}`] : []),
      "Named interactive elements from this page state:",
    ];
    for (const element of snapshot.elements) {
      const ref = `e${++this.semanticRefSequence}`;
      const { displayHref: _displayHref, role, ...locator } = element;
      this.semanticRefs.set(ref, { ...locator, kind: element.kind, role: role as SemanticRole });
      lines.push(
        `[${ref}] ${role} ${JSON.stringify(element.name.slice(0, 220))}${element.name.length > 220 ? "…" : ""}${element.disabled ? " [disabled]" : ""}` +
          `${element.placeholder && element.placeholder !== element.name ? ` [placeholder: ${JSON.stringify(element.placeholder)}]` : ""}` +
          `${element.displayHref ? ` → ${element.displayHref}` : ""}`,
      );
    }
    if (snapshot.elements.length === 0) lines.push("(No named interactive elements found; use the screenshot and computer tool.)");
    lines.push("Element refs are for the current page state only. Use fresh refs after every navigation or action.");
    return lines.join("\n");
  }

  /** Executes a Codex action against a named Playwright locator instead of guessed pixels. */
  async executeSemantic(input: SemanticBrowserAction): Promise<string> {
    const refId = typeof input.ref === "string" ? input.ref : "";
    const ref = this.semanticRefs.get(refId);
    if (!ref) return `stale or unknown element ref ${refId || "(empty)"}; inspect the latest page snapshot and use a fresh ref`;
    if (!["click", "fill", "press", "select", "check", "uncheck", "hover"].includes(input.action)) {
      return `unsupported browser action: ${String(input.action)}`;
    }

    if (this.readOnly) {
      if (["fill", "select", "check", "uncheck"].includes(input.action)) {
        return `blocked by read-only mode: ${input.action} changes form state`;
      }
      if (input.action === "press") {
        const key = (input.text ?? "").toLowerCase().replace(/[_\s]/g, "");
        if (!["tab", "shift+tab", "arrowup", "arrowdown", "arrowleft", "arrowright", "pageup", "pagedown", "home", "end", "escape", "esc"].includes(key)) {
          return `blocked by read-only mode: key ${input.text ?? ""} could submit or change data`;
        }
      }
      if (input.action === "click") {
        const label = ref.name;
        if (ref.href) {
          const url = new URL(ref.href);
          const siteHost = this.initialHost.replace(/^www\./, "");
          if (!["http:", "https:"].includes(url.protocol) || url.hostname.toLowerCase().replace(/^www\./, "") !== siteHost) {
            return "blocked by read-only mode: only same-site navigation is allowed";
          }
          if (ref.inForm || ref.targetBlank || ref.download || riskyLabel(label)) {
            return "blocked by read-only mode: this link may submit data, start a transaction, or leave the current page";
          }
          if (RISKY_ACTION_PATH.test(`${url.pathname}${url.search}`) || /(?:^|[?&])(?:action|intent|mode)=(?:trade|connect|authorize|deposit|withdraw|order|checkout|subscribe)(?:&|$)/i.test(url.search)) {
            return "blocked by read-only mode: this link may start a transaction or account action";
          }
        } else if (
          ref.inForm || ref.submit || riskyLabel(label) ||
          (ref.tag !== "button" && ref.tag !== "summary" && ref.role !== "button")
        ) {
          return "blocked by read-only mode: only ordinary links and non-submit page controls may be activated";
        }
      }
    }

    let locator: Locator;
    if (ref.kind === "placeholder") locator = this.page.getByPlaceholder(ref.name, { exact: true }).nth(ref.occurrence);
    else locator = this.page.getByRole(ref.role!, { name: ref.name, exact: true }).nth(ref.occurrence);
    const count = await locator.count();
    if (count <= 0 || !(await locator.isVisible().catch(() => false))) {
      return `element ref ${refId} is stale or no longer visible; inspect the latest page snapshot`;
    }
    const current = await locator.evaluate((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el instanceof HTMLInputElement || el instanceof HTMLButtonElement ? el.type : "",
      href: el instanceof HTMLAnchorElement ? el.href : "",
      placeholder: el.getAttribute("placeholder")?.trim() ?? "",
      ariaLabel: el.getAttribute("aria-label")?.trim() ?? "",
    }));
    if (current.tag !== ref.tag || current.type !== ref.type || current.href !== ref.href || current.placeholder !== ref.placeholder || current.ariaLabel !== ref.ariaLabel) {
      return `element ref ${refId} no longer points to the same control; inspect the latest page snapshot`;
    }
    if (!(await locator.isEnabled().catch(() => false))) return `element ref ${refId} is disabled`;

    try {
      switch (input.action) {
        case "click":
          if (ref.targetBlank || ref.download) return `element ref ${refId} would open a new tab or download, which Shoal does not follow`;
          await locator.click({ timeout: 5000 });
          return `clicked ${ref.role} ${JSON.stringify(ref.name)} (${refId})`;
        case "fill":
          if (!(ref.role === "textbox" || ref.role === "searchbox")) return `element ref ${refId} is not a text field`;
          await locator.fill(input.text ?? "", { timeout: 5000 });
          return `filled ${ref.role} ${JSON.stringify(ref.name)}; entered text is omitted from the action log`;
        case "press":
          await locator.press(toPlaywrightCombo(input.text ?? ""), { timeout: 5000 });
          return `pressed ${input.text ?? "a key"} on ${refId}`;
        case "select":
          if (ref.role !== "combobox") return `element ref ${refId} is not a select control`;
          await locator.selectOption({ label: input.text ?? "" }, { timeout: 5000 });
          return `selected the requested option on ${refId}`;
        case "check":
          if (ref.role !== "checkbox" && ref.role !== "radio") return `element ref ${refId} is not a checkbox or radio`;
          await locator.check({ timeout: 5000 });
          return `checked ${JSON.stringify(ref.name)} (${refId})`;
        case "uncheck":
          if (ref.role !== "checkbox") return `element ref ${refId} is not a checkbox`;
          await locator.uncheck({ timeout: 5000 });
          return `unchecked ${JSON.stringify(ref.name)} (${refId})`;
        case "hover":
          await locator.hover({ timeout: 5000 });
          return `hovered ${JSON.stringify(ref.name)} (${refId})`;
      }
    } catch (err) {
      return `browser action failed on ${refId}: ${(err as Error).message}`;
    }
  }

  /** Executes one computer-use action. Returns a human-readable description of what ran. */
  async execute(input: ComputerAction): Promise<string> {
    const { page } = this;
    const [x, y] = input.coordinate ?? [0, 0];
    const modifier = input.text && MODIFIERS[input.text.toLowerCase()];

    if (this.readOnly) {
      if (input.action === "type") return "blocked by read-only mode: typing is disabled";
      if (input.action === "key") {
        const key = (input.text ?? "").trim().toLowerCase();
        const safeKeys = new Set(["tab", "shift+tab", "up", "down", "left", "right", "page_up", "page_down", "home", "end", "escape", "esc"]);
        if (!safeKeys.has(key)) return `blocked by read-only mode: key ${input.text ?? ""} could submit or change data`;
      }
      if (["right_click", "double_click", "left_click_drag"].includes(input.action)) {
        return `blocked by read-only mode: ${input.action} is disabled`;
      }
      if (input.action === "left_click") {
        const gate = await page.evaluate(({ x: px, y: py, host }) => {
          const target = document.elementFromPoint(px, py);
          const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
          const siteHost = host.replace(/^www\./, "");
          const riskyActionLabel = (label: string) => {
            const normalized = label.toLowerCase().replace(/\s+/g, " ").trim();
            return /\b(?:buy|purchase|place order|order now|checkout|cart|book|reserve|payment|pay|subscribe|sign\s*up|register|log\s*in|login|sign\s*in|accept|agree|submit|send)\b/i.test(normalized) ||
              /\b(?:connect|link|add|authorize|enable|start|launch|run)\b.{0,40}\b(?:exchange|broker|account|wallet|api\s*keys?|trading\s*bots?)\b/i.test(normalized) ||
              /\b(?:exchange|broker|account|wallet|api\s*keys?|trading\s*bots?)\b.{0,40}\b(?:connect|link|add|authorize|enable|start|launch|run|trade)\b/i.test(normalized);
          };
          const riskyActionPath = (pathname: string, search: string) =>
            /(?:^|\/)(?:checkout|cart|purchase|orders?|place-order|booking|book|reserve|payment|pay|signup|sign-up|register|login|log-in|signin|sign-in|account|wallet|deposit|withdraw(?:al)?|exchange\/connect|connect\/exchange|broker\/connect|connect\/broker|api[-_]?keys?|connect|authorize|bot\/start|bots?\/(?:start|launch|run|create)|trade-now)(?:\/|[.?_-]|$)/i.test(pathname) ||
            /(?:^|[?&])(?:action|intent|mode)=(?:trade|connect|authorize|deposit|withdraw|order|checkout|subscribe)(?:&|$)/i.test(search);
          if (!anchor) {
            const button = target?.closest("button,[role=button],summary") as HTMLElement | null;
            if (!button) return "blocked: read-only mode only follows links or opens non-submit page controls";
            if (button.closest("form") || (button instanceof HTMLButtonElement && button.type === "submit")) {
              return "blocked: form controls are disabled";
            }
            const label = `${button.getAttribute("aria-label") || ""} ${button.innerText || button.textContent || ""}`.toLowerCase();
            if (riskyActionLabel(label)) {
              return "blocked: this control may start a transaction, trading action, or account connection";
            }
            return "allowed";
          }
          if (anchor.closest("form")) return "blocked: links inside forms are disabled";
          if (anchor.hasAttribute("download") || anchor.target === "_blank") return "blocked: downloads and new tabs are disabled";
          const label = `${anchor.getAttribute("aria-label") || ""} ${anchor.innerText || anchor.textContent || ""}`;
          if (riskyActionLabel(label)) return "blocked: this link may start a transaction, trading action, or account connection";
          const href = new URL(anchor.href, location.href);
          if (!["http:", "https:"].includes(href.protocol) || href.hostname.toLowerCase().replace(/^www\./, "") !== siteHost) {
            return "blocked: read-only mode only follows links on the current site";
          }
          if (riskyActionPath(href.pathname, href.search)) {
            return "blocked: this link may start a transaction, trading action, or account connection";
          }
          return "allowed";
        }, { x, y, host: this.initialHost });
        if (gate !== "allowed") return `${gate} (read-only mode)`;
      }
    }

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
  }
}
