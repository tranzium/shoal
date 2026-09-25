import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { comparisonRows } from "./pricing.js";
import { redactFinding, redactText } from "./redact.js";
import type { Finding, FrictionCluster, QaReport, RunOptions, RunSummary } from "./types.js";

/** Group near-duplicate findings (same trap hit by several agents) by normalized title words. */
export function clusterFindings(
  findings: Finding[],
): { title: string; severity: Finding["severity"]; hitBy: string[]; reach: number; examples: Finding[] }[] {
  const clusters: { key: Set<string>; items: Finding[] }[] = [];
  const tokens = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter((w) => w.length > 3));
  const overlap = (a: Set<string>, b: Set<string>) => {
    let n = 0;
    for (const t of a) if (b.has(t)) n++;
    return n / Math.max(1, Math.min(a.size, b.size));
  };

  for (const f of findings) {
    const key = tokens(f.title + " " + f.description);
    const hit = clusters.find((c) => overlap(c.key, key) >= 0.34);
    if (hit) {
      hit.items.push(f);
      for (const t of key) hit.key.add(t);
    } else {
      clusters.push({ key, items: [f] });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 } as const;
  return clusters
    .map((c) => {
      const top = [...c.items].sort((a, b) => rank[a.severity] - rank[b.severity])[0];
      return {
        title: top.title,
        severity: top.severity,
        hitBy: [...new Set(c.items.map((i) => i.personaName))],
        // Reach is agent-SESSIONS (each finding is one), not distinct persona names — with a
        // cycled persona pool the same name recurs across hundreds of agents, and "312 users
        // hit this" is the number that matters, not "3 personas did".
        reach: new Set(c.items.map((i) => i.agentId)).size,
        examples: c.items,
      };
    })
    .sort((a, b) => b.reach - a.reach || rank[a.severity] - rank[b.severity]);
}

/** The friction map for the live dashboard — clusters stripped to what a viewer needs. */
export function frictionMap(findings: Finding[]): FrictionCluster[] {
  return clusterFindings(findings).map((c) => ({
    title: c.title,
    severity: c.severity,
    reach: c.reach,
    personas: c.hitBy.length,
    suspect: c.examples.every((e) => e.verdict?.status === "suspect"),
  }));
}

function costLines(summary: RunSummary, opts: RunOptions): string[] {
  if (opts.mock) return [`- **Cost:** $0.00 (mock mode)`];
  const totalTokens = summary.usage.input + summary.usage.cacheRead + summary.usage.cacheWrite + summary.usage.output;
  if (totalTokens === 0) return [];
  const lines = [
    summary.costUsd !== null
      ? `- **Cost:** $${summary.costUsd.toFixed(2)} total · $${(summary.costUsd / summary.total).toFixed(3)} per agent-session (${(totalTokens / 1000).toFixed(0)}k tokens on ${opts.model})`
      : `- **Tokens:** ${(totalTokens / 1000).toFixed(0)}k on ${opts.model} (price unknown — pass --price-in/--price-out)`,
    ``,
    `### What this token volume costs per tier`,
    ``,
    `*Rough estimate: same token counts priced at each tier's rates (tokenizers differ across models).*`,
    ``,
    `| Tier | Cost |`,
    `|---|---|`,
    ...comparisonRows(summary.usage).map((r) => `| ${r.label} | $${r.usd.toFixed(2)} |`),
  ];
  return lines;
}

/** Header fields for a per-task report (`reports/<id>.md`); omitted for the shared `run`-mode report. */
interface ReportMeta {
  id: string;
  title: string;
  startedAt: number;
  finishedAt: number;
  /** Set when the task didn't finish normally — a report exists even for a failed/cancelled
   *  task, so "submit a task, get a report" holds unconditionally instead of leaving nothing
   *  on disk for the one case an operator most needs to inspect. */
  status?: "failed" | "cancelled";
  error?: string;
}

