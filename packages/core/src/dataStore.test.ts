import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataStore } from "./dataStore.js";
import { loadStrategies } from "./strategies.js";
import { loadPersonas } from "./personas.js";

const dirs: string[] = [];
function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "shoal-data-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

test("with no data dir, strategies/personas fall back to the packaged libraries", () => {
  const store = new DataStore(undefined);
  expect(store.getStrategies()).toEqual(loadStrategies());
  expect(store.getPersonas()).toEqual(loadPersonas());
  expect(store.getMissions()).toEqual([]);
  expect(store.getStrategiesSection().error).toBeNull();
});

test("a data dir with no override files still falls back to packaged defaults", () => {
  const dir = tempDataDir();
  const store = new DataStore(dir);
  expect(store.getStrategies()).toEqual(loadStrategies());
  expect(store.getPersonas()).toEqual(loadPersonas());
  expect(store.getMissions()).toEqual([]);
});

test("a custom strategies.yaml in the data dir overrides the packaged library", () => {
  const dir = tempDataDir();
  writeFileSync(
    join(dir, "strategies.yaml"),
    "strategies:\n  - id: only-one\n    name: Only One\n    directive: Do the one thing.\n",
    "utf8",
  );
  const store = new DataStore(dir);
  expect(store.getStrategies()).toEqual([{ id: "only-one", name: "Only One", directive: "Do the one thing." }]);
  expect(store.getStrategiesSection().source).toBe(join(dir, "strategies.yaml"));
  expect(store.getStrategiesSection().error).toBeNull();
});

test("reload() picks up an edit to strategies.yaml and reports changed", () => {
  const dir = tempDataDir();
  const path = join(dir, "strategies.yaml");
  writeFileSync(path, "strategies:\n  - id: a\n    name: A\n    directive: d\n", "utf8");
  const store = new DataStore(dir);
  expect(store.getStrategies().map((s) => s.id)).toEqual(["a"]);

  writeFileSync(path, "strategies:\n  - id: b\n    name: B\n    directive: d\n", "utf8");
  const changed = store.reload();
  expect(changed).toBe(true);
  expect(store.getStrategies().map((s) => s.id)).toEqual(["b"]);
});

test("reload() with no actual change reports unchanged", () => {
  const dir = tempDataDir();
  writeFileSync(join(dir, "strategies.yaml"), "strategies:\n  - id: a\n    name: A\n    directive: d\n", "utf8");
  const store = new DataStore(dir);
  expect(store.reload()).toBe(false);
});

test("an invalid YAML edit keeps the last good strategies list and surfaces the error", () => {
  const dir = tempDataDir();
  const path = join(dir, "strategies.yaml");
  writeFileSync(path, "strategies:\n  - id: a\n    name: A\n    directive: d\n", "utf8");
  const store = new DataStore(dir);
  expect(store.getStrategies().map((s) => s.id)).toEqual(["a"]);

  writeFileSync(path, "strategies:\n  - id: a\n    name: A\n", "utf8"); // missing directive
  const changed = store.reload();
  expect(changed).toBe(true); // the error state itself changed
  expect(store.getStrategies().map((s) => s.id)).toEqual(["a"]); // unchanged — last good copy
  expect(store.getStrategiesSection().error).toContain("strategies.yaml");
  expect(store.health().strategiesError).not.toBeNull();
});

test("a broken custom file on first load falls back to the packaged library, not an empty list", () => {
  const dir = tempDataDir();
  writeFileSync(join(dir, "strategies.yaml"), "not: [valid, structure", "utf8"); // syntax error
  const store = new DataStore(dir);
  expect(store.getStrategies()).toEqual(loadStrategies());
  expect(store.getStrategiesSection().error).not.toBeNull();
});

test("missions load from <dataDir>/missions/*.yaml, keyed by filename", () => {
  const dir = tempDataDir();
  mkdirSync(join(dir, "missions"));
  writeFileSync(
    join(dir, "missions", "signup.yaml"),
    "title: Signup\nurl: https://x.test/\ntask: sign up\nswarm: 5\n",
    "utf8",
  );
  const store = new DataStore(dir);
  expect(store.getMissions()).toEqual([{ name: "signup", title: "Signup", url: "https://x.test/", task: "sign up", swarm: 5 }]);
  expect(store.getMission("signup")?.title).toBe("Signup");
  expect(store.getMission("nope")).toBeUndefined();
});

