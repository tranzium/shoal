import { spawn } from "node:child_process";
import { platform } from "node:os";
import { runSwarm } from "./orchestrator.js";
import { ShoalServer } from "./server.js";
import { DataStore } from "./dataStore.js";
import { safeConcurrency } from "./capacity.js";
import { closeSharedBrowser } from "./browser.js";
import type { ControlCommand, RunOptions, RunPhase } from "./types.js";

/** How often to poll the data dir for edits — a strategy/mission tweak should show up in
 *  seconds, not on the next restart, but this is a stat() on a handful of files, not I/O
 *  worth spending less than a couple of seconds on. */
const DATA_WATCH_INTERVAL_MS = 2000;

export { safeConcurrency } from "./capacity.js";

/**
 * Pop the dashboard in a real browser window — preferring Chrome, in a NEW window, so it
 * never lands in an editor's embedded browser (clicking the URL in a Cursor/VS Code
 * terminal opens their built-in one) and the tank is watchable from second one.
 */
function openDashboard(url: string): void {
  const attempts: [string, string[]][] =
    platform() === "win32"
      ? [["cmd", ["/c", "start", "", "chrome", "--new-window", url]], ["cmd", ["/c", "start", "", url]]]
      : platform() === "darwin"
        ? [["open", ["-na", "Google Chrome", "--args", "--new-window", url]], ["open", [url]]]
        : [["google-chrome", ["--new-window", url]], ["xdg-open", [url]]];
  const tryNext = (i: number): void => {
    if (i >= attempts.length) return; // no browser found — the printed URL still works
    const child = spawn(attempts[i][0], attempts[i][1], { stdio: "ignore", detached: true });
    child.on("error", () => tryNext(i + 1));
    child.on("exit", (code) => {
      if (code !== 0) tryNext(i + 1);
    });
    child.unref();
  };
  tryNext(0);
}

/**
 * Owns the run lifecycle so the dashboard can drive it.
 *
 * The server outlives individual runs — that is the whole trick. Browsers stay connected,
 * the WebSocket never drops, and stop/restart just swaps the swarm underneath a live UI.
 */
export class RunController {
  private server = new ShoalServer();
  private abort?: AbortController;
  private current?: Promise<unknown>;
  private phase: RunPhase = "idle";
  private runNumber = 0;

  constructor(private opts: RunOptions) {}

  /** The dashboard/task-API server this controller owns — `shoal serve` wires a TaskQueue to it. */
  get shoalServer(): ShoalServer {
    return this.server;
  }

  /** `runImmediately: false` (used by `shoal serve`) starts the server and stays in `idle`. */
  async start(runImmediately = true): Promise<void> {
    await this.server.start(this.opts.port, this.opts.host);
    this.server.dataStore = new DataStore(this.opts.dataDir);
    this.server.dataStore.startWatching(DATA_WATCH_INTERVAL_MS, () => this.onDataChange());
    this.server.onDataReload = (changed) => {
      if (changed) this.onDataChange();
    };
    this.server.onControl = (cmd) => this.handle(cmd);
    this.broadcastState();
    this.broadcastDataStatus();
    if (this.opts.open !== false) openDashboard(`http://localhost:${this.opts.port}`);
    if (runImmediately) await this.run();
  }

  /** SIGINT/SIGTERM path: abort any swarm in flight, free the browser pool, close the server. */
  async shutdown(): Promise<void> {
    this.abort?.abort();
    await this.current?.catch(() => {});
    this.server.dataStore?.stopWatching();
    await closeSharedBrowser();
    await this.server.stop();
  }

  /** A data-dir reload (watcher tick, POST /api/reload, or WS `reload` command) that actually
   *  changed something: refresh the dashboard's strategy list and error status. Never touches
   *  a run already in flight — only the next run sees the new data. */
  private onDataChange(): void {
    this.broadcastState();
    this.broadcastDataStatus();
  }

  private broadcastDataStatus(): void {
    const store = this.server.dataStore;
    if (!store) return;
    const { strategiesError, personasError, missionsError } = store.health();
    this.server.broadcast({
      type: "data_status",
      strategiesError,
      personasError,
      missionsError,
      missions: store.getMissions().map((m) => ({ name: m.name, title: m.title })),
      loadedAt: Date.now(),
    });
  }

  private broadcastState(): void {
    // /api/health reports "idle" once a run finishes — a monitor checking readiness should
    // see the service is free to accept the next restart, even though the dashboard's own
    // run_state below still says "finished" so the UI keeps showing the report view.
    const healthPhase = this.phase === "finished" ? "idle" : this.phase;
    this.server.setHealth(healthPhase, this.runNumber === 0 ? null : this.runNumber);
    this.server.broadcast({
      type: "run_state",
      phase: this.phase,
      swarm: this.opts.swarm,
      strategy: this.opts.strategyIds?.[0],
      task: this.opts.task,
      runNumber: this.runNumber,
      strategies: this.server.dataStore?.getStrategies().map((s) => ({ id: s.id, name: s.name })),
    });
  }

  private async run(): Promise<void> {
    this.abort = new AbortController();
    this.runNumber++;
    this.phase = "running";
    this.broadcastState();

    // Each run gets a clean dashboard; otherwise the previous swarm's tiles linger.
    this.server.resetRunState();

    this.current = runSwarm(this.opts, {
      server: this.server,
      signal: this.abort.signal,
      keepAlive: true,
    })
      .catch((err: Error) => console.error(`  ✗ run failed: ${err.message}`))
      .finally(() => {
        this.phase = "finished";
        this.broadcastState();
      });

    await this.current;
  }

  private async handle(cmd: ControlCommand): Promise<void> {
    if (cmd.cmd === "reload") {
      const changed = this.server.dataStore?.reload() ?? false;
      if (changed) this.onDataChange();
      return;
    }

    if (cmd.cmd === "stop") {
      if (this.phase !== "running") return;
      console.log("  ⏹  stop requested from dashboard");
      this.phase = "stopping";
      this.broadcastState();
      this.abort?.abort();
      return;
    }

    if (cmd.cmd === "restart") {
      console.log("  ↻  restart requested from dashboard");
      // Apply any config the operator changed in the UI before relaunching.
      if (cmd.swarm && Number.isFinite(cmd.swarm)) {
        this.opts.swarm = Math.max(1, Math.min(Math.round(cmd.swarm), 5000));
        // Concurrency must grow with the swarm (or a big restart trickles through at the
        // old width) — but every concurrent agent is a live browser context costing tens
        // of MB, so this is capped by RAM, not ambition. Raising it beyond the default is
        // an explicit --concurrency decision, not something the dashboard does silently.
        // An operator who passed --concurrency keeps it: recomputing here used to silently
        // drop a pinned 150 back to machine capacity on the first restart.
        this.opts.concurrency = Math.min(
          this.opts.swarm,
          this.opts.concurrencyPinned ? this.opts.concurrency : safeConcurrency(),
        );
      }
      if (cmd.task?.trim()) this.opts.task = cmd.task.trim();
      if (cmd.strategy) {
        this.opts.strategyIds = cmd.strategy === "default" ? undefined : [cmd.strategy];
        this.opts.race = cmd.strategy === "race" ? (this.opts.race ?? {}) : undefined;
      }

      if (this.phase === "running") {
        this.phase = "stopping";
        this.broadcastState();
        this.abort?.abort();
        await this.current?.catch(() => {}); // let the in-flight swarm unwind first
      }
      await this.run();
    }
  }
}
