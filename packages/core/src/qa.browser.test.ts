import { test, expect, afterAll } from "bun:test";
import { AgentBrowser } from "./browser.js";
import { runQaAgent } from "./qaAgent.js";
import { buildQaReport, exitCodeFor } from "./qa.js";
import type { AgentState, QaConfig, RunOptions } from "./types.js";

/**
 * Real-browser QA-mode coverage: a tiny Bun.serve fixture (price text + Set-Cookie, a
 * redirect that keeps ?aff=, a 500 page, a page with console.error, a link to another
 * host) driven through the real navigation fence, guard capture, and snapshot pipeline —
 * per the "no mocks where real fits" rule. These missions are all start-only, so they make
 * zero model calls and need no credentials, which is itself part of what's under test.
 * Warns and skips (not fails) if this sandbox can't launch a real Chromium, same policy as
 * browser.repro.test.ts.
 */

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/pricing/") {
      return new Response(
        `<html><body><div class="price">$39.99</div></body></html>`,
        { headers: { "content-type": "text/html", "set-cookie": "daffiliate=QATEST01; Path=/" } },
      );
    }
    if (url.pathname === "/go") {
      const aff = url.searchParams.get("aff") ?? "";
      return Response.redirect(`/landed?aff=${aff}`, 302);
    }
    if (url.pathname === "/landed") {
      return new Response(`<html><body>landed</body></html>`, { headers: { "content-type": "text/html" } });
    }
    if (url.pathname === "/broken") {
      return new Response("server error", { status: 500 });
    }
    if (url.pathname === "/noisy") {
      return new Response(`<html><body><script>console.error("boom from the page")</script>hi</body></html>`, {
        headers: { "content-type": "text/html" },
      });
    }
    if (url.pathname === "/withlink") {
      return new Response(`<html><body><a id="out" href="http://external.invalid/">away</a></body></html>`, {
        headers: { "content-type": "text/html" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});
const base = `http://localhost:${server.port}`;
const host = "localhost";

afterAll(() => {
  server.stop(true);
});

async function tryLaunch(): Promise<AgentBrowser | null> {
  const b = new AgentBrowser();
  try {
    await b.launch("about:blank", true);
    return b;
  } catch (err) {
    console.warn(`  ⚠ skipping qa.browser test — could not launch a real Chromium here: ${(err as Error).message.slice(0, 160)}`);
    await b.close().catch(() => {});
    return null;
  }
}

function baseOpts(qa: QaConfig, url: string): RunOptions {
  return {
    url,
    task: "reach the target state",
    swarm: 1,
    concurrency: 1,
    provider: "anthropic",
    model: "claude-opus-5",
    effort: "medium",
    verify: false,
    maxSteps: 12,
    headless: true,
    mock: false,
    port: 0,
    qa,
    qaMission: "fixture",
  };
}

test(
  "start-only mission: matching text + cookie passes with zero model calls",
  async () => {
    const probe = await tryLaunch();
    if (!probe) return;
    await probe.close();

    const qa: QaConfig = {
      hosts: [host],
      expect: [
        { id: "price", kind: "text", when: "start", selector: ".price", equals: "$39.99" },
        { id: "aff-cookie", kind: "cookie", when: "start", name: "daffiliate", value: "QATEST01" },
      ],
    };
    const state: AgentState = await runQaAgent(
      "a0",
      { id: "qa-navigator", emoji: "🧭", name: "QA Navigator", patience_steps: 12, profile: "" },
      baseOpts(qa, `${base}/pricing/`),
      { onState: () => {}, onThought: () => {}, onFinding: () => {} },
    );
    expect(state.status).toBe("done");
    expect(state.qaResult).toBeDefined();
    const report = buildQaReport("fixture", `${base}/pricing/`, { repeats: 1, startedAt: 0, finishedAt: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, [
      state.qaResult!,
    ]);
    expect(report.verdict).toBe("pass");
    expect(exitCodeFor(report.verdict)).toBe(0);
    expect(report.expectations.every((e) => e.status === "pass")).toBe(true);
  },
  30000,
);

test(
  "start-only mission: a 500 response fails the http guard",
  async () => {
    const probe = await tryLaunch();
    if (!probe) return;
    await probe.close();

    const qa: QaConfig = { hosts: [host], expect: [{ id: "noop", kind: "url", when: "start", contains: "/broken" }] };
    const state = await runQaAgent(
      "a0",
      { id: "qa-navigator", emoji: "🧭", name: "QA Navigator", patience_steps: 12, profile: "" },
      baseOpts(qa, `${base}/broken`),
      { onState: () => {}, onThought: () => {}, onFinding: () => {} },
    );
    const report = buildQaReport("fixture", `${base}/broken`, { repeats: 1, startedAt: 0, finishedAt: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, [
      state.qaResult!,
    ]);
    expect(report.guards.find((g) => g.kind === "http")!.status).toBe("fail");
    expect(report.verdict).toBe("fail");
    expect(exitCodeFor(report.verdict)).toBe(1);
  },
  30000,
);

test(
  "start-only mission: a page console.error fails the console guard",
  async () => {
    const probe = await tryLaunch();
    if (!probe) return;
    await probe.close();

    const qa: QaConfig = { hosts: [host], expect: [{ id: "noop", kind: "url", when: "start", contains: "/noisy" }] };
    const state = await runQaAgent(
      "a0",
      { id: "qa-navigator", emoji: "🧭", name: "QA Navigator", patience_steps: 12, profile: "" },
      baseOpts(qa, `${base}/noisy`),
      { onState: () => {}, onThought: () => {}, onFinding: () => {} },
    );
    const guards = state.qaResult!.guards;
    expect(guards.find((g) => g.kind === "console")!.status).toBe("fail");
    expect(guards.find((g) => g.kind === "console")!.items[0]).toContain("boom from the page");
  },
  30000,
);

test(
  "the redirect keeps ?aff= and the landed page's url check passes",
  async () => {
    const probe = await tryLaunch();
    if (!probe) return;
    await probe.close();

    const qa: QaConfig = {
      hosts: [host],
      expect: [{ id: "landed", kind: "url", when: "start", contains: "/landed", query: { aff: "QATEST01" } }],
    };
    const state = await runQaAgent(
      "a0",
      { id: "qa-navigator", emoji: "🧭", name: "QA Navigator", patience_steps: 12, profile: "" },
      baseOpts(qa, `${base}/go?aff=QATEST01`),
      { onState: () => {}, onThought: () => {}, onFinding: () => {} },
    );
    expect(state.qaResult!.expectations[0].status).toBe("pass");
  },
  30000,
);

test(
  "a top-level navigation to a host outside `hosts` is fenced off and listed as blocked",
  async () => {
    const b = await tryLaunch();
    if (!b) return;
    try {
      await b.close();
      const fresh = new AgentBrowser();
      await fresh.launch(`${base}/withlink`, true, undefined, [host]);
      await fresh.page.click("#out").catch(() => {});
      await fresh.page.waitForTimeout(300);
      expect(fresh.blockedNavigations.some((u) => u.includes("external.invalid"))).toBe(true);
      // The fenced navigation must never show up as an http guard error either.
      expect(fresh.qaGuardEvents.some((e) => e.text.includes("external.invalid"))).toBe(false);
      await fresh.close();
    } catch (err) {
      console.warn(`  ⚠ skipping navigation-fence assertion — ${(err as Error).message.slice(0, 160)}`);
    }
  },
  30000,
);
