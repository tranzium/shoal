import Anthropic from "@anthropic-ai/sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codexJson } from "./codexCli.js";
import type { Finding, TokenUsage } from "./types.js";

/**
 * The editor-in-chief pass: cheap models (or grounding slips on any model) produce
 * findings that are artifacts of the agent, not the site — "the button doesn't work"
 * when the agent simply missed it. One strong Claude call reviews every finding
 * against the agent's action trail + screenshot and marks it confirmed or suspect.
 * Suspect findings stay in the report, flagged for human review, never silently dropped.
 */

const MAX_SCREENSHOTS = 16;

export async function verifyFindings(
  findings: Finding[],
  task: string,
  auth?: { authToken?: string; model?: string },
): Promise<TokenUsage | undefined> {
  if (findings.length === 0) return undefined;
  // OAuth (subscription) tokens need the oauth beta header on every request.
  const client = auth?.authToken
    ? new Anthropic({ authToken: auth.authToken, apiKey: null, defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" } })
    : new Anthropic();
  const model = auth?.model ?? "claude-opus-5";

  const content: Anthropic.ContentBlockParam[] = [
    {
      type: "text",
      text:
        `Simulated user-testing agents attempted this task on a website: "${task}".\n` +
        `Below are the usability findings they filed, each with the agent's persona, its recent ` +
        `thoughts/actions before filing, and (for some) the screenshot at that moment.\n\n` +
        `For each finding, judge: is this plausibly a real problem with the SITE, or likely an ` +
        `artifact of the AGENT (missed click, hallucinated element, misread screen, persona ` +
        `over-dramatizing something normal)? Lean "confirmed" when the evidence is consistent; ` +
        `use "suspect" when the action trail contradicts the claim or the claim is unfalsifiable ` +
        `from the evidence.`,
    },
  ];

  findings.forEach((f, i) => {
    content.push({
      type: "text",
      text:
        `\n--- Finding ${i} ---\n` +
        `Persona: ${f.personaName}\nSeverity: ${f.severity}\nTitle: ${f.title}\n` +
        `Description: ${f.description}\n` +
        `Recent trail:\n${(f.evidence?.recent ?? []).map((r) => `  - ${r}`).join("\n") || "  (none)"}`,
    });
    if (f.evidence?.screenshot && i < MAX_SCREENSHOTS) {
      content.push({ type: "text", text: `Screenshot at the moment of finding ${i}:` });
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: f.evidence.screenshot },
      });
    }
  });

  const response = await client.messages.create({
    model,
    max_tokens: 16000,
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
                  status: { type: "string", enum: ["confirmed", "suspect"] },
                  note: { type: "string", description: "One sentence: why" },
                },
                required: ["index", "status", "note"],
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
  if (response.stop_reason === "refusal") return usage;
  const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
  const parsed = JSON.parse(text) as { verdicts: { index: number; status: "confirmed" | "suspect"; note: string }[] };
  for (const v of parsed.verdicts ?? []) {
    const f = findings[v.index];
    if (f) f.verdict = { status: v.status, note: v.note };
  }
  return usage;
}

/** Run the same evidence review through the local Codex CLI ChatGPT login. */
export async function verifyFindingsWithCodex(
  findings: Finding[],
  task: string,
  model?: string,
): Promise<TokenUsage | undefined> {
  if (findings.length === 0) return undefined;
  const dir = await mkdtemp(join(tmpdir(), "shoal-codex-verify-"));
  try {
    const images: string[] = [];
    const imageWrites: Promise<void>[] = [];
    const rows = findings.map((f, i) => {
      let imageNote = "";
      if (f.evidence?.screenshot && images.length < MAX_SCREENSHOTS) {
        const image = join(dir, `finding-${i}.jpg`);
        imageWrites.push(writeFile(image, Buffer.from(f.evidence.screenshot, "base64")));
        images.push(image);
        imageNote = `\nScreenshot attachment ${images.length}: evidence for this finding.`;
      }
      return (
        `\nFinding ${i}:\nPersona: ${f.personaName}\nSeverity: ${f.severity}\nTitle: ${f.title}\n` +
        `Description: ${f.description}\nRecent trail:\n${(f.evidence?.recent ?? []).map((r) => `- ${r}`).join("\n") || "(none)"}${imageNote}`
      );
    });
    await Promise.all(imageWrites);
    const schema = {
      type: "object",
      properties: {
        verdicts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "integer" },
              status: { type: "string", enum: ["confirmed", "suspect"] },
              note: { type: "string" },
            },
            required: ["index", "status", "note"],
            additionalProperties: false,
          },
        },
      },
      required: ["verdicts"],
      additionalProperties: false,
    };
    const result = await codexJson({
      model,
      schema,
      images,
      prompt:
        `Simulated user-testing agents attempted this task on a website: "${task}". ` +
        `Review each finding against its action trail and attached screenshots. Mark "confirmed" when evidence is consistent with a real site problem; mark "suspect" when the issue may be an agent artifact, such as a missed click, hallucinated element, or misread screen. Keep suspect findings in the report. ` +
        `Return one verdict for each finding using its zero-based index.\n${rows.join("\n")}`,
    });
    const parsed = result.value as { verdicts?: { index: number; status: "confirmed" | "suspect"; note: string }[] };
    for (const verdict of parsed.verdicts ?? []) {
      const finding = findings[verdict.index];
      if (finding && (verdict.status === "confirmed" || verdict.status === "suspect")) {
        finding.verdict = { status: verdict.status, note: verdict.note };
      }
    }
    return result.usage;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
