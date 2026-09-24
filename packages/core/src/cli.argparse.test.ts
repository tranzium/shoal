import { test, expect, beforeEach, afterEach } from "bun:test";
import { arg, args, serveOpts } from "./cli.js";

const originalArgv = process.argv;

beforeEach(() => {
  process.argv = [...originalArgv];
});

afterEach(() => {
  process.argv = originalArgv;
});

test("arg reads a flag's value, or falls back", () => {
  process.argv = ["node", "cli.js", "serve", "--port", "4340"];
  expect(arg("port")).toBe("4340");
  expect(arg("missing", "default")).toBe("default");
  expect(arg("missing")).toBeUndefined();
});

test("args collects a repeatable flag", () => {
  process.argv = ["node", "cli.js", "run", "url", "--allow-domain", "a.com", "--allow-domain", "b.com"];
  expect(args("allow-domain")).toEqual(["a.com", "b.com"]);
  expect(args("none-such")).toEqual([]);
});

test("serveOpts defaults to port 4321, open dashboard, headless", () => {
  process.argv = ["node", "cli.js", "serve"];
  const opts = serveOpts();
  expect(opts.port).toBe(4321);
  expect(opts.open).toBe(true);
  expect(opts.headless).toBe(true);
  expect(opts.mock).toBe(false);
  expect(opts.url).toBe("");
});

test("serveOpts honors --port and --headed", () => {
  process.argv = ["node", "cli.js", "serve", "--port", "4340", "--headed"];
  const opts = serveOpts();
  expect(opts.port).toBe(4340);
  expect(opts.headless).toBe(false);
});
