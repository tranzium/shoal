import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runSwarm } from "./orchestrator.js";
import { writeTaskReport } from "./report.js";
import { credentialsError } from "./subscriptionAuth.js";
import { ZERO_USAGE } from "./pricing.js";
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
  /** Repro mode: unpacked extension dir this task's agents loaded. */
  extension?: string;
  /** Repro mode: text/regex the report's verdict is matched against. */
  expect?: string;
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
  ) {
    // Broadcast once at wire-up time, even with zero tasks yet — the dashboard uses the
    // presence of a task_queue event to tell "driven by the task queue" from a plain run,
    // and a late-joining or first-load dashboard should see that immediately, not only
    // after the first task lands.
    this.broadcastQueue();
  }

  submit(input: TaskInput): SubmitResult {
    let body = input;
    if (typeof input.mission === "string" && input.mission.trim()) {
      const name = input.mission.trim();
      const mission = this.server.dataStore?.getMission(name);
      if (!mission) return { ok: false, error: `unknown mission: ${name}` };
      // Mission fields are defaults; anything the caller also set (e.g. a login, or an
      // explicit swarm override) wins — same "in place of url/task" contract as the docs.
      const { mission: _mission, ...overrides } = input;
      body = {
        title: mission.title,
        url: mission.url,
        task: mission.task,
        strategy: mission.strategy,
        swarm: mission.swarm,
        personas: mission.personas,
        ...overrides,
      };
    }

    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) return { ok: false, error: "url is required" };
    try {
      new URL(url);
    } catch {
      return { ok: false, error: "url must be a valid absolute URL" };
    }

    const task = typeof body.task === "string" ? body.task.trim() : "";
    if (!task) return { ok: false, error: "task is required" };

    // Only url/task are rejected with 400; swarm just clamps to a sane range (0 is used by
    // tests — a zero-agent run resolves with no browser launched, same convention runSwarm
    // itself uses elsewhere).
    let swarm = 1;
    if (body.swarm !== undefined) {
      const n = Number(body.swarm);
      swarm = Number.isFinite(n) ? Math.max(0, Math.min(Math.round(n), 5000)) : 1;
    }

    const strategy = typeof body.strategy === "string" ? body.strategy : undefined;
    if (strategy) {
      const pool = this.server.dataStore?.getStrategies();
      if (pool && !pool.some((s) => s.id === strategy)) {
        return { ok: false, error: `unknown strategy "${strategy}". Available: ${pool.map((s) => s.id).join(", ")}` };
      }
    }
    const personas =
      Array.isArray(body.personas) && body.personas.every((p) => typeof p === "string")
        ? (body.personas as string[])
        : undefined;
    if (personas && personas.length > 0) {
      const pool = this.server.dataStore?.getPersonas();
      if (pool) {
        const unknown = personas.filter((id) => !pool.some((p) => p.id === id));
        if (unknown.length > 0) {
          return { ok: false, error: `unknown persona(s): ${unknown.join(", ")}. Available: ${pool.map((p) => p.id).join(", ")}` };
        }
      }
    }
    // A zero-agent task (used by tests, and a legitimate "just validate the request" case)
    // never touches the provider, so there's nothing to refuse here. A real task does — and
    // this is checked LIVE, not just at `serve` boot, because a subscription token rotates
    // hourly and can expire hours into a long-lived service's life.
    if (swarm > 0) {
      const credError = credentialsError(this.base.provider);
      if (credError) return { ok: false, error: credError };
    }

    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : task.slice(0, 60);
    const extension = typeof body.extension === "string" && body.extension.trim() ? body.extension.trim() : undefined;
    const expect = typeof body.expect === "string" && body.expect.trim() ? body.expect.trim() : undefined;

    let login: { email: string; password: string } | undefined;
    if (body.login && typeof body.login === "object") {
      const l = body.login as Record<string, unknown>;
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
      extension,
      expect,
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

  /** `not_found`: no task with this id (unknown or lost to a restart). `not_ready`: the task
   *  exists but never produced a report — still queued/running, or ended failed/cancelled. */
  async getReport(
    id: string,
  ): Promise<{ ok: true; md: string; json: unknown } | { ok: false; reason: "not_found" } | { ok: false; reason: "not_ready"; status: TaskStatus; error?: string }> {
    const t = this.findInternal(id);
    if (!t) return { ok: false, reason: "not_found" };
    if (!t.reportPath) return { ok: false, reason: "not_ready", status: t.status, error: t.error };
    try {
      const dir = join(process.cwd(), "reports");
      const [md, jsonRaw] = await Promise.all([
        readFile(join(dir, `${id}.md`), "utf8"),
        readFile(join(dir, `${id}.json`), "utf8"),
      ]);
      return { ok: true, md, json: JSON.parse(jsonRaw) };
    } catch {
      return { ok: false, reason: "not_ready", status: t.status, error: t.error };
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
    const last = this.history[this.history.length - 1];
    this.server.broadcast({
      type: "task_queue",
      runningId: this.running?.id ?? null,
      runningTitle: this.running?.title ?? null,
      queueLength: this.queued.length,
      lastTask: last ? { id: last.id, title: last.title, status: last.status, error: last.error } : null,
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
    console.log(`  ▶ task ${task.id} started — ${task.title}`);
    this.server.resetRunState();
    this.server.setHealth("running", this.seq);
    this.broadcastQueue();
    const strategies = this.server.dataStore?.getStrategies().map((s) => ({ id: s.id, name: s.name }));
    this.server.broadcast({
      type: "run_state",
      phase: "running",
      swarm: task.swarm,
      strategy: task.strategy,
      task: task.title,
      runNumber: this.seq,
      strategies,
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
      extension: task.extension,
      expect: task.expect,
      login: task.login,
      open: false,
    };

    // The service console stays quiet (many small tasks would otherwise flood it), but the
    // run is no longer silent overall: every log line runSwarm would have printed is captured
    // here and written to reports/<id>.log, so a task that hangs or fails leaves a transcript
    // behind instead of nothing.
    const logLines: string[] = [];

    try {
      await runSwarm(opts, {
        server: this.server,
        signal: task.abort.signal,
        keepAlive: true,
        quiet: true,
        log: (line) => logLines.push(line),
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
      // "Submit a task, get a report" should hold even when the task never got as far as
      // running an agent (e.g. a credential failure that slipped past the submit-time check).
      // Best-effort: the task's own failure is already recorded in task.error regardless.
      try {
        const summary: RunSummary = {
          total: task.swarm,
          completed: 0,
          gaveUp: 0,
          errored: 0,
          durationMs: Date.now() - (task.startedAt ?? Date.now()),
          usage: ZERO_USAGE,
          costUsd: 0,
        };
        const { mdPath } = await writeTaskReport(
          task.findings,
          summary,
          opts,
          { id: task.id, title: task.title, startedAt: task.startedAt!, status: "failed", error: task.error },
          secrets,
        );
        task.reportPath = mdPath;
      } catch {
        /* best-effort */
      }
    } finally {
      task.finishedAt = Date.now();
      this.history.push(task);
      this.running = undefined;
      if (logLines.length > 0) {
        try {
          const dir = join(process.cwd(), "reports");
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, `${task.id}.log`), logLines.join("\n") + "\n", "utf8");
        } catch {
          /* best-effort — the task's own outcome is already recorded regardless */
        }
      }
      if (task.status === "failed") console.log(`  ✗ task ${task.id} failed — ${task.error}`);
      else if (task.status === "cancelled") console.log(`  ⏹ task ${task.id} cancelled`);
      else console.log(`  ✓ task ${task.id} done — report: ${task.reportPath ?? "(none)"}`);
      // The task is over — any agent still cached as queued/mid-flight (never reached, or
      // launched but not finished when the task was aborted/failed) is stale: reconcile it
      // to `stopped` so the tank can't show a swarm that no longer exists.
      this.server.reconcileAgents();
      this.server.setHealth("idle", null);
      this.broadcastQueue();
      this.server.broadcast({
        type: "run_state",
        phase: "idle",
        swarm: task.swarm,
        task: "",
        runNumber: this.seq,
        strategies,
      });
    }
  }
}