function buildReportMd(findings: Finding[], summary: RunSummary, opts: RunOptions, meta?: ReportMeta): string {
  const clusters = clusterFindings(findings);
  const sevIcon = { high: "🔴", medium: "🟡", low: "🔵" } as const;

  const header = meta
    ? [
        `# 🐟 Shoal task report — ${meta.title}`,
        ``,
        `- **Id:** ${meta.id}`,
        `- **Target:** ${opts.url}`,
        `- **Task:** ${opts.task}`,
        `- **Strategy:** ${opts.strategyIds?.join(", ") || "default"}`,
        `- **Swarm:** ${summary.total} agents (${opts.mock ? "mock mode" : opts.model})`,
        `- **Started:** ${new Date(meta.startedAt).toISOString()}`,
        `- **Finished:** ${new Date(meta.finishedAt).toISOString()}`,
        `- **Outcome:** ${summary.completed} completed · ${summary.gaveUp} gave up · ${summary.errored} errored`,
        ...(meta.status ? [`- **Status:** ${meta.status}${meta.error ? ` — ${meta.error}` : ""}`] : []),
      ]
    : [
        `# 🐟 Shoal swarm report`,
        ``,
        `- **Target:** ${opts.url}`,
        `- **Task:** ${opts.task}`,
        `- **Swarm:** ${summary.total} agents (${opts.mock ? "mock mode" : opts.model})`,
        `- **Outcome:** ${summary.completed} completed · ${summary.gaveUp} gave up · ${summary.errored} errored`,
      ];

  const sourceLabel = { console: "console", pageerror: "page error", network: "failed request", extension: "extension" } as const;
  const verdictLine = {
    reproduced: "✅ **reproduced**",
    not_reproduced: "❌ **not_reproduced**",
    inconclusive: "❔ **inconclusive**",
  } as const;

  const reproSections = [
    ...(summary.verdict
      ? [
          `## Verdict`,
          ``,
          `Expected: \`${opts.expect}\` → ${verdictLine[summary.verdict.status]}`,
          ``,
          ...(summary.verdict.evidence.length > 0 ? summary.verdict.evidence.map((e) => `- ${e}`) : []),
          ``,
        ]
      : []),
    ...(summary.capturedErrors && summary.capturedErrors.length > 0
      ? [
          `## Captured browser errors (${summary.capturedErrors.length})`,
          ``,
          ...summary.capturedErrors.map(
            (e) => `- **[${sourceLabel[e.source]}]** ${e.text} (×${e.count}, first seen step ${e.firstStep})`,
          ),
          ``,
        ]
      : []),
    ...(summary.inboxDeliveries && summary.inboxDeliveries.length > 0
      ? [
          `## Inbox delivery (testmail.app)`,
          ``,
          ...summary.inboxDeliveries.map(
            (d) =>
              `- ${d.delivered ? "✅" : "❌"} **${d.personaName}** (${d.address})${
                d.delivered ? ` — mail arrived in ${((d.deliveryMs ?? 0) / 1000).toFixed(1)}s` : " — no mail arrived within the wait window"
              }`,
          ),
          ``,
        ]
      : []),
  ];

  return [
    ...header,
    ...costLines(summary, opts),
    ``,
    ...reproSections,
    `## Findings (${clusters.length} issues, ${findings.length} reports${
      findings.some((f) => f.verdict)
        ? `; verify pass: ${findings.filter((f) => f.verdict?.status !== "suspect").length} confirmed, ${findings.filter((f) => f.verdict?.status === "suspect").length} suspect`
        : ""
    })`,
    ``,
    ...clusters.flatMap((c) => {
      const allSuspect = c.examples.every((e) => e.verdict?.status === "suspect");
      return [
        `### ${sevIcon[c.severity]} ${c.title}${allSuspect ? " ⚠️ *(suspect — possible agent artifact, review manually)*" : ""}`,
        ``,
        `Hit by **${c.reach}/${summary.total}** agents across ${c.hitBy.length} persona${c.hitBy.length === 1 ? "" : "s"}: ${c.hitBy.join(", ")}`,
        ``,
        ...c.examples.slice(0, 3).map(
          (e) =>
            `> *${e.personaName}:* ${e.description}${
              e.verdict?.status === "suspect" ? `\n> ⚠️ *verifier: ${e.verdict.note}*` : ""
            }`,
        ),
        ``,
      ];
    }),
  ].join("\n");
}

export async function writeReport(findings: Finding[], summary: RunSummary, opts: RunOptions): Promise<string> {
  const md = buildReportMd(findings, summary, opts);
  const mdPath = join(process.cwd(), "shoal-report.md");
  const jsonPath = join(process.cwd(), "shoal-report.json");
  await writeFile(mdPath, md, "utf8");
  await writeFile(jsonPath, JSON.stringify({ summary, clusters: clusterFindings(findings), findings }, null, 2), "utf8");
  return mdPath;
}

/**
 * Per-task report for the queue (`reports/<id>.md` + `.json`) — unlike `writeReport`, each
 * task gets its own file instead of overwriting a shared `shoal-report.*`. `secrets`, when
 * given, redacts login credentials from the task text and every finding before writing —
 * a backstop on top of the redaction already applied as findings are collected.
 */
