import type { AnalysisReport, Impact } from '../types.ts';

export const REPORT_MARKER = '<!-- telemetry-prs-report -->';

export interface FormatPrCommentOptions {
  repoUrl?: string;
  headSha?: string;
}

function impactBadge(impact: Impact): string {
  switch (impact) {
    case 'high':
      return '🔴 high';
    case 'medium':
      return '🟠 medium';
    case 'low':
      return '🔵 low';
  }
}

function terminalImpactTag(impact: Impact): string {
  switch (impact) {
    case 'high':
      return 'HIGH';
    case 'medium':
      return 'MED ';
    case 'low':
      return 'LOW ';
  }
}

function inlineCode(text: string): string {
  if (!text.includes('`')) {
    return `\`${text}\``;
  }
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `\`\`${pad}${text}${pad}\`\``;
}

function formatLocation(
  filePath: string,
  line: number,
  options?: FormatPrCommentOptions,
): string {
  const label = `\`${filePath}:${line}\``;
  if (options?.repoUrl && options?.headSha) {
    const base = options.repoUrl.replace(/\/+$/, '');
    const encodedPath = filePath
      .replace(/^\/+/, '')
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const url = `${base}/blob/${encodeURIComponent(options.headSha)}/${encodedPath}#L${line}`;
    return `[${label}](${url})`;
  }
  return label;
}

function formatImpactSummary(report: AnalysisReport): string {
  const parts: string[] = [];
  if (report.highImpactCount > 0) {
    parts.push(`**${report.highImpactCount}** high`);
  }
  if (report.mediumImpactCount > 0) {
    parts.push(`**${report.mediumImpactCount}** medium`);
  }
  if (report.lowImpactCount > 0) {
    parts.push(`**${report.lowImpactCount}** low`);
  }
  return `${parts.join(', ')} impact`;
}

export function formatPrComment(
  report: AnalysisReport,
  options?: FormatPrCommentOptions,
): string {
  const lines: string[] = [REPORT_MARKER];

  if (report.findings.length === 0) {
    lines.push('### ✅ Telemetry PRs — No instrumentation gaps detected');
    lines.push('');
    lines.push(
      `Telemetry coverage: **${report.coveragePercent}%** (${report.passedUnits}/${report.checkedUnits} touched units passed across **${report.checkedFiles}** file(s)).`,
    );
    return lines.join('\n');
  }

  lines.push(`### 🔭 Telemetry PRs — ${formatImpactSummary(report)} in touched code`);
  lines.push('');
  lines.push(
    `Telemetry coverage on touched code: **${report.coveragePercent}%** (${report.passedUnits}/${report.checkedUnits} passed across ${report.checkedFiles} file(s)).`,
  );

  if (
    report.repoTelemetry &&
    report.repoTelemetry.checkedManifests > 0 &&
    !report.repoTelemetry.hasAnySdk
  ) {
    const setupHint = report.repoTelemetry.hasWranglerConfig
      ? 'Wire up `@opentelemetry/api` or enable `[observability]` in `wrangler.toml` first'
      : 'Wire up an SDK (e.g. `@opentelemetry/api`, `prom-client`, `pino`, or `winston`) first';
    lines.push('');
    lines.push(
      `> **No observability SDK detected in this repo** (\`package.json\`${report.repoTelemetry.hasWranglerConfig ? ' / `wrangler.toml`' : ''}). ${setupHint}, or configure custom library patterns in \`.telemetry-prs.yml\`.`,
    );
  }

  lines.push('');
  lines.push('| Impact | Location | Rule | Finding |');
  lines.push('| :--- | :--- | :--- | :--- |');

  for (const f of report.findings) {
    const loc = formatLocation(f.filePath, f.line, options);
    const rule = `\`${f.ruleId}\``;
    lines.push(
      `| ${impactBadge(f.impact)} | ${loc} | ${rule} | ${f.message} |`,
    );
  }

  lines.push('');
  lines.push('<details>');
  lines.push('<summary>Suggested instrumentation hints</summary>');
  lines.push('');

  for (const f of report.findings) {
    const loc = formatLocation(f.filePath, f.line, options);
    lines.push(`- **${loc}** (${inlineCode(f.symbolName)}): ${f.suggestion}`);
  }

  lines.push('');
  lines.push(
    '> To silence a deliberate exception, add `// telemetry-prs-ignore` (or `// telemetry-prs-ignore: <rule-id>`) above the handler, catch block, metric call, or span call. Customize impact tiers and rules in `.telemetry-prs.yml`.',
  );
  lines.push('</details>');

  return lines.join('\n');
}

export function formatTerminalReport(report: AnalysisReport): string {
  if (report.findings.length === 0) {
    return `Telemetry PRs: OK (${report.coveragePercent}% coverage — ${report.passedUnits}/${report.checkedUnits} units passed across ${report.checkedFiles} file(s), 0 gaps found).`;
  }

  const lines: string[] = [
    `Telemetry PRs: ${report.coveragePercent}% coverage (${report.passedUnits}/${report.checkedUnits} passed) — found ${report.findings.length} gap(s) (${report.highImpactCount} high, ${report.mediumImpactCount} medium, ${report.lowImpactCount} low impact) across ${report.checkedFiles} file(s):`,
  ];

  if (
    report.repoTelemetry &&
    report.repoTelemetry.checkedManifests > 0 &&
    !report.repoTelemetry.hasAnySdk
  ) {
    const setupHint = report.repoTelemetry.hasWranglerConfig
      ? 'install @opentelemetry/api or enable [observability] in wrangler.toml'
      : 'install @opentelemetry/api (or pino/winston/prom-client)';
    lines.push(
      `Note: No observability SDK detected in this repo (${setupHint}, or configure custom patterns in .telemetry-prs.yml).`,
    );
  }

  lines.push('');

  for (const f of report.findings) {
    lines.push(`  [${terminalImpactTag(f.impact)}] ${f.filePath}:${f.line} (${f.ruleId})`);
    lines.push(`          ${f.message}`);
    lines.push(`          Hint: ${f.suggestion}`);
  }

  return lines.join('\n');
}
