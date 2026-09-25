import Anthropic from "@anthropic-ai/sdk";
import { AgentBrowser, type ComputerAction } from "./browser.js";
import { AnthropicDriver } from "./anthropicDriver.js";
import { readSubscriptionCreds } from "./subscriptionAuth.js";
import { addUsage } from "./pricing.js";
import { resolveSession, resolveJudgeCheck, evaluateGuards, qaNeedsCredentials, type QaSnapshot } from "./qa.js";
import type { AgentCallbacks, AgentContext } from "./agent.js";
import type { AgentState, Finding, Persona, QaConfig, QaExpectCheck, QaExpectationResult, RunOptions, TokenUsage } from "./types.js";

/**
 * QA mode's navigator loop: drives a real browser toward the states a mission's answer key
 * names, takes a snapshot after the start load and after every action, and lets qa.ts's pure
 * `resolveSession` grade everything code-side. No persona, no findings pressure, no patience
 * budget — the navigator's only job is to reach states; code (or the judge, for `judge`
 * checks) decides pass/fail. Mirrors agent.ts's runLlmAgent, but stripped to what QA needs.
 */

const BODY_GUARD_PATTERN = /Error 1101|Worker threw exception/;

function checkGoalLine(c: QaExpectCheck): string {
  const scope = c.on ? `On ${c.on}: ` : "";
  switch (c.kind) {
    case "url":
      return `Navigate so the URL ${c.equals ? `path is ${c.equals}` : c.contains ? `path contains ${c.contains}` : ""}${
        c.query ? ` with query ${JSON.stringify(c.query)}` : ""
      }.`;
    case "text": {
      const target = c.selector ? `element "${c.selector}"` : "the page";
      if (c.absent !== undefined) return `${scope}${target} should NOT show ${typeof c.absent === "string" ? `"${c.absent}"` : "its loading/placeholder content"}.`;
      if (c.equals !== undefined) return `${scope}${target} should read exactly "${c.equals}".`;
      return `${scope}${target} should contain "${c.contains}".`;
    }
    case "attr":
      return `${scope}element "${c.selector}" attribute "${c.name}" should ${c.equals !== undefined ? `equal "${c.equals}"` : `start with "${c.startsWith}"`}.`;
    case "cookie":
      return `${scope}cookie "${c.name}" should be set${c.value ? ` to "${c.value}"` : ""}.`;
    case "judge":
      return `${scope}be able to answer: "${c.ask}"`;
  }
}

function qaSystemPrompt(qa: QaConfig, task: string): string {
  const goals = qa.expect
    .filter((c) => c.kind === "judge" || (c.when ?? "reach") === "reach")
    .map((c) => `- ${checkGoalLine(c)}`)
    .join("\n");
  return `You are a QA navigator driving a real browser toward specific, verifiable states. You are not role-playing a persona and you are not the judge — code and a separate grading pass decide pass/fail from what you reach. Your only job is to get there.

# Task
${task}

# States to reach
${goals || "(none — just follow the task above)"}

# How to behave
- Move directly and efficiently toward these states.
- Stay on this site: ${qa.hosts.join(", ")}.
- Screenshots are your only eyes. If a click seems to do nothing, take a screenshot to check before assuming.
- If something is clearly broken along the way, call report_finding — but reaching the target states comes first.
- Call task_result the moment you believe you've reached the target states, or if you're stuck and cannot proceed. Do not continue after that.`;
}