export async function writeTaskReport(
  findings: Finding[],
  summary: RunSummary,
  opts: RunOptions,
  meta: { id: string; title: string; startedAt: number; finishedAt?: number; status?: "failed" | "cancelled"; error?: string },
  secrets: string[] = [],
): Promise<{ mdPath: string; jsonPath: string }> {
  const finishedAt = meta.finishedAt ?? Date.now();
  const safeFindings = secrets.length ? findings.map((f) => redactFinding(f, secrets)) : findings;
  const safeOpts: RunOptions = secrets.length ? { ...opts, task: redactText(opts.task, secrets) } : opts;
  const safeTitle = secrets.length ? redactText(meta.title, secrets) : meta.title;
  const safeError = meta.error && secrets.length ? redactText(meta.error, secrets) : meta.error;

  const md = buildReportMd(safeFindings, summary, safeOpts, {
    id: meta.id,
    title: safeTitle,
    startedAt: meta.startedAt,
    finishedAt,
    status: meta.status,
    error: safeError,
  });
  const dir = join(process.cwd(), "reports");
  await mkdir(dir, { recursive: true });
  const mdPath = join(dir, `${meta.id}.md`);
  const jsonPath = join(dir, `${meta.id}.json`);
  await writeFile(mdPath, md, "utf8");
  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        id: meta.id,
        title: safeTitle,
        startedAt: meta.startedAt,
        finishedAt,
        status: meta.status,
        error: safeError,
        summary,
        clusters: clusterFindings(safeFindings),
        findings: safeFindings,
      },
      null,
      2,
    ),
    "utf8",
  );
  return { mdPath, jsonPath };
}

function qaTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function buildQaReportMd(report: QaReport, findings: Finding[]): string {
  const verdictLine = { pass: "✅ **pass**", fail: "❌ **fail**", inconclusive: "❔ **inconclusive**" } as const;
  const statusIcon = { pass: "✅", fail: "❌", not_reached: "❔" } as const;
  return [
    `# 🐟 Shoal QA report — ${report.mission}`,
    ``,
    `- **Target:** ${report.url}`,
    `- **Model:** ${report.model ?? "(none — zero model calls)"}`,
    `- **Repeats:** ${report.repeats}`,
    `- **Started:** ${new Date(report.startedAt).toISOString()}`,
    `- **Finished:** ${new Date(report.finishedAt).toISOString()}`,
    `- **Verdict:** ${verdictLine[report.verdict]}`,
    ``,
    `## Expectations (${report.expectations.length})`,
    ``,
    ...report.expectations.map((e) => {
      const evidence = e.evidence?.url
        ? ` — evidence: ${e.evidence.url}${e.evidence.screenshot ? ` (${e.evidence.screenshot})` : ""}`
        : "";
      return `- ${statusIcon[e.status]} **${e.id}** (${e.kind}${e.gradedBy === "judge" ? ", judge" : ""}) — expected ${e.expected}${
        e.actual !== undefined ? `, actual "${e.actual}"` : ""
      }${evidence}`;
    }),
    ``,
    `## Guards`,
    ``,
    ...report.guards.map((g) => `- ${g.status === "pass" ? "✅" : "❌"} **${g.kind}**${g.items.length ? `: ${g.items.join("; ")}` : ""}`),
    ...(report.blockedNavigations.length > 0
      ? [``, `## Blocked navigations (${report.blockedNavigations.length})`, ``, ...report.blockedNavigations.map((u) => `- ${u}`)]
      : []),
    ...(findings.length > 0
      ? [
          ``,
          `## Navigator findings (${findings.length}, not graded)`,
          ``,
          ...findings.map((f) => `- **[${f.severity}]** ${f.title} — ${f.description}`),
        ]
      : []),
  ].join("\n");
}

/**
 * `shoal qa`'s own report shape (Requirements §3) — deliberately not `writeTaskReport`'s
 * findings/summary format: `{mission, url, model, repeats, verdict, expectations, guards, ...}`.
 * Evidence screenshots are written as sibling JPEGs and the JSON points at their file paths
 * instead of carrying base64 blobs.
 */
export async function writeQaReport(
  report: QaReport,
  findings: Finding[],
  outDir: string = process.cwd(),
  secrets: string[] = [],
): Promise<{ mdPath: string; jsonPath: string }> {
  const safeFindings = secrets.length ? findings.map((f) => redactFinding(f, secrets)) : findings;
  const dir = join(outDir, "reports");
  await mkdir(dir, { recursive: true });
  const base = `qa-${report.mission}-${qaTimestamp(new Date(report.finishedAt))}`;
  const evidenceDir = join(dir, `${base}-evidence`);

  const withEvidence = report.expectations.filter((e) => e.evidence?.screenshot);
  if (withEvidence.length > 0) {
    await mkdir(evidenceDir, { recursive: true });
    await Promise.all(
      withEvidence.map((e) => writeFile(join(evidenceDir, `${e.id}.jpg`), Buffer.from(e.evidence!.screenshot!, "base64"))),
    );
  }
  // Rewrite the JSON/md to point at the saved file, not the base64 blob.
  const fileReport: QaReport = {
    ...report,
    expectations: report.expectations.map((e) =>
      e.evidence?.screenshot ? { ...e, evidence: { ...e.evidence, screenshot: `${base}-evidence/${e.id}.jpg` } } : e,
    ),
  };

  const mdPath = join(dir, `${base}.md`);
  const jsonPath = join(dir, `${base}.json`);
  await writeFile(mdPath, buildQaReportMd(fileReport, safeFindings), "utf8");
  await writeFile(jsonPath, JSON.stringify({ ...fileReport, findings: safeFindings }, null, 2), "utf8");
  return { mdPath, jsonPath };
}
