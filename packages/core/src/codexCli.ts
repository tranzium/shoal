import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { TokenUsage } from "./types.js";

interface CodexInvocation {
  text: string;
  threadId?: string;
  usage: TokenUsage;
}

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

let commandPromise: Promise<{ command: string; prefix: string[] }> | undefined;
let authPromise: Promise<void> | undefined;

function cleanCodexEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Codex CLI should use its ChatGPT login for Shoal. Never let a platform API key in
  // the parent shell or .env silently change that billing path.
  delete env.OPENAI_API_KEY;
  delete env.SHOAL_OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

async function resolveCodexCommand(): Promise<{ command: string; prefix: string[] }> {
  if (commandPromise) return commandPromise;
  commandPromise = (async () => {
    if (process.env.SHOAL_CODEX_CLI_JS) {
      const js = resolve(process.env.SHOAL_CODEX_CLI_JS);
      await access(js);
      return { command: process.execPath, prefix: [js] };
    }

    if (process.platform === "win32") {
      for (const entry of (process.env.PATH ?? "").split(delimiter)) {
        if (!entry) continue;
        const shim = join(entry, "codex.cmd");
        const js = join(dirname(shim), "node_modules", "@openai", "codex", "bin", "codex.js");
        try {
          await access(shim);
          await access(js);
          return { command: process.execPath, prefix: [js] };
        } catch {
          // Try the next PATH entry.
        }
      }
      throw new Error(
        "Could not resolve the Codex CLI JavaScript entry point on PATH. " +
          "Install Codex CLI or set SHOAL_CODEX_CLI_JS to its bin/codex.js path.",
      );
    }

    return { command: process.env.SHOAL_CODEX_COMMAND || "codex", prefix: [] };
  })();
  return commandPromise;
}

