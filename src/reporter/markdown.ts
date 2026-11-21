import type { AnalysisReport, Finding } from '../types.ts';

export const REPORT_MARKER = '<!-- telemetry-prs-report -->';

export interface FormatPrCommentOptions {
  repoUrl?: string;
  headSha?: string;
}

function severityIcon(severity: Finding['severity']): string {
  return severity === 'error' ? '🔴' : '🟡';
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

  const parts: string[] = [];
  if (report.errorsCount > 0) {
    parts.push(`**${report.errorsCount}** error${report.errorsCount === 1 ? '' : 's'}`);
  }
  if (report.warningsCount > 0) {
    parts.push(`**${report.warningsCount}** warning${report.warningsCount === 1 ? '' : 's'}`);
  }

  lines.push(`### 🔭 Telemetry PRs — ${parts.join(', ')} in touched code`);
  lines.push('');
  lines.push(
    `Telemetry coverage on touched code: **${report.coveragePercent}%** (${report.passedUnits}/${report.checkedUnits} passed across ${report.checkedFiles} file(s)).`,
  );
  lines.push('');
  lines.push('| Severity | Location | Rule | Finding |');
  lines.push('| :--- | :--- | :--- | :--- |');

  for (const f of report.findings) {
    const loc = formatLocation(f.filePath, f.line, options);
    const rule = `\`${f.ruleId}\``;
    lines.push(
      `| ${severityIcon(f.severity)} ${f.severity} | ${loc} | ${rule} | ${f.message} |`,
    );
  }

  lines.push('');
  lines.push('<details>');
  lines.push('<summary>Suggested instrumentation hints</summary>');
  lines.push('');

  for (const f of report.findings) {
    const loc = formatLocation(f.filePath, f.line, options);
    lines.push(`- **${loc}** (\`${f.symbolName}\`): ${f.suggestion}`);
  }

  lines.push('');
  lines.push(
    '> To silence a deliberate exception, add `// telemetry-prs-ignore` (or `// telemetry-prs-ignore: <rule-id>`) above the handler, catch block, or span call. Customize rules in `.telemetry-prs.yml`.',
  );
  lines.push('</details>');

  return lines.join('\n');
}

export function formatTerminalReport(report: AnalysisReport): string {
  if (report.findings.length === 0) {
    return `Telemetry PRs: OK (${report.coveragePercent}% coverage — ${report.passedUnits}/${report.checkedUnits} units passed across ${report.checkedFiles} file(s), 0 gaps found).`;
  }

  const lines: string[] = [
    `Telemetry PRs: ${report.coveragePercent}% coverage (${report.passedUnits}/${report.checkedUnits} passed) — found ${report.findings.length} gap(s) (${report.errorsCount} error(s), ${report.warningsCount} warning(s)) across ${report.checkedFiles} file(s):`,
    '',
  ];

  for (const f of report.findings) {
    const tag = f.severity === 'error' ? 'ERROR' : 'WARN ';
    lines.push(`  [${tag}] ${f.filePath}:${f.line} (${f.ruleId})`);
    lines.push(`          ${f.message}`);
    lines.push(`          Hint: ${f.suggestion}`);
  }

  return lines.join('\n');
}
