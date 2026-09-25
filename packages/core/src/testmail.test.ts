import { test, expect } from "bun:test";
import {
  testmailConfigFromEnv,
  buildTag,
  addressFor,
  extractCode,
  extractLink,
  buildInboxResult,
} from "./testmail.js";

test("testmailConfigFromEnv is null unless both env vars are set", () => {
  expect(testmailConfigFromEnv({})).toBeNull();
  expect(testmailConfigFromEnv({ SHOAL_TESTMAIL_NAMESPACE: "acme" })).toBeNull();
  expect(testmailConfigFromEnv({ SHOAL_TESTMAIL_API_KEY: "key123" })).toBeNull();
  expect(testmailConfigFromEnv({ SHOAL_TESTMAIL_NAMESPACE: "  ", SHOAL_TESTMAIL_API_KEY: "key123" })).toBeNull();
});

test("testmailConfigFromEnv reads and trims both vars when present", () => {
  expect(
    testmailConfigFromEnv({ SHOAL_TESTMAIL_NAMESPACE: " acme ", SHOAL_TESTMAIL_API_KEY: " key123 " }),
  ).toEqual({ namespace: "acme", apiKey: "key123" });
});

test("buildTag combines run id and persona index, readable and unique per agent", () => {
  expect(buildTag("m5x2k1a0", 0)).toBe("m5x2k1a0.0");
  expect(buildTag("m5x2k1a0", 7)).toBe("m5x2k1a0.7");
  expect(buildTag("m5x2k1a0", 0)).not.toBe(buildTag("m5x2k1a0", 1));
});

test("addressFor builds the <namespace>.<tag>@inbox.testmail.app address", () => {
  expect(addressFor({ namespace: "acme", apiKey: "x" }, "run1.3")).toBe("acme.run1.3@inbox.testmail.app");
});

test("extractCode finds the first 4-8 digit run in a real-shaped verification email", () => {
  expect(extractCode("Your verification code is 482913. It expires in 10 minutes.")).toBe("482913");
  expect(extractCode("Use 12 as your PIN")).toBeUndefined(); // too short to be a code
  expect(extractCode("Order #4471 confirmed. Your code: 7729")).toBe("4471"); // first match wins
  expect(extractCode("No numbers here at all")).toBeUndefined();
});

test("extractLink finds the first https link and trims trailing punctuation", () => {
  expect(extractLink("Click https://app.example.com/verify?t=abc123 to confirm.")).toBe(
    "https://app.example.com/verify?t=abc123",
  );
  expect(extractLink("See (https://example.com/verify) for details")).toBe("https://example.com/verify");
  expect(extractLink("Visit https://example.com/a, then https://example.com/b")).toBe("https://example.com/a");
  expect(extractLink("No links in this text.")).toBeUndefined();
  expect(extractLink("An http://insecure.example.com link is ignored")).toBeUndefined();
});

test("buildInboxResult assembles subject, code, link, and a trimmed excerpt from a real sample body", () => {
  const email = {
    subject: "Verify your Bait Shop account",
    text:
      "Hi there,\n\nWelcome to Bait Shop! Your verification code is 619284.\n\n" +
      "You can also confirm instantly: https://baitshop.example.com/verify?token=xyz789.\n\nThanks!",
    timestamp: 1000,
  };
  const result = buildInboxResult(email, 1000, 4500);
  expect(result.found).toBe(true);
  expect(result.subject).toBe("Verify your Bait Shop account");
  expect(result.code).toBe("619284");
  expect(result.link).toBe("https://baitshop.example.com/verify?token=xyz789");
  expect(result.deliveryMs).toBe(3500);
  expect(result.bodyExcerpt.startsWith("Hi there,")).toBe(true);
});

test("buildInboxResult handles a body with neither a code nor a link", () => {
  const email = { subject: "Welcome", text: "Thanks for signing up!", timestamp: 0 };
  const result = buildInboxResult(email, 0, 0);
  expect(result.code).toBeUndefined();
  expect(result.link).toBeUndefined();
});
