import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { comparisonRows } from "./pricing.js";
import { redactFinding, redactText } from "./redact.js";
import type { AgentState, Finding, FrictionCluster, RunOptions, RunSummary } from "./types.js";

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
  if (opts.provider === "subscription" || opts.provider === "codex") {
    const label = opts.provider === "codex" ? "ChatGPT subscription via Codex CLI" : "Claude subscription";
    return [`- **Cost:** $0.00 (${label}; ${totalTokens.toLocaleString()} reported tokens)`];
  }
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
}

function cell(text: string | undefined): string {
  return (text ?? "—").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim() || "—";
}

function escapeHtml(value: string | undefined): string {
  return (value ?? "—")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildReportMd(
  findings: Finding[],
  summary: RunSummary,
  opts: RunOptions,
  meta?: ReportMeta,
  agents: AgentState[] = [],
): string {
  const clusters = clusterFindings(findings);
  const sevIcon = { high: "🔴", medium: "🟡", low: "🔵" } as const;
  const buyerResults = agents.filter((a) => a.result?.purchaseIntent && a.result.purchaseIntent !== "not_applicable");
  const intentCounts = {
    yes: buyerResults.filter((a) => a.result?.purchaseIntent === "yes").length,
    maybe: buyerResults.filter((a) => a.result?.purchaseIntent === "maybe").length,
    no: buyerResults.filter((a) => a.result?.purchaseIntent === "no").length,
  };

  const swarmLabel = opts.mock
    ? "mock mode"
    : opts.provider === "codex"
      ? "Codex CLI · ChatGPT subscription"
      : opts.model;
  const header = meta
    ? [
        `# 🐟 Shoal task report — ${meta.title}`,
        ``,
        `- **Id:** ${meta.id}`,
        `- **Target:** ${opts.url}`,
        `- **Task:** ${opts.task}`,
        `- **Strategy:** ${opts.strategyIds?.join(", ") || "default"}`,
        `- **Swarm:** ${summary.total} agents (${swarmLabel})`,
        ...(opts.readOnly ? [`- **Browsing:** read-only; form entry and transaction actions were blocked`] : []),
        `- **Started:** ${new Date(meta.startedAt).toISOString()}`,
        `- **Finished:** ${new Date(meta.finishedAt).toISOString()}`,
        `- **Outcome:** ${summary.completed} completed · ${summary.gaveUp} gave up · ${summary.errored} errored`,
      ]
    : [
        `# 🐟 Shoal swarm report`,
        ``,
        `- **Target:** ${opts.url}`,
        `- **Task:** ${opts.task}`,
        `- **Swarm:** ${summary.total} agents (${swarmLabel})`,
        ...(opts.readOnly ? [`- **Browsing:** read-only; form entry and transaction actions were blocked`] : []),
        `- **Outcome:** ${summary.completed} completed · ${summary.gaveUp} gave up · ${summary.errored} errored`,
      ];

  return [
    ...header,
    ...costLines(summary, opts),
    ``,
    ...(buyerResults.length
      ? [
          `## Simulated buyer feedback`,
          ``,
          `These are AI persona responses based on the pages they visited; they are directional feedback, not observed customer demand.`,
          ``,
          `Among **${buyerResults.length}** respondents: **${intentCounts.yes} yes**, **${intentCounts.maybe} maybe**, **${intentCounts.no} no** would buy.`,
          ``,
          `| Persona | Intent | Offer | Rationale | Recommendation |`,
          `|---|---|---|---|---|`,
          ...buyerResults.map((a) =>
            `| ${cell(a.personaName)} | ${cell(a.result?.purchaseIntent)} | ${cell(a.result?.chosenOffer)} | ${cell(a.result?.reason)} | ${cell(a.result?.recommendation)} |`,
          ),
          ``,
        ]
      : []),
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

export async function writeReport(
  findings: Finding[],
  summary: RunSummary,
  opts: RunOptions,
  agents: AgentState[] = [],
): Promise<string> {
  const md = buildReportMd(findings, summary, opts, undefined, agents);
  const clusters = clusterFindings(findings);
  const buyerResults = agents.filter((a) => a.result?.purchaseIntent && a.result.purchaseIntent !== "not_applicable");
  const intentCounts = {
    yes: buyerResults.filter((a) => a.result?.purchaseIntent === "yes").length,
    maybe: buyerResults.filter((a) => a.result?.purchaseIntent === "maybe").length,
    no: buyerResults.filter((a) => a.result?.purchaseIntent === "no").length,
  };
  const mdPath = join(process.cwd(), "shoal-report.md");
  const jsonPath = join(process.cwd(), "shoal-report.json");
  const htmlPath = join(process.cwd(), "shoal-report.html");
  const reportAgents = agents.map(({ screenshot: _screenshot, ...agent }) => agent);

  const totalTokens = summary.usage.input + summary.usage.cacheRead + summary.usage.cacheWrite + summary.usage.output;
  const providerLabel = opts.mock
    ? "Mock mode"
    : opts.provider === "codex"
      ? "Codex CLI using ChatGPT subscription"
      : opts.provider === "subscription"
        ? "Claude subscription"
        : opts.model;
  const htmlCost = opts.mock
    ? "$0.00 (mock mode)"
    : opts.provider === "codex" || opts.provider === "subscription"
      ? `$0.00 (${providerLabel}; ${totalTokens.toLocaleString()} reported tokens)`
      : summary.costUsd !== null
        ? `$${summary.costUsd.toFixed(2)}`
        : totalTokens > 0
          ? `${totalTokens.toLocaleString()} tokens (price unknown)`
          : "Not reported";
  const findingCount = findings.length;
  const htmlFindings = clusters.length
    ? clusters.map((cluster) => {
        const examples = cluster.examples.slice(0, 3).map((finding) => `
          <blockquote>
            <p><strong>${escapeHtml(finding.personaName)}:</strong> ${escapeHtml(finding.description)}</p>
            ${finding.verdict?.status === "suspect" ? `<p class="suspect">Verifier note: ${escapeHtml(finding.verdict.note)}</p>` : ""}
          </blockquote>`).join("");
        const suspect = cluster.examples.every((finding) => finding.verdict?.status === "suspect");
        return `
          <article class="finding ${escapeHtml(cluster.severity)}">
            <div class="finding-meta"><span class="severity">${escapeHtml(cluster.severity)} severity</span><span>Seen by ${cluster.reach} of ${summary.total} agents</span></div>
            <h3>${escapeHtml(cluster.title)}${suspect ? ` <span class="suspect">(possible agent artifact)</span>` : ""}</h3>
            <p>Personas: ${cluster.hitBy.map(escapeHtml).join(", ")}</p>
            ${examples}
          </article>`;
      }).join("")
    : `<p class="empty">No findings were reported in this run.</p>`;
  const htmlBuyers = buyerResults.length
    ? `<div class="buyer-counts" aria-label="Simulated purchase intent counts">
        <div><strong>${intentCounts.yes}</strong><span>Yes</span></div>
        <div><strong>${intentCounts.maybe}</strong><span>Maybe</span></div>
        <div><strong>${intentCounts.no}</strong><span>No</span></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th scope="col">Persona</th><th scope="col">Intent</th><th scope="col">Offer</th><th scope="col">Rationale</th><th scope="col">Recommendation</th></tr></thead>
        <tbody>${buyerResults.map((agent) => `<tr>
          <td>${escapeHtml(agent.emoji)} ${escapeHtml(agent.personaName)}</td>
          <td><span class="intent ${escapeHtml(agent.result?.purchaseIntent)}">${escapeHtml(agent.result?.purchaseIntent)}</span></td>
          <td>${escapeHtml(agent.result?.chosenOffer)}</td>
          <td>${escapeHtml(agent.result?.reason)}</td>
          <td>${escapeHtml(agent.result?.recommendation)}</td>
        </tr>`).join("")}</tbody>
      </table></div>`
    : `<p class="empty">No structured purchase-intent responses were recorded.</p>`;
  const generatedAt = new Date().toISOString();
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Shoal website evaluation report for ${escapeHtml(opts.url)}">
  <title>Shoal report — ${escapeHtml(new URL(opts.url).hostname)}</title>
  <style>
    :root{color-scheme:light;--ink:#19251f;--muted:#65736a;--line:#dce5df;--paper:#fff;--wash:#f2f6f3;--green:#18794e;--amber:#a86100;--red:#b42318}
    *{box-sizing:border-box}body{margin:0;background:var(--wash);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
    main{max-width:1120px;margin:0 auto;padding:40px 24px 64px}header,.panel{background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:24px;margin-bottom:20px;box-shadow:0 3px 14px #2036290a}
    h1,h2,h3,p{margin-top:0}h1{font-size:clamp(1.8rem,4vw,2.7rem);line-height:1.15;margin-bottom:8px}h2{font-size:1.35rem;margin-bottom:12px}h3{font-size:1.08rem;margin-bottom:8px}header p,.muted,.empty{color:var(--muted)}.eyebrow{text-transform:uppercase;letter-spacing:.12em;color:var(--green);font-size:.75rem;font-weight:750}
    .facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px;margin:22px 0 0}.facts div{padding:12px;background:var(--wash);border-radius:10px;min-width:0}.facts dt{font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700}.facts dd{margin:4px 0 0;overflow-wrap:anywhere}.facts .wide{grid-column:1/-1}
    .buyer-counts{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0}.buyer-counts div{min-width:105px;padding:12px 18px;border:1px solid var(--line);border-radius:12px;display:grid;text-align:center}.buyer-counts strong{font-size:1.7rem}.buyer-counts span{color:var(--muted);font-size:.85rem}
    .table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;min-width:760px}th,td{text-align:left;vertical-align:top;padding:12px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}th{font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}.intent{font-weight:750;text-transform:capitalize}.intent.yes{color:var(--green)}.intent.maybe{color:var(--amber)}.intent.no{color:var(--red)}
    .finding{padding:18px;border:1px solid var(--line);border-left:5px solid #668274;border-radius:12px;margin:14px 0}.finding.high{border-left-color:var(--red)}.finding.medium{border-left-color:var(--amber)}.finding.low{border-left-color:#3575b5}.finding-meta{display:flex;justify-content:space-between;gap:12px;color:var(--muted);font-size:.85rem}.severity{font-weight:750;text-transform:capitalize}.finding blockquote{margin:12px 0 0;padding:10px 14px;border-left:2px solid var(--line);color:#405047}.finding blockquote p{margin:0}.finding blockquote .suspect{margin-top:6px;color:var(--amber)}.suspect{color:var(--amber);font-size:.88em}
    .note{padding:14px 16px;border-radius:10px;background:#edf4ef;color:#35483b}.foot{font-size:.83rem;color:var(--muted);margin-top:24px}
    @media(max-width:600px){main{padding:20px 12px 40px}header,.panel{padding:18px}.finding-meta{display:block}}
    @media print{body{background:#fff}main{max-width:none;padding:0}.panel,header{box-shadow:none;break-inside:avoid}.finding{break-inside:avoid}a{color:inherit}}
  </style>
</head>
<body>
  <main>
    <header>
      <div class="eyebrow">Shoal website evaluation</div>
      <h1>${escapeHtml(new URL(opts.url).hostname)}</h1>
      <p>Generated ${escapeHtml(generatedAt)} · ${summary.durationMs ? `${(summary.durationMs / 1000).toFixed(0)} seconds` : "duration unavailable"}</p>
      <dl class="facts">
        <div><dt>Target</dt><dd><a href="${escapeHtml(opts.url)}">${escapeHtml(opts.url)}</a></dd></div>
        <div><dt>Provider</dt><dd>${escapeHtml(providerLabel)}</dd></div>
        <div><dt>Swarm</dt><dd>${summary.total} agents</dd></div>
        <div><dt>Outcome</dt><dd>${summary.completed} completed · ${summary.gaveUp} gave up · ${summary.errored} errored</dd></div>
        <div><dt>Reported usage</dt><dd>${totalTokens.toLocaleString()} tokens · ${escapeHtml(htmlCost)}</dd></div>
        <div><dt>Browsing mode</dt><dd>${opts.readOnly ? "Read-only" : "Standard"}</dd></div>
        <div class="wide"><dt>Evaluation task</dt><dd>${escapeHtml(opts.task)}</dd></div>
      </dl>
    </header>
    <section class="panel" aria-labelledby="buyers-heading">
      <h2 id="buyers-heading">Simulated buyer feedback</h2>
      <p class="note">These are AI persona responses based on the public pages visited. They are directional feedback, not observed customer demand or a measured conversion rate.</p>
      ${htmlBuyers}
    </section>
    <section class="panel" aria-labelledby="findings-heading">
      <h2 id="findings-heading">Findings <span class="muted">(${clusters.length} grouped issues, ${findingCount} reports)</span></h2>
      ${htmlFindings}
    </section>
    <p class="foot">Generated locally by Shoal. Reported token totals may follow the provider's session accounting and do not represent a separate OpenAI Platform API bill.</p>
  </main>
</body>
</html>`;

  await writeFile(mdPath, md, "utf8");
  await writeFile(jsonPath, JSON.stringify({ summary, clusters, findings, agents: reportAgents }, null, 2), "utf8");
  await writeFile(htmlPath, html, "utf8");
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
  meta: { id: string; title: string; startedAt: number; finishedAt?: number },
  secrets: string[] = [],
): Promise<{ mdPath: string; jsonPath: string }> {
  const finishedAt = meta.finishedAt ?? Date.now();
  const safeFindings = secrets.length ? findings.map((f) => redactFinding(f, secrets)) : findings;
  const safeOpts: RunOptions = secrets.length ? { ...opts, task: redactText(opts.task, secrets) } : opts;
  const safeTitle = secrets.length ? redactText(meta.title, secrets) : meta.title;

  const md = buildReportMd(safeFindings, summary, safeOpts, { id: meta.id, title: safeTitle, startedAt: meta.startedAt, finishedAt });
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
