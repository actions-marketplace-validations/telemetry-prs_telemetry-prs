import fs from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { rangeTouchesAddedLines } from '../diff.ts';
import { detectRepoTelemetry } from '../repo-telemetry.ts';
import type {
  AnalysisReport,
  CodeUnit,
  DiffFile,
  Finding,
  Impact,
  RuleConfig,
  SignalKind,
  TelemetryConfig,
} from '../types.ts';
import { extractCodeUnits } from './ast.ts';

export function shouldCheckFile(
  filePath: string,
  config: TelemetryConfig,
): boolean {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');

  const included = config.include.some((pattern) =>
    minimatch(normalized, pattern, { dot: true }),
  );
  if (!included) {
    return false;
  }

  const excluded = config.exclude.some((pattern) =>
    minimatch(normalized, pattern, { dot: true }),
  );
  return !excluded;
}

function evaluateSignals(
  found: SignalKind[],
  rule: RuleConfig,
): { passed: boolean; missing: SignalKind[] } {
  const foundSet = new Set(found);
  const missing = rule.require.filter((sig) => !foundSet.has(sig));

  if (rule.matchMode === 'all') {
    return { passed: missing.length === 0, missing };
  }

  const hasAny = rule.require.some((sig) => foundSet.has(sig));
  return {
    passed: hasAny,
    missing: hasAny ? [] : rule.require,
  };
}

function inlineCode(text: string): string {
  if (!text.includes('`')) {
    return `\`${text}\``;
  }
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `\`\`${pad}${text}${pad}\`\``;
}

function buildSuggestion(unit: CodeUnit): string {
  switch (unit.kind) {
    case 'http-handler':
      return `Wrap business logic in \`tracer.startActiveSpan('${unit.symbolName}', async (span) => { ... })\` or record a business counter/histogram.`;
    case 'queue-consumer':
      return `Start a span per job/message (\`tracer.startActiveSpan('${unit.symbolName}', async (span) => { ... })\`) and record job outcome metrics.`;
    case 'catch-block':
      return `Call \`span.recordException(err)\`, emit a structured error log (\`logger.error({ err }, '...')\`), increment an error counter, or rethrow.`;
    case 'metric-cardinality':
      return `Remove unbounded identifiers from metric labels (keep them on trace spans or structured logs instead), use parameterized route templates (\`http.route\` / \`req.route.path\`), and pair with OpenTelemetry SDK Views or Collector attribute filters for runtime protection.`;
    case 'span-name':
      switch (unit.spanNameIssue) {
        case 'high-cardinality':
          return `Use a static, low-cardinality span name (e.g. \`'orders.get'\`) and pass dynamic values via \`span.setAttribute('order.id', id)\` instead of embedding them in the span name.`;
        case 'empty-name':
          return `Provide a non-empty, descriptive static OpenTelemetry span name (e.g. \`'service.operation'\`).`;
        case 'generic-name':
          return `Replace generic span name ${unit.spanNameRaw ? inlineCode(unit.spanNameRaw) : ''} with a descriptive \`<domain>.<action>\` name (e.g. \`'checkout.charge_card'\`).`;
        default:
          return `Use a static, descriptive OpenTelemetry span name.`;
      }
  }
}

function formatList(items: string[], conjunction: 'and' | 'or'): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, ${conjunction} ${items[items.length - 1]}`;
}

function buildMessage(unit: CodeUnit, rule: RuleConfig, missing: SignalKind[]): string {
  const needText = formatList(missing, rule.matchMode === 'all' ? 'and' : 'or');

  switch (unit.kind) {
    case 'http-handler':
      return `HTTP handler ${inlineCode(unit.symbolName)} has no custom ${needText} instrumentation.`;
    case 'queue-consumer':
      return `Background worker ${inlineCode(unit.symbolName)} has no ${needText} instrumentation.`;
    case 'catch-block':
      return `Catch block ${inlineCode(unit.symbolName)} swallows errors without ${needText}.`;
    case 'metric-cardinality': {
      const parts: string[] = [];
      if (unit.cardinalityLabels && unit.cardinalityLabels.length > 0) {
        parts.push(
          `unbounded label key${unit.cardinalityLabels.length === 1 ? '' : 's'} ${formatList(unit.cardinalityLabels.map(inlineCode), 'and')}`,
        );
      }
      if (unit.cardinalityValues && unit.cardinalityValues.length > 0) {
        parts.push(
          `dynamic value${unit.cardinalityValues.length === 1 ? '' : 's'} ${formatList(unit.cardinalityValues.map(inlineCode), 'and')}`,
        );
      }
      const detail = parts.length > 0 ? parts.join(' and ') : 'high-cardinality attributes';
      return `Metric call ${inlineCode(unit.symbolName)} uses ${detail}, which can explode active time series and monitoring costs.`;
    }
    case 'span-name':
      switch (unit.spanNameIssue) {
        case 'high-cardinality':
          return `Span name ${inlineCode(unit.spanNameRaw ?? unit.symbolName)} is high-cardinality (dynamic interpolation/concatenation); dynamic values belong in \`span.setAttribute(...)\`.`;
        case 'empty-name':
          return `Span call ${inlineCode(unit.symbolName)} uses an empty or whitespace-only span name.`;
        case 'generic-name':
          return `Span name ${inlineCode(unit.spanNameRaw ?? unit.symbolName)} is too generic to identify operations in traces.`;
        default:
          return `Span call ${inlineCode(unit.symbolName)} violates OpenTelemetry naming guidelines.`;
      }
  }
}

