import { test, expect, beforeEach, afterEach } from "bun:test";
import { arg, args, serveOpts } from "./cliMain.js";

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

test("serveOpts honors --host; defaults to undefined (all interfaces)", () => {
  process.argv = ["node", "cli.js", "serve"];
  expect(serveOpts().host).toBeUndefined();

  process.argv = ["node", "cli.js", "serve", "--host", "127.172.0.4", "--port", "80"];
  const opts = serveOpts();
  expect(opts.host).toBe("127.172.0.4");
  expect(opts.port).toBe(80);
});

test("serveOpts honors --url, --allow-domain, --base-url and --personas", () => {
  process.argv = [
    "node", "cli.js", "serve",
    "--url", "https://shoal.test/",
    "--allow-domain", "shoal.test",
    "--base-url", "http://localhost:11434/v1",
    "--personas", "speedrun-sam, newbie-nora",
  ];
  const opts = serveOpts();
  expect(opts.url).toBe("https://shoal.test/");
  expect(opts.allowDomains).toEqual(["shoal.test"]);
  expect(opts.baseUrl).toBe("http://localhost:11434/v1");
  expect(opts.personaIds).toEqual(["speedrun-sam", "newbie-nora"]);
});

test("serveOpts defaults model/concurrency to Opus/12, and to Haiku/3 with --provider subscription", () => {
  process.argv = ["node", "cli.js", "serve"];
  expect(serveOpts().model).toBe("claude-opus-5");
  expect(serveOpts().concurrency).toBe(8); // min(swarm=8, 12)

  process.argv = ["node", "cli.js", "serve", "--provider", "subscription", "--swarm", "20"];
  const sub = serveOpts();
  expect(sub.model).toBe("claude-haiku-4-5");
  expect(sub.concurrency).toBe(3); // min(swarm=20, 3)
});

test("serveOpts sets concurrencyPinned only when --concurrency is explicit", () => {
  process.argv = ["node", "cli.js", "serve"];
  expect(serveOpts().concurrencyPinned).toBe(false);

  process.argv = ["node", "cli.js", "serve", "--concurrency", "5"];
  expect(serveOpts().concurrencyPinned).toBe(true);
});