async function gradeJudge(
  checks: QaExpectCheck[],
  snapshots: QaSnapshot[],
  opts: RunOptions,
): Promise<{ results: QaExpectationResult[]; usage?: TokenUsage }> {
  const visitedOf = (c: QaExpectCheck) => {
    const relevant = snapshots.filter((s) => {
      try {
        return new URL(s.url).pathname.startsWith(c.on!);
      } catch {
        return false;
      }
    });
    return { visited: relevant.length > 0, snapshot: relevant[relevant.length - 1] };
  };

  let auth: { authToken?: string; model?: string } | null = null;
  if (!opts.mock) {
    const envAnthropic = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
    if (envAnthropic) auth = {};
    else if (opts.provider === "subscription") {
      try {
        auth = { authToken: readSubscriptionCreds().token, model: "claude-haiku-4-5" };
      } catch {
        auth = null;
      }
    }
  }

  const perCheck = checks.map((c) => ({ check: c, ...visitedOf(c) }));
  if (!auth) return { results: perCheck.map((p) => resolveJudgeCheck(p.check, p.visited)) };

  const toGrade = perCheck.filter((p) => p.visited);
  if (toGrade.length === 0) return { results: perCheck.map((p) => resolveJudgeCheck(p.check, false)) };

  const client = auth.authToken
    ? new Anthropic({ authToken: auth.authToken, apiKey: null, defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" } })
    : new Anthropic();
  const model = auth.model ?? "claude-opus-5";

  const content: Anthropic.ContentBlockParam[] = [
    {
      type: "text",
      text:
        "Grade each question below against the captured page text and screenshot. For each, answer pass or fail, " +
        "quote the EXACT verbatim text (word-for-word, from what you were shown) that supports your answer, and " +
        "one short note. Never invent a quote — if nothing supports an answer, quote the closest relevant text " +
        "and say so in the note.",
    },
  ];
  toGrade.forEach((p, i) => {
    content.push({
      type: "text",
      text: `\n--- Question ${i} ---\nAsk: ${p.check.ask}\nExpected: ${p.check.answer}\nPage text:\n${p.snapshot!.bodyText.slice(0, 4000)}`,
    });
    if (p.snapshot!.screenshot) {
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.snapshot!.screenshot } });
    }
  });

  const response = await client.messages.create({
    model,
    max_tokens: 4000,
    messages: [{ role: "user", content }],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            verdicts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  index: { type: "integer" },
                  status: { type: "string", enum: ["pass", "fail"] },
                  quote: { type: "string" },
                  note: { type: "string" },
                },
                required: ["index", "status", "quote", "note"],
                additionalProperties: false,
              },
            },
          },
          required: ["verdicts"],
          additionalProperties: false,
        },
      },
    },
  } as Anthropic.MessageCreateParamsNonStreaming);

  const usage: TokenUsage = {
    input: response.usage.input_tokens,
    output: response.usage.output_tokens,
    cacheRead: response.usage.cache_read_input_tokens ?? 0,
    cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
  };
  const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
  const parsed =
    response.stop_reason === "refusal"
      ? { verdicts: [] as { index: number; status: "pass" | "fail"; quote: string; note: string }[] }
      : (JSON.parse(text) as { verdicts: { index: number; status: "pass" | "fail"; quote: string; note: string }[] });

  const results = perCheck.map((p) => {
    if (!p.visited) return resolveJudgeCheck(p.check, false);
    const gradeIdx = toGrade.indexOf(p);
    const v = parsed.verdicts.find((v) => v.index === gradeIdx);
    if (!v) return resolveJudgeCheck(p.check, true);
    return resolveJudgeCheck(p.check, true, { status: v.status, quote: v.quote }, p.snapshot!.bodyText);
  });
  return { results, usage };
}

