import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runSwarm } from "./orchestrator.js";
import { writeTaskReport } from "./report.js";
import type { ShoalServer } from "./server.js";
import type { Finding, RunOptions, RunSummary } from "./types.js";

/**
 * FIFO task intake for `shoal serve`. Exactly one task runs at a time; the next starts
 * when the current one finishes. In-memory only — a restart drops anything still queued
 * (README says so; nothing here persists across process restarts).
 */

export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export type TaskInput = Record<string, unknown>;

export interface TaskSummary {
  id: string;
  title: string;
  url: string;
  task: string;
  swarm: number;
  strategy?: string;
  personas?: string[];
  status: TaskStatus;
  position: number | null;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  summary?: RunSummary;
  reportPath?: string;
  error?: string;
}

interface InternalTask extends TaskSummary {
  login?: { email: string; password: string };
  findings: Finding[];
  abort?: AbortController;
}

function toSummary(t: InternalTask): TaskSummary {
  const { login: _login, findings: _findings, abort: _abort, ...summary } = t;
  return summary;
}

export type SubmitResult = { ok: true; task: TaskSummary } | { ok: false; error: string };

export class TaskQueue {
  private queued: InternalTask[] = [];
  private running?: InternalTask;
  private history: InternalTask[] = [];
  private seq = 0;
  private pumping = false;

  constructor(
    private server: ShoalServer,
    private base: RunOptions,
  ) {}

  submit(input: TaskInput): SubmitResult {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (!url) return { ok: false, error: "url is required" };
    try {
      new URL(url);
    } catch {
      return { ok: false, error: "url must be a valid absolute URL" };
    }

    const task = typeof input.task === "string" ? input.task.trim() : "";
    if (!task) return { ok: false, error: "task is required" };

    // Only url/task are rejected with 400; swarm just clamps to a sane range (0 is used by
    // tests — a zero-agent run resolves with no browser launched, same convention runSwarm
    // itself uses elsewhere).
    let swarm = 1;
    if (input.swarm !== undefined) {
      const n = Number(input.swarm);
      swarm = Number.isFinite(n) ? Math.max(0, Math.min(Math.round(n), 5000)) : 1;
    }

    const strategy = typeof input.strategy === "string" ? input.strategy : undefined;
    const personas =
      Array.isArray(input.personas) && input.personas.every((p) => typeof p === "string")
        ? (input.personas as string[])
        : undefined;
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : task.slice(0, 60);

    let login: { email: string; password: string } | undefined;
    if (input.login && typeof input.login === "object") {
      const l = input.login as Record<string, unknown>;
      if (typeof l.email === "string" && l.email && typeof l.password === "string" && l.password) {
        login = { email: l.email, password: l.password };
      }
    }

    const id = `t${(++this.seq).toString(36)}${Date.now().toString(36).slice(-5)}`;
    const record: InternalTask = {
      id,
      title,
      url,
      task,
      swarm,
      strategy,
      personas,
      login,
      status: "queued",
      position: this.queued.length,
      createdAt: Date.now(),
      findings: [],
    };
    this.queued.push(record);
    this.broadcastQueue();
    this.schedulePump();
    return { ok: true, task: toSummary(record) };
  }

  list(): { queue: TaskSummary[]; history: TaskSummary[] } {
    return {
      queue: [...(this.running ? [this.running] : []), ...this.queued].map(toSummary),
      history: this.history.slice(-50).reverse().map(toSummary),
    };
  }

  get(id: string): TaskSummary | undefined {
    const t = this.findInternal(id);
    return t ? toSummary(t) : undefined;
  }

  async getReport(id: string): Promise<{ md: string; json: unknown } | undefined> {
    const t = this.findInternal(id);
    if (!t || !t.reportPath) return undefined;
    try {
      const dir = join(process.cwd(), "reports");
      const [md, jsonRaw] = await Promise.all([
        readFile(join(dir, `${id}.md`), "utf8"),
        readFile(join(dir, `${id}.json`), "utf8"),
      ]);
      return { md, json: JSON.parse(jsonRaw) };
    } catch {
      return undefined;
    }
  }

  /** Cancels a queued task outright, or aborts one already running. */
  cancel(id: string): boolean {
    const qi = this.queued.findIndex((t) => t.id === id);
    if (qi >= 0) {
      const [t] = this.queued.splice(qi, 1);
      t.status = "cancelled";
      t.finishedAt = Date.now();
      this.reindex();
      this.history.push(t);
      this.broadcastQueue();
      return true;
    }
    if (this.running?.id === id) {
      this.running.abort?.abort();
      return true;
    }
    return false;
  }

  private reindex(): void {
    this.queued.forEach((t, i) => (t.position = i));
  }

  private findInternal(id: string): InternalTask | undefined {
    if (this.running?.id === id) return this.running;
    return this.queued.find((t) => t.id === id) ?? this.history.find((t) => t.id === id);
  }

  private broadcastQueue(): void {
    this.server.broadcast({
      type: "task_queue",
      runningId: this.running?.id ?? null,
      runningTitle: this.running?.title ?? null,
      queueLength: this.queued.length,
    });
  }

  private schedulePump(): void {
    if (this.pumping) return;
    this.pumping = true;
    void this.pumpLoop();
  }

  private async pumpLoop(): Promise<void> {
    while (true) {
      const next = this.queued.shift();
      if (!next) break;
      this.reindex();
      await this.execute(next);
    }
    this.pumping = false;
  }

  private async execute(task: InternalTask): Promise<void> {
    task.status = "running";
    task.position = null;
    task.startedAt = Date.now();
    task.abort = new AbortController();
    this.running = task;
    this.server.resetRunState();
    this.server.setHealth("running", this.seq);
    this.broadcastQueue();
    this.server.broadcast({
      type: "run_state",
      phase: "running",
      swarm: task.swarm,
      strategy: task.strategy,
      task: task.title,
      runNumber: this.seq,
    });

    const secrets = task.login ? [task.login.email, task.login.password].filter(Boolean) : [];
    const opts: RunOptions = {
      ...this.base,
      url: task.url,
      task: task.task,
      swarm: task.swarm,
      concurrency: Math.max(1, Math.min(task.swarm, this.base.concurrency || task.swarm)),
      strategyIds: task.strategy ? [task.strategy] : undefined,
      personaIds: task.personas,
      login: task.login,
      open: false,
    };

    try {
      await runSwarm(opts, {
        server: this.server,
        signal: task.abort.signal,
        keepAlive: true,
        quiet: true,
        onFinding: (f) => task.findings.push(f),
        onDone: ({ findings, summary, reportPath }) => {
          task.findings = findings;
          task.summary = summary;
          task.reportPath = reportPath;
        },
        writeReport: (findings, summary, o) =>
          writeTaskReport(findings, summary, o, { id: task.id, title: task.title, startedAt: task.startedAt! }, secrets).then(
            (r) => r.mdPath,
          ),
      });
      task.status = task.abort.signal.aborted ? "cancelled" : "done";
    } catch (err) {
      task.status = "failed";
      task.error = (err as Error).message;
    } finally {
      task.finishedAt = Date.now();
      this.history.push(task);
      this.running = undefined;
      this.server.setHealth("idle", null);
      this.broadcastQueue();
      this.server.broadcast({
        type: "run_state",
        phase: "idle",
        swarm: task.swarm,
        task: "",
        runNumber: this.seq,
      });
    }
  }
}
