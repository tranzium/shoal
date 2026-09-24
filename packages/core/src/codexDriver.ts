import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  A11Y_TOOL_DESCRIPTION,
  A11Y_TOOL_NAME,
  A11Y_TOOL_SCHEMA,
  BROWSER_TOOL_DESCRIPTION,
  BROWSER_TOOL_NAME,
  BROWSER_TOOL_SCHEMA,
  FINDING_DESCRIPTION,
  FINDING_SCHEMA,
  RESULT_DESCRIPTION,
  RESULT_SCHEMA,
  SIGNAL_SCHEMA,
  AWAIT_SCHEMA,
  type AgentDriver,
  type ModelTurn,
  type Observation,
  type TurnProgress,
} from "./driver.js";
import { CodexSession } from "./codexCli.js";
import { DISPLAY_HEIGHT, DISPLAY_WIDTH } from "./browser.js";
import type { RunOptions } from "./types.js";

const TOOL_NAMES = ["computer", BROWSER_TOOL_NAME, A11Y_TOOL_NAME, "report_finding", "task_result", "signal", "await_signal"] as const;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    thoughts: { type: "array", items: { type: "string" }, maxItems: 3 },
    toolCalls: {
      type: "array",
      maxItems: 1,
      items: {
        type: "object",
        properties: {
          name: { type: "string", enum: TOOL_NAMES },
          inputJson: { type: "string", description: "A JSON-encoded object containing the selected tool's arguments." },
        },
        required: ["name", "inputJson"],
        additionalProperties: false,
      },
    },
    endTurn: { type: "boolean" },
  },
  required: ["thoughts", "toolCalls", "endTurn"],
  additionalProperties: false,
};

const COMPUTER_ACTIONS = [
  "screenshot", "left_click", "double_click", "right_click", "type", "key", "scroll", "left_click_drag", "mouse_move", "wait",
];

function toolInstructions(modality: "vision" | "a11y", withScene: boolean): string {
  const perception = modality === "a11y"
    ? `Use the ${A11Y_TOOL_NAME} tool with this input schema: ${JSON.stringify(A11Y_TOOL_SCHEMA)}\n${A11Y_TOOL_DESCRIPTION}`
    : [
        `Use the ${BROWSER_TOOL_NAME} tool with this schema: ${JSON.stringify(BROWSER_TOOL_SCHEMA)}\n${BROWSER_TOOL_DESCRIPTION}`,
        `Prefer browser actions on the named controls in the latest page snapshot. Refs are fresh for one page state; after an action, use the newly supplied refs. Use the computer tool only when a page element cannot be targeted semantically, such as a canvas or a precise visual gesture.`,
        `The computer tool viewport is ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}. Valid actions: ${COMPUTER_ACTIONS.join(", ")}. Input fields: action, coordinate [x,y], start_coordinate [x,y], text, scroll_direction, scroll_amount, duration. Use screenshot to inspect without acting.`,
      ].join("\n\n");
  return [
    perception,
    `Use report_finding with this schema: ${JSON.stringify(FINDING_SCHEMA)}\n${FINDING_DESCRIPTION}`,
    `Use task_result with this schema: ${JSON.stringify(RESULT_SCHEMA)}\n${RESULT_DESCRIPTION}`,
    ...(withScene
      ? [
          `Use signal with this schema: ${JSON.stringify(SIGNAL_SCHEMA)}.`,
          `Use await_signal with this schema: ${JSON.stringify(AWAIT_SCHEMA)}.`,
        ]
      : []),
  ].join("\n\n");
}

function parseResponse(text: string, withScene: boolean, modality: "vision" | "a11y"): ModelTurn {
  let parsed: {
    thoughts?: unknown;
    toolCalls?: Array<{ name?: unknown; inputJson?: unknown }>;
    endTurn?: unknown;
  };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error(`Codex did not return the required JSON turn: ${text.slice(0, 500)}`);
  }
  const allowed = new Set<string>([
    ...(modality === "a11y" ? [A11Y_TOOL_NAME] : ["computer", BROWSER_TOOL_NAME]),
    "report_finding",
    "task_result",
    ...(withScene ? ["signal", "await_signal"] : []),
  ]);
  const toolCalls = (Array.isArray(parsed.toolCalls) ? parsed.toolCalls : []).map((call) => {
    if (typeof call.name !== "string" || !allowed.has(call.name)) {
      throw new Error(`Codex returned an unsupported Shoal tool: ${String(call.name)}`);
    }
    if (typeof call.inputJson !== "string") throw new Error(`Codex tool ${call.name} did not include inputJson`);
    let input: unknown;
    try {
      input = JSON.parse(call.inputJson);
    } catch {
      throw new Error(`Codex returned invalid JSON for ${call.name}: ${call.inputJson.slice(0, 300)}`);
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error(`Codex arguments for ${call.name} must be a JSON object`);
    }
    return { id: randomUUID(), name: call.name, input: input as Record<string, unknown> };
  });
  return {
    thoughts: (Array.isArray(parsed.thoughts) ? parsed.thoughts : []).filter((x): x is string => typeof x === "string"),
    toolCalls,
    endTurn: parsed.endTurn === true || toolCalls.length === 0,
  };
}