function runProcess(args: string[], prompt?: string, cwd = process.cwd()): Promise<ProcessResult> {
  return new Promise(async (resolvePromise, reject) => {
    try {
      const { command, prefix } = await resolveCodexCommand();
      const finalArgs = [...prefix, ...args];
      if (prompt !== undefined) finalArgs.push("-");
      const child = spawn(command, finalArgs, {
        cwd,
        env: cleanCodexEnv(),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
      if (prompt !== undefined) child.stdin.end(prompt, "utf8");
      else child.stdin.end();
    } catch (err) {
      reject(err);
    }
  });
}

function usageFromJsonl(output: string): TokenUsage {
  let lastTurn: TokenUsage | undefined;
  let fallback: TokenUsage | undefined;
  const decode = (source: Record<string, unknown>): TokenUsage | undefined => {
    const totalInput = Number(source.input_tokens ?? source.inputTokens ?? 0);
    const cached = Number(
      source.cached_input_tokens ??
      source.cachedInputTokens ??
      (source.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ??
      0,
    );
    const out = Number(source.output_tokens ?? source.outputTokens ?? 0);
    const written = Number(source.cache_write_input_tokens ?? source.cacheWriteInputTokens ?? 0);
    if (![totalInput, cached, out, written].every(Number.isFinite) || !(totalInput || out || written)) return undefined;
    return {
      input: Math.max(0, totalInput - cached),
      output: out,
      cacheRead: Math.max(0, cached),
      cacheWrite: Math.max(0, written),
    };
  };
  for (const line of output.split(/\r?\n/)) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = row.payload && typeof row.payload === "object"
      ? row.payload as Record<string, unknown>
      : null;
    if (row.type === "token_usage_record" && payload) {
      const turn = payload.turn_token_usage && typeof payload.turn_token_usage === "object"
        ? payload.turn_token_usage as Record<string, unknown>
        : payload.usage as Record<string, unknown> | undefined;
      if (turn) lastTurn = decode(turn) ?? lastTurn;
      continue;
    }
    if (row.type === "event_msg" && payload?.type === "token_count") {
      const info = payload.info && typeof payload.info === "object" ? payload.info as Record<string, unknown> : {};
      const perTurn = info.last_token_usage && typeof info.last_token_usage === "object"
        ? info.last_token_usage as Record<string, unknown>
        : undefined;
      const total = info.total_token_usage && typeof info.total_token_usage === "object"
        ? info.total_token_usage as Record<string, unknown>
        : undefined;
      if (perTurn) lastTurn = decode(perTurn) ?? lastTurn;
      else if (total) fallback = decode(total) ?? fallback;
      continue;
    }
    const event = payload ?? row;
    const nested = event.usage && typeof event.usage === "object" ? event.usage as Record<string, unknown> : null;
    const decoded = decode(nested ?? event);
    if (decoded) fallback = decoded;
  }
  return lastTurn ?? fallback ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function decodeCodexUsage(source: Record<string, unknown>): TokenUsage | undefined {
  const totalInput = Number(source.input_tokens ?? 0);
  const cached = Number(source.cached_input_tokens ?? 0);
  const out = Number(source.output_tokens ?? 0);
  const written = Number(source.cache_write_input_tokens ?? 0);
  if (![totalInput, cached, out, written].every(Number.isFinite) || !(totalInput || out || written)) return undefined;
  return {
    input: Math.max(0, totalInput - cached),
    output: out,
    cacheRead: Math.max(0, cached),
    cacheWrite: Math.max(0, written),
  };
}

async function locateSessionFile(threadId: string): Promise<string | undefined> {
  const root = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
  const now = new Date();
  const dayDir = join(root, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
  try {
    const direct = (await readdir(dayDir)).find((name) => name.endsWith(`${threadId}.jsonl`));
    if (direct) return join(dayDir, direct);
  } catch {
    return undefined;
  }
  return undefined;
}

/** Read the exact last-turn usage from Codex's local transcript; CLI stdout may be cumulative. */
async function usageFromSessionFile(path: string, threadId: string): Promise<TokenUsage | undefined> {
  try {
    const lines = (await readFile(path, "utf8")).split(/\r?\n/);
    let last: TokenUsage | undefined;
    for (const line of lines) {
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const payload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
      if (payload.thread_id !== threadId) continue;
      if (row.type === "token_usage_record") {
        const turn = payload.turn_token_usage && typeof payload.turn_token_usage === "object"
          ? payload.turn_token_usage as Record<string, unknown>
          : undefined;
        if (turn) last = decodeCodexUsage(turn) ?? last;
      } else if (row.type === "event_msg" && payload.type === "token_count") {
        const info = payload.info && typeof payload.info === "object" ? payload.info as Record<string, unknown> : {};
        const usage = info.last_token_usage && typeof info.last_token_usage === "object"
          ? info.last_token_usage as Record<string, unknown>
          : undefined;
        if (usage) last = decodeCodexUsage(usage) ?? last;
      }
    }
    return last;
  } catch {
    return undefined;
  }
}

function threadIdFromJsonl(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const event = row.payload && typeof row.payload === "object"
      ? row.payload as Record<string, unknown>
      : row;
    const id = row.thread_id ?? event.thread_id ?? (event.thread as Record<string, unknown> | undefined)?.id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

function assertSuccess(result: ProcessResult): void {
  if (result.code !== 0) {
    const details = `${result.stderr}\n${result.stdout}`.trim().slice(-1800);
    throw new Error(`Codex CLI exited with status ${result.code}${details ? `: ${details}` : ""}`);
  }
}

export async function ensureCodexChatGptLogin(): Promise<void> {
  authPromise ??= (async () => {
    const result = await runProcess(["login", "status"]);
    const status = `${result.stdout}\n${result.stderr}`.trim();
    if (result.code !== 0 || !/logged in using chatgpt/i.test(status)) {
      throw new Error(
        "Shoal's Codex provider requires `codex login` with ChatGPT subscription access. " +
          `Current Codex login status: ${status || "not logged in"}. Run codex login and choose ChatGPT sign-in.`,
      );
    }
  })();
  return authPromise;
}

export interface CodexJsonOptions {
  prompt: string;
  schema: Record<string, unknown>;
  model?: string;
  images?: string[];
}

/** One-shot structured response, used for persona synthesis and optional finding review. */
export async function codexJson(options: CodexJsonOptions): Promise<{ value: unknown; usage: TokenUsage }> {
  await ensureCodexChatGptLogin();
  const dir = await mkdtemp(join(tmpdir(), "shoal-codex-"));
  try {
    const schemaPath = join(dir, "schema.json");
    const resultPath = join(dir, "response.json");
    await writeFile(schemaPath, JSON.stringify(options.schema), "utf8");
    const args = [
      "exec", "--json", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", dir,
      "--output-schema", schemaPath, "--output-last-message", resultPath,
    ];
    if (options.model) args.push("--model", options.model);
    for (const image of options.images ?? []) args.push("--image", image);
    const result = await runProcess(args, options.prompt, dir);
    assertSuccess(result);
    const text = await readFile(resultPath, "utf8");
    return { value: JSON.parse(text), usage: usageFromJsonl(result.stdout) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export class CodexSession {
  private dirPromise = mkdtemp(join(tmpdir(), "shoal-codex-agent-"));
  private threadId?: string;
  private turn = 0;
  private closed = false;
  private sessionFile?: string;

  async getDirectory(): Promise<string> {
    return this.dirPromise;
  }

  async next(prompt: string, schema: Record<string, unknown>, options: { model?: string; image?: string } = {}): Promise<CodexInvocation> {
    await ensureCodexChatGptLogin();
    if (this.closed) throw new Error("Codex session is already closed");
    const dir = await this.dirPromise;
    const schemaPath = join(dir, "turn-schema.json");
    const resultPath = join(dir, `turn-${++this.turn}.json`);
    await writeFile(schemaPath, JSON.stringify(schema), "utf8");
    const args = this.threadId
      ? ["exec", "resume", "--json", "--skip-git-repo-check", "--output-schema", schemaPath, "--output-last-message", resultPath]
      : [
          "exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", dir,
          "--output-schema", schemaPath, "--output-last-message", resultPath,
        ];
    if (options.model) args.push("--model", options.model);
    if (options.image) args.push("--image", options.image);
    if (this.threadId) args.push(this.threadId);
    const result = await runProcess(args, prompt, dir);
    assertSuccess(result);
    this.threadId ??= threadIdFromJsonl(result.stdout);
    if (!this.threadId) throw new Error("Codex CLI did not return a session id; cannot continue the browser session");
    this.sessionFile ??= await locateSessionFile(this.threadId);
    const text = await readFile(resultPath, "utf8");
    const usage = (this.sessionFile ? await usageFromSessionFile(this.sessionFile, this.threadId) : undefined) ?? usageFromJsonl(result.stdout);
    return { text, threadId: this.threadId, usage };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const dir = await this.dirPromise;
    await rm(dir, { recursive: true, force: true });
  }
}
