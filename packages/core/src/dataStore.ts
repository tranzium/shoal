import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { assignFromList, getFromList, PACKAGED_STRATEGIES_PATH } from "./strategies.js";
import { pickFromList, PACKAGED_PERSONAS_PATH } from "./personas.js";
import { validateQaConfig } from "./qa.js";
import type { Mission, Persona, Strategy } from "./types.js";

/**
 * Live, reloadable strategies/personas/missions for `shoal serve --data <dir>`. Strategies
 * and personas each fall back to the packaged library when the data dir has no override;
 * missions only ever come from `<dataDir>/missions/*.yaml` (there is no packaged default).
 * A reload that fails validation keeps whatever was last good and records the error instead
 * of throwing — a broken edit must never crash the service or blank out a running dashboard.
 */

export interface DataSection<T> {
  items: T[];
  /** Path (or directory) actually in effect — the packaged default, or the data-dir override. */
  source: string;
  loadedAt: number;
  /** Set when the most recent reload attempt failed; `items`/`source` still hold the last good load. */
  error: string | null;
}

function validateStrategy(raw: unknown, i: number): Strategy {
  const s = raw as Record<string, unknown>;
  if (!s || typeof s.id !== "string" || typeof s.name !== "string" || typeof s.directive !== "string") {
    throw new Error(`entry ${i}: strategies need id, name, and directive strings`);
  }
  const strategy: Strategy = { id: s.id, name: s.name, directive: s.directive };
  if (typeof s.goal === "string") strategy.goal = s.goal;
  return strategy;
}

function parseStrategiesYaml(raw: string): Strategy[] {
  const doc = parse(raw) as { strategies?: unknown } | null;
  if (!doc || !Array.isArray(doc.strategies)) throw new Error("missing top-level `strategies` list");
  return doc.strategies.map(validateStrategy);
}

function validatePersona(raw: unknown, i: number): Persona {
  const p = raw as Record<string, unknown>;
  if (
    !p ||
    typeof p.id !== "string" ||
    typeof p.emoji !== "string" ||
    typeof p.name !== "string" ||
    typeof p.patience_steps !== "number" ||
    typeof p.profile !== "string"
  ) {
    throw new Error(`entry ${i}: personas need id, emoji, name, patience_steps (number), and profile`);
  }
  const persona: Persona = { id: p.id, emoji: p.emoji, name: p.name, patience_steps: p.patience_steps, profile: p.profile };
  if (typeof p.weight === "number") persona.weight = p.weight;
  if (typeof p.source === "string") persona.source = p.source;
  if (p.modality === "vision" || p.modality === "a11y") persona.modality = p.modality;
  return persona;
}

function parsePersonasYaml(raw: string): Persona[] {
  const doc = parse(raw) as { personas?: unknown } | null;
  if (!doc || !Array.isArray(doc.personas)) throw new Error("missing top-level `personas` list");
  return doc.personas.map(validatePersona);
}

function validateMission(raw: unknown, name: string): Mission {
  const m = raw as Record<string, unknown>;
  if (!m || typeof m.title !== "string" || typeof m.url !== "string" || typeof m.task !== "string") {
    throw new Error(`mission "${name}" needs title, url, and task strings`);
  }
  if (m.name !== undefined && m.name !== name) {
    throw new Error(`mission "${name}": its name field ("${String(m.name)}") does not match the filename`);
  }
  const mission: Mission = { name, title: m.title, url: m.url, task: m.task };
  if (typeof m.strategy === "string") mission.strategy = m.strategy;
  if (typeof m.swarm === "number") mission.swarm = m.swarm;
  if (Array.isArray(m.personas) && m.personas.every((p) => typeof p === "string")) mission.personas = m.personas as string[];
  if (m.qa !== undefined) {
    const qa = validateQaConfig(m.qa, name);
    if (!qa.hosts.some((h) => h.toLowerCase() === new URL(m.url as string).hostname.toLowerCase())) {
      throw new Error(`mission "${name}": qa.hosts must list the start URL's host`);
    }
    mission.qa = qa;
  }
  return mission;
}

