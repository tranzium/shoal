/**
 * testmail.app inbox: gives each persona in a run its own disposable email address so it can
 * sign up on the target site and read back its own verification code/link — no human mailbox,
 * no self-hosted inbox. Off entirely when SHOAL_TESTMAIL_NAMESPACE/SHOAL_TESTMAIL_API_KEY are
 * unset (see testmailConfigFromEnv).
 */

export interface TestmailConfig {
  namespace: string;
  apiKey: string;
}

/** Feature is off unless both env vars are set — callers treat a null return as "disabled". */
export function testmailConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TestmailConfig | null {
  const namespace = env.SHOAL_TESTMAIL_NAMESPACE?.trim();
  const apiKey = env.SHOAL_TESTMAIL_API_KEY?.trim();
  if (!namespace || !apiKey) return null;
  return { namespace, apiKey };
}

/**
 * Tag = run id + persona index: unique per agent within a run, and readable. Dots are
 * testmail.app's own hierarchy separator, so this also reads as `<run>.<agent>` in their UI.
 */
export function buildTag(runId: string, personaIndex: number): string {
  return `${runId}.${personaIndex}`;
}

export function addressFor(config: TestmailConfig, tag: string): string {
  return `${config.namespace}.${tag}@inbox.testmail.app`;
}

const CODE_RE = /\b\d{4,8}\b/;
const LINK_RE = /https:\/\/[^\s"'<>]+/;

/** First 4-8 digit run of digits in the body — covers the common OTP/verification-code shape. */
export function extractCode(text: string): string | undefined {
  return text.match(CODE_RE)?.[0];
}

/** First https link in the body, with trailing sentence punctuation trimmed off. */
export function extractLink(text: string): string | undefined {
  const match = text.match(LINK_RE)?.[0];
  return match?.replace(/[.,;:!?)\]}'"]+$/, "");
}

export interface InboxEmail {
  subject: string;
  text: string;
  timestamp: number;
}

export interface InboxHit {
  found: true;
  subject: string;
  code?: string;
  link?: string;
  bodyExcerpt: string;
  /** How long after the run started this mail showed up — a product signal in its own right. */
  deliveryMs: number;
}

export interface InboxMiss {
  found: false;
}

export type InboxResult = InboxHit | InboxMiss;

/** Pure: turns a raw testmail.app email into the extracted result agents/reports consume. */
export function buildInboxResult(email: InboxEmail, sinceTs: number, now: number = Date.now()): InboxHit {
  const body = email.text || "";
  return {
    found: true,
    subject: email.subject,
    code: extractCode(body),
    link: extractLink(body),
    bodyExcerpt: body.trim().slice(0, 500),
    deliveryMs: Math.max(0, now - sinceTs),
  };
}

/**
 * The one function that talks to testmail.app — isolated so tag/extraction logic can be
 * tested without a network call. `livequery=true` makes the request itself block server-side
 * until mail arrives or its own timeout; the AbortController here is this side's backstop.
 */
export async function fetchLatestEmail(
  config: TestmailConfig,
  tag: string,
  sinceTs: number,
  timeoutMs: number,
): Promise<InboxEmail | null> {
  const params = new URLSearchParams({
    apikey: config.apiKey,
    namespace: config.namespace,
    tag,
    livequery: "true",
    timestamp_from: String(sinceTs),
    limit: "1",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.testmail.app/api/json?${params}`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { result: string; emails?: InboxEmail[] };
    if (data.result !== "success" || !data.emails?.length) return null;
    return data.emails[0];
  } catch {
    return null; // timeout or network error — the agent sees "no mail arrived", not a crash
  } finally {
    clearTimeout(timer);
  }
}

/** Waits up to `waitSec` (default 60) for mail addressed to `tag` since `sinceTs`. */
export async function checkInbox(
  config: TestmailConfig,
  tag: string,
  sinceTs: number,
  waitSec = 60,
): Promise<InboxResult> {
  const email = await fetchLatestEmail(config, tag, sinceTs, waitSec * 1000);
  if (!email) return { found: false };
  return buildInboxResult(email, sinceTs);
}
