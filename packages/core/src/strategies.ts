import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import type { Strategy } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The packaged strategy library shipped with shoal — the fallback when no data dir
 *  (or a data dir with no strategies.yaml) is configured. */
export const PACKAGED_STRATEGIES_PATH = join(here, "..", "strategies", "strategies.yaml");

export function loadStrategies(path: string = PACKAGED_STRATEGIES_PATH): Strategy[] {
  const raw = readFileSync(path, "utf8");
  return (parse(raw) as { strategies: Strategy[] }).strategies;
}

export function getFromList(strategies: Strategy[], id: string): Strategy {
  const found = strategies.find((s) => s.id === id);
  if (!found) {
    throw new Error(`Unknown strategy "${id}". Available: ${strategies.map((s) => s.id).join(", ")}`);
  }
  return found;
}

export function getStrategy(id: string): Strategy {
  return getFromList(loadStrategies(), id);
}

/** Assign strategies across the swarm, cycling so every slot gets one. */
export function assignFromList(strategies: Strategy[], n: number, ids?: string[]): Strategy[] {
  const pool = ids && ids.length > 0 ? ids.map((id) => getFromList(strategies, id)) : [getFromList(strategies, "complete-task")];
  return Array.from({ length: n }, (_, i) => pool[i % pool.length]);
}

export function assignStrategies(n: number, ids?: string[]): Strategy[] {
  return assignFromList(loadStrategies(), n, ids);
}