export class CodexDriver implements AgentDriver {
  private session = new CodexSession();
  private system = "";
  private first?: Observation;
  private pending: { id: string; text: string }[] = [];
  private currentObservation?: Observation;
  private imagePath?: string;

  constructor(
    private opts: RunOptions,
    private modality: "vision" | "a11y" = "vision",
    private withScene = false,
  ) {}

  init(system: string, first: Observation): void {
    this.system = system;
    this.first = first;
    this.currentObservation = first;
  }

  addToolResult(id: string, text: string, obs?: Observation): void {
    this.pending.push({ id, text });
    if (obs?.image || obs?.text) this.currentObservation = obs;
  }

  private async saveCurrentImage(): Promise<string | undefined> {
    const image = this.currentObservation?.image;
    if (!image) return undefined;
    const dir = await this.sessionDirectory();
    this.imagePath ??= join(dir, "current-screen.jpg");
    await writeFile(this.imagePath, Buffer.from(image, "base64"));
    return this.imagePath;
  }

  private async sessionDirectory(): Promise<string> {
    // The session creates this directory lazily. Keeping screenshots next to its local
    // transcript makes them available to `codex exec resume --image` for each turn.
    return this.session.getDirectory();
  }

  async next(progress?: TurnProgress): Promise<ModelTurn> {
    const image = await this.saveCurrentImage();
    const opening = this.first;
    this.first = undefined;
    const prompt = opening
      ? [
          "You are the reasoning model for one simulated Shoal user in an already-open browser.",
          "This is a user-testing role. Never use Codex's shell, file, or other internal tools; only return Shoal tool calls as JSON.",
          "Return exactly one JSON object matching the required response schema. Include one short first-person thought and exactly one Shoal tool call each turn. Use an empty toolCalls array and endTurn=true only if no further action is appropriate.",
          "Do not claim the browser performed an action unless a later observation confirms it.",
          "\n# Role and task\n" + this.system,
          "\n# Available Shoal tools\n" + toolInstructions(this.modality, this.withScene),
          opening.text
            ? `\n# ${this.modality === "a11y" ? "Initial accessibility observation" : "Initial page text and named controls"}\n${opening.text}`
            : "\nThe browser is open. Inspect the attached screenshot and begin.",
        ].join("\n")
      : [
          "Continue the same Shoal user-testing session. Return exactly one JSON object matching the required response schema.",
          "Include one short first-person thought and exactly one Shoal tool call each turn. Never use Codex's shell, file, or other internal tools.",
          "\n# Results from the last browser step\n" + this.pending.map((r) => `Tool call ${r.id}: ${r.text}`).join("\n"),
          ...(this.currentObservation?.text
            ? [`\n# ${this.modality === "a11y" ? "Current accessibility observation" : "Current page text and named controls"}\n${this.currentObservation.text}`]
            : []),
        ].join("\n");
    const remaining = progress ? progress.maxSteps - progress.step + 1 : Number.POSITIVE_INFINITY;
    const budgetNote = remaining <= 1
      ? "\n# Turn limit\nThis is your final turn. Do not browse further. Return task_result now with your honest conclusion and all requested offer feedback."
      : remaining <= 2
        ? "\n# Turn limit\nYou have one browsing turn left after this response. Gather only essential detail; use task_result on your next turn."
        : "";
    this.pending = [];
    const model = this.opts.model === "codex" ? undefined : this.opts.model;
    const response = await this.session.next(prompt + budgetNote, RESPONSE_SCHEMA, { model, image });
    const turn = parseResponse(response.text, this.withScene, this.modality);
    turn.usage = response.usage;
    return turn;
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}