function resolveFindingImpact(unit: CodeUnit, rule: RuleConfig): Impact {
  if (unit.kind === 'span-name' && unit.spanNameIssue === 'high-cardinality') {
    return 'high';
  }
  return rule.impact;
}

export interface AnalyzeTarget {
  filePath: string;
  content: string;

  addedLines?: Set<number>;
}

const IMPACT_ORDER: Record<Impact, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export function analyzeTargets(
  targets: AnalyzeTarget[],
  config: TelemetryConfig,
): AnalysisReport {
  const findings: Finding[] = [];
  let checkedFiles = 0;
  let checkedUnits = 0;

  for (const target of targets) {
    if (!shouldCheckFile(target.filePath, config)) {
      continue;
    }
    checkedFiles += 1;

    const units = extractCodeUnits(
      target.filePath,
      target.content,
      config.telemetry,
    );

    for (const unit of units) {
      const rule = config.rules[unit.ruleId];
      if (!rule.enabled) {
        continue;
      }

      if (unit.ignored) {
        continue;
      }

      if (unit.kind === 'catch-block' && unit.rethrows) {
        continue;
      }

      if (unit.lineCount < rule.minLines) {
        continue;
      }

      if (
        target.addedLines &&
        !rangeTouchesAddedLines(unit.startLine, unit.endLine, target.addedLines)
      ) {
        continue;
      }

      if (unit.kind === 'span-name') {
        if (unit.spanNameIssue) {
          findings.push({
            filePath: target.filePath.replace(/\\/g, '/'),
            line: unit.startLine,
            endLine: unit.endLine,
            ruleId: unit.ruleId,
            impact: resolveFindingImpact(unit, rule),
            kind: unit.kind,
            symbolName: unit.symbolName,
            framework: unit.framework,
            requiredSignals: [],
            matchMode: rule.matchMode,
            foundSignals: [],
            missingSignals: [],
            message: buildMessage(unit, rule, []),
            suggestion: buildSuggestion(unit),
          });
        }
        continue;
      }

      if (unit.kind === 'metric-cardinality') {
        findings.push({
          filePath: target.filePath.replace(/\\/g, '/'),
          line: unit.startLine,
          endLine: unit.endLine,
          ruleId: unit.ruleId,
          impact: resolveFindingImpact(unit, rule),
          kind: unit.kind,
          symbolName: unit.symbolName,
          framework: unit.framework,
          requiredSignals: [],
          matchMode: rule.matchMode,
          foundSignals: [],
          missingSignals: [],
          message: buildMessage(unit, rule, []),
          suggestion: buildSuggestion(unit),
        });
        continue;
      }

      checkedUnits += 1;

      const { passed, missing } = evaluateSignals(unit.foundSignals, rule);
      if (!passed) {
        findings.push({
          filePath: target.filePath.replace(/\\/g, '/'),
          line: unit.startLine,
          endLine: unit.endLine,
          ruleId: unit.ruleId,
          impact: resolveFindingImpact(unit, rule),
          kind: unit.kind,
          symbolName: unit.symbolName,
          framework: unit.framework,
          requiredSignals: rule.require,
          matchMode: rule.matchMode,
          foundSignals: unit.foundSignals,
          missingSignals: missing,
          message: buildMessage(unit, rule, missing),
          suggestion: buildSuggestion(unit),
        });
      }
    }
  }

  findings.sort(
    (a, b) =>
      IMPACT_ORDER[a.impact] - IMPACT_ORDER[b.impact] ||
      a.filePath.localeCompare(b.filePath) ||
      a.line - b.line ||
      a.ruleId.localeCompare(b.ruleId),
  );

  const highImpactCount = findings.filter((f) => f.impact === 'high').length;
  const mediumImpactCount = findings.filter((f) => f.impact === 'medium').length;
  const lowImpactCount = findings.filter((f) => f.impact === 'low').length;
  const coverageGapCount = findings.filter(
    (f) => f.kind !== 'span-name' && f.kind !== 'metric-cardinality',
  ).length;
  const passedUnits = Math.max(0, checkedUnits - coverageGapCount);
  const coveragePercent =
    checkedUnits === 0 ? 100 : Math.round((passedUnits / checkedUnits) * 100);

  return {
    checkedFiles,
    checkedUnits,
    passedUnits,
    coveragePercent,
    findings,
    highImpactCount,
    mediumImpactCount,
    lowImpactCount,
  };
}

export function analyzeDiffFiles(
  cwd: string,
  diffFiles: DiffFile[],
  config: TelemetryConfig,
): AnalysisReport {
  const targets: AnalyzeTarget[] = [];

  for (const df of diffFiles) {
    if (!shouldCheckFile(df.filePath, config)) {
      continue;
    }
    const fullPath = path.resolve(cwd, df.filePath);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      continue;
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    targets.push({
      filePath: df.filePath,
      content,
      addedLines: df.addedLines,
    });
  }

  const report = analyzeTargets(targets, config);
  report.repoTelemetry = detectRepoTelemetry(cwd);
  return report;
}