function readSection<T>(path: string, parseFn: (raw: string) => T[]): { items: T[] } | { error: string } {
  try {
    return { items: parseFn(readFileSync(path, "utf8")) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export class DataStore {
  private strategies: DataSection<Strategy>;
  private personas: DataSection<Persona>;
  private missions: DataSection<Mission>;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private dataDir?: string) {
    // Seed with the packaged libraries (always valid) so a broken custom file on first boot
    // still leaves the service with a working "last good" copy instead of an empty list.
    const seedStrategies = readSection(PACKAGED_STRATEGIES_PATH, parseStrategiesYaml) as { items: Strategy[] };
    const seedPersonas = readSection(PACKAGED_PERSONAS_PATH, parsePersonasYaml) as { items: Persona[] };
    this.strategies = { items: seedStrategies.items, source: PACKAGED_STRATEGIES_PATH, loadedAt: 0, error: null };
    this.personas = { items: seedPersonas.items, source: PACKAGED_PERSONAS_PATH, loadedAt: 0, error: null };
    this.missions = { items: [], source: dataDir ? join(dataDir, "missions") : "(no data dir)", loadedAt: 0, error: null };
    this.reload();
  }

  getStrategies(): Strategy[] {
    return this.strategies.items;
  }
  getStrategiesSection(): DataSection<Strategy> {
    return this.strategies;
  }
  getPersonas(): Persona[] {
    return this.personas.items;
  }
  getPersonasSection(): DataSection<Persona> {
    return this.personas;
  }
  getMissions(): Mission[] {
    return this.missions.items;
  }
  getMissionsSection(): DataSection<Mission> {
    return this.missions;
  }
  getMission(name: string): Mission | undefined {
    return this.missions.items.find((m) => m.name === name);
  }

  assignStrategies(n: number, ids?: string[]): Strategy[] {
    return assignFromList(this.getStrategies(), n, ids);
  }
  getStrategy(id: string): Strategy {
    return getFromList(this.getStrategies(), id);
  }
  pickPersonas(n: number, ids?: string[]): Persona[] {
    return pickFromList(this.getPersonas(), n, ids);
  }

  health(): { strategiesError: string | null; personasError: string | null; missionsError: string | null } {
    return {
      strategiesError: this.strategies.error,
      personasError: this.personas.error,
      missionsError: this.missions.error,
    };
  }

  /** Re-read everything from disk. Returns true if anything actually changed (items or
   *  error state), so callers only re-broadcast to dashboards when there's something new. */
  reload(): boolean {
    const before = this.signature();
    this.strategies = this.reloadFile(this.strategies, "strategies.yaml", PACKAGED_STRATEGIES_PATH, parseStrategiesYaml);
    this.personas = this.reloadFile(this.personas, "personas.yaml", PACKAGED_PERSONAS_PATH, parsePersonasYaml);
    this.missions = this.reloadMissions();
    return before !== this.signature();
  }

  private reloadFile<T>(
    current: DataSection<T>,
    filename: string,
    packagedPath: string,
    parseFn: (raw: string) => T[],
  ): DataSection<T> {
    const custom = this.dataDir ? join(this.dataDir, filename) : null;
    const activePath = custom && existsSync(custom) ? custom : packagedPath;
    const result = readSection(activePath, parseFn);
    if ("items" in result) {
      return { items: result.items, source: activePath, loadedAt: Date.now(), error: null };
    }
    return { ...current, error: `${activePath}: ${result.error}` };
  }

  private reloadMissions(): DataSection<Mission> {
    const current = this.missions;
    if (!this.dataDir) {
      return { items: [], source: "(no data dir)", loadedAt: current.loadedAt, error: null };
    }
    const dir = join(this.dataDir, "missions");
    if (!existsSync(dir)) {
      return { items: [], source: dir, loadedAt: Date.now(), error: null };
    }
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    } catch (err) {
      return { ...current, error: `${dir}: ${(err as Error).message}` };
    }
    const lastGood = new Map(current.items.map((m) => [m.name, m]));
    const items: Mission[] = [];
    const errors: string[] = [];
    for (const f of files) {
      const name = f.replace(/\.ya?ml$/, "");
      try {
        items.push(validateMission(parse(readFileSync(join(dir, f), "utf8")), name));
      } catch (err) {
        errors.push(`${f}: ${(err as Error).message}`);
        const prev = lastGood.get(name);
        if (prev) items.push(prev); // a broken edit to an existing mission keeps its last good copy
      }
    }
    return { items, source: dir, loadedAt: Date.now(), error: errors.length > 0 ? errors.join("; ") : null };
  }

  /** loadedAt deliberately excluded — a reload that re-reads identical content must not
   *  count as "changed" just because Date.now() ticked forward. */
  private signature(): string {
    const strip = <T>(s: DataSection<T>) => ({ items: s.items, source: s.source, error: s.error });
    return JSON.stringify([strip(this.strategies), strip(this.personas), strip(this.missions)]);
  }

  /** Poll the data dir every `intervalMs` and invoke `onChange` after any reload that
   *  actually changed something. Timer is unref'd — it never keeps the process alive on
   *  its own (the HTTP/WS server already does that). */
  startWatching(intervalMs: number, onChange: () => void): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.reload()) onChange();
    }, intervalMs);
    this.timer.unref?.();
  }

  stopWatching(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