test("a broken mission file keeps that mission's last good copy and leaves the others alone", () => {
  const dir = tempDataDir();
  const missionsDir = join(dir, "missions");
  mkdirSync(missionsDir);
  writeFileSync(join(missionsDir, "signup.yaml"), "title: Signup\nurl: https://x.test/\ntask: sign up\n", "utf8");
  writeFileSync(join(missionsDir, "paid.yaml"), "title: Paid\nurl: https://x.test/\ntask: pay\n", "utf8");
  const store = new DataStore(dir);
  expect(store.getMissions().length).toBe(2);

  writeFileSync(join(missionsDir, "signup.yaml"), "title: Signup\n", "utf8"); // now missing url/task
  const changed = store.reload();
  expect(changed).toBe(true);
  expect(store.getMission("signup")?.task).toBe("sign up"); // last good copy retained
  expect(store.getMission("paid")?.task).toBe("pay"); // untouched
  expect(store.getMissionsSection().error).toContain("signup.yaml");
});

test("a brand-new broken mission file is skipped, not added half-formed", () => {
  const dir = tempDataDir();
  const missionsDir = join(dir, "missions");
  mkdirSync(missionsDir);
  writeFileSync(join(missionsDir, "broken.yaml"), "title: Nope\n", "utf8"); // missing url/task
  const store = new DataStore(dir);
  expect(store.getMissions()).toEqual([]);
  expect(store.getMissionsSection().error).toContain("broken.yaml");
});

test("a mission's qa block is validated and parsed", () => {
  const dir = tempDataDir();
  mkdirSync(join(dir, "missions"));
  writeFileSync(
    join(dir, "missions", "qa-pricing.yaml"),
    [
      "title: QA pricing",
      "url: https://site.test/pricing/",
      "task: click yearly",
      "swarm: 1",
      "qa:",
      "  hosts: [site.test]",
      "  expect:",
      "    - id: price",
      "      kind: text",
      "      when: start",
      "      selector: .price",
      "      equals: $39.99",
    ].join("\n"),
    "utf8",
  );
  const store = new DataStore(dir);
  const mission = store.getMission("qa-pricing");
  expect(mission?.qa?.hosts).toEqual(["site.test"]);
  expect(mission?.qa?.expect[0].id).toBe("price");
  expect(store.getMissionsSection().error).toBeNull();
});

test("a mission's qa.hosts must include the start URL's host", () => {
  const dir = tempDataDir();
  mkdirSync(join(dir, "missions"));
  writeFileSync(
    join(dir, "missions", "qa-bad.yaml"),
    [
      "title: QA bad",
      "url: https://site.test/pricing/",
      "task: click yearly",
      "qa:",
      "  hosts: [other.test]",
      "  expect:",
      "    - id: price",
      "      kind: text",
      "      when: start",
      "      equals: $39.99",
    ].join("\n"),
    "utf8",
  );
  const store = new DataStore(dir);
  expect(store.getMissions()).toEqual([]);
  expect(store.getMissionsSection().error).toContain("qa.hosts must list the start URL's host");
});

test("deleting a mission file removes it on the next reload", () => {
  const dir = tempDataDir();
  const missionsDir = join(dir, "missions");
  mkdirSync(missionsDir);
  const path = join(missionsDir, "signup.yaml");
  writeFileSync(path, "title: Signup\nurl: https://x.test/\ntask: sign up\n", "utf8");
  const store = new DataStore(dir);
  expect(store.getMissions().length).toBe(1);

  unlinkSync(path);
  expect(store.reload()).toBe(true);
  expect(store.getMissions()).toEqual([]);
});

test("startWatching triggers onChange after a poll tick sees an edit", async () => {
  const dir = tempDataDir();
  const path = join(dir, "strategies.yaml");
  writeFileSync(path, "strategies:\n  - id: a\n    name: A\n    directive: d\n", "utf8");
  const store = new DataStore(dir);
  let changes = 0;
  store.startWatching(20, () => changes++);
  try {
    writeFileSync(path, "strategies:\n  - id: b\n    name: B\n    directive: d\n", "utf8");
    const start = Date.now();
    while (changes === 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(changes).toBeGreaterThan(0);
    expect(store.getStrategies().map((s) => s.id)).toEqual(["b"]);
  } finally {
    store.stopWatching();
  }
});