export async function runQaAgent(
  agentId: string,
  persona: Persona,
  opts: RunOptions,
  cb: AgentCallbacks,
  ctx: AgentContext = {},
): Promise<AgentState> {
  const qa = opts.qa!;
  const maxSteps = qa.maxSteps ?? 12;
  const state: AgentState = {
    agentId,
    personaId: persona.id,
    personaName: persona.name,
    emoji: persona.emoji,
    status: "starting",
    step: 0,
    lastThought: "",
    lastAction: "",
    modality: "vision",
  };
  const push = () => cb.onState({ ...state });
  const browser = new AgentBrowser();
  const snapshots: QaSnapshot[] = [];
  let usage: TokenUsage | undefined;

  const capture = async (step: number): Promise<QaSnapshot> => {
    const selectorSet = [...new Set(qa.expect.filter((c) => c.kind === "text" || c.kind === "attr").map((c) => c.selector ?? ""))];
    const { bodyText, selectors, cookies } = await browser.qaSnapshot(selectorSet);
    const host = (() => {
      try {
        return new URL(browser.page.url()).hostname;
      } catch {
        return "";
      }
    })();
    const match = bodyText.match(BODY_GUARD_PATTERN);
    if (match) browser.qaGuardEvents.push({ kind: "body", host, text: match[0] });
    const screenshot = await browser.screenshot();
    state.screenshot = screenshot;
    const snap: QaSnapshot = { step, url: browser.page.url(), docStatus: browser.qaDocStatus, bodyText, cookies, selectors, screenshot };
    snapshots.push(snap);
    return snap;
  };

  try {
    push();
    if (ctx.signal?.aborted) {
      state.status = "stopped";
      state.lastThought = "(stopped by operator)";
      push();
      return state;
    }
    await browser.launch(opts.url, opts.headless, undefined, qa.hosts);
    state.status = "browsing";
    push();
    await capture(0);

    // Zero-model-call fast path: nothing here needs the navigator or a judge call at all.
    if (qaNeedsCredentials(qa)) {
      const isResolved = () => resolveSession(qa.expect, snapshots).every((r) => r.status === "pass");
      if (!isResolved()) {
        const driver = new AnthropicDriver(opts, "vision", false, false);
        driver.init(qaSystemPrompt(qa, opts.task), { image: snapshots[0].screenshot });
        let finished = false;
        for (let step = 0; step < maxSteps && !finished && !isResolved(); step++) {
          if (ctx.signal?.aborted) {
            state.status = "stopped";
            state.lastThought = "(stopped by operator)";
            push();
            return state;
          }
          state.step = step + 1;
          browser.setStep(state.step);
          state.status = "thinking";
          push();

          const turn = await driver.next();
          if (turn.usage) {
            usage = usage ? addUsage(usage, turn.usage) : turn.usage;
            cb.onUsage?.(turn.usage);
          }
          if (turn.refusal) {
            state.status = "error";
            state.lastThought = "(request declined by safety classifiers)";
            push();
            break;
          }
          for (const thought of turn.thoughts) {
            state.lastThought = thought;
            cb.onThought(thought);
            push();
          }
          for (const call of turn.toolCalls) {
            if (call.name === "computer") {
              state.status = "browsing";
              let desc = "";
              try {
                const input = call.input as unknown as ComputerAction;
                state.lastAction = input.action;
                push();
                desc = await browser.execute(input);
                await browser.page.waitForTimeout(400);
              } catch (err) {
                desc = `action failed: ${(err as Error).message}`;
              }
              const snap = await capture(state.step);
              state.lastAction = desc.slice(0, 120);
              push();
              driver.addToolResult(call.id, desc, { image: snap.screenshot });
            } else if (call.name === "report_finding") {
              const f = call.input as { severity: Finding["severity"]; title: string; description: string };
              cb.onFinding({ ...f, evidence: { recent: [], screenshot: state.screenshot } });
              driver.addToolResult(call.id, "Finding recorded. Continue.");
            } else if (call.name === "task_result") {
              const r = call.input as { outcome: "completed" | "gave_up"; reason: string };
              state.lastThought = r.reason;
              cb.onThought(r.reason);
              push();
              driver.addToolResult(call.id, "Session ended.");
              finished = true;
            } else {
              driver.addToolResult(call.id, `Unknown tool: ${call.name}`);
            }
          }
          if (turn.endTurn && turn.toolCalls.length === 0) break;
        }
      }
    }

    state.status = "done";
    push();
  } catch (err) {
    state.status = "error";
    state.lastThought = `error: ${(err as Error).message}`;
    push();
  } finally {
    await browser.close();
  }

  const codeResults = resolveSession(qa.expect, snapshots);
  const judgeChecks = qa.expect.filter((c) => c.kind === "judge");
  let judgeResults: QaExpectationResult[] = [];
  if (judgeChecks.length > 0) {
    const graded = await gradeJudge(judgeChecks, snapshots, opts).catch(() => ({
      results: judgeChecks.map((c) => resolveJudgeCheck(c, false)),
      usage: undefined as TokenUsage | undefined,
    }));
    judgeResults = graded.results;
    if (graded.usage) {
      usage = usage ? addUsage(usage, graded.usage) : graded.usage;
      cb.onUsage?.(graded.usage);
    }
  }

  state.qaResult = {
    expectations: [...codeResults, ...judgeResults],
    guards: evaluateGuards(browser.qaGuardEvents, qa.hosts, qa.ignore),
    blockedNavigations: [...browser.blockedNavigations],
    usage,
  };
  return state;
}
