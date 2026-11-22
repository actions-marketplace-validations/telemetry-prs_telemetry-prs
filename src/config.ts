import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type {
  AnalysisReport,
  BlockOn,
  CheckMode,
  Impact,
  RuleConfig,
  RuleId,
  TelemetryConfig,
  TelemetryPatterns,
} from './types.ts';

export const DEFAULT_CONFIG: TelemetryConfig = {
  version: 1,
  blockOn: 'none',
  include: [
    '**/*.ts',
    '**/*.js',
    '**/*.mts',
    '**/*.cts',
    '**/*.mjs',
    '**/*.cjs',
  ],
  exclude: [
    '**/*.test.*',
    '**/*.spec.*',
    '**/*.d.ts',
    '**/__tests__/**',
    '**/__mocks__/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/.yarn/**',
    '**/.pnp.*',
    '**/*.min.*',
    '**/vendor/**',
    '**/coverage/**',
    '**/node_modules/**',
    '**/examples/**',
    '**/scripts/**',
    '**/website/**',
    '**/docs/**',
  ],
  telemetry: {
    spans: [
      'startActiveSpan',
      'startSpan',
      'withSpan',
      'trace.getTracer',
      'span.setAttribute',
      'span.addEvent',
      'setAttributes',
    ],
    spanErrors: ['recordException', 'setStatus'],
    metrics: [
      '.add(',
      '.record(',
      '.inc(',
      '.dec(',
      '.observe(',
      '.set(',
      'createCounter',
      'createHistogram',
      'createUpDownCounter',
      'increment(',
    ],
    logs: [
      'logger.info',
      'logger.warn',
      'logger.error',
      'logger.fatal',
      'log.info',
      'log.warn',
      'log.error',
      'log.fatal',
      'req.log.',
      'request.log.',
    ],
  },
  rules: {
    'metric-cardinality': {
      enabled: true,
      impact: 'high',
      require: [],
      matchMode: 'any',
      minLines: 1,
      description:
        'Metric labels and attributes must stay low-cardinality to prevent TSDB and billing explosions',
    },
    'queue-consumers': {
      enabled: true,
      impact: 'high',
      require: ['span', 'metric'],
      matchMode: 'any',
      minLines: 3,
      description:
        'Background jobs and queue consumers run off-request and must be instrumented',
    },
    'error-swallowing': {
      enabled: true,
      impact: 'medium',
      require: ['span-error', 'log', 'metric'],
      matchMode: 'any',
      minLines: 1,
      description:
        'Catch blocks that do not rethrow should record an exception, log, or increment an error metric',
    },
    'http-handlers': {
      enabled: true,
      impact: 'medium',
      require: ['span', 'metric'],
      matchMode: 'any',
      minLines: 4,
      description:
        'HTTP route handlers should emit a custom span or business metric',
    },
    'otel-naming': {
      enabled: true,
      impact: 'low',
      require: [],
      matchMode: 'any',
      minLines: 1,
      description:
        'OpenTelemetry span names should be static, low-cardinality, and descriptive',
    },
  },
};

interface PartialRuleConfig extends Partial<RuleConfig> {
  severity?: 'error' | 'warning';
}

interface PartialConfig {
  version?: number;
  blockOn?: BlockOn;
  mode?: CheckMode;
  include?: string[];
  exclude?: string[];
  telemetry?: Partial<TelemetryPatterns>;
  rules?: Partial<Record<RuleId, PartialRuleConfig>>;
}

const VALID_IMPACTS = new Set<Impact>(['high', 'medium', 'low']);
const VALID_BLOCK_ON = new Set<BlockOn>(['none', 'high', 'medium', 'low']);

function resolveRuleImpact(
  rule: PartialRuleConfig | undefined,
  fallback: Impact,
): Impact {
  if (rule?.impact && VALID_IMPACTS.has(rule.impact)) {
    return rule.impact;
  }
  if (rule?.severity === 'error') {
    return 'high';
  }
  if (rule?.severity === 'warning') {
    return 'medium';
  }
  return fallback;
}

function mergeRule(
  base: RuleConfig,
  override: PartialRuleConfig | undefined,
): RuleConfig {
  if (!override) {
    return { ...base };
  }
  const { severity: _legacySeverity, ...rest } = override;
  return {
    ...base,
    ...rest,
    impact: resolveRuleImpact(override, base.impact),
  };
}

export function resolveBlockOn(
  blockOn: string | undefined,
  legacyMode: string | undefined,
  fallback: BlockOn = 'none',
): BlockOn {
  if (blockOn && VALID_BLOCK_ON.has(blockOn as BlockOn)) {
    return blockOn as BlockOn;
  }
  if (legacyMode === 'fail') {
    return 'high';
  }
  if (legacyMode === 'comment') {
    return 'none';
  }
  return fallback;
}

export function shouldBlockOnImpact(
  report: AnalysisReport,
  blockOn: BlockOn,
): boolean {
  switch (blockOn) {
    case 'none':
      return false;
    case 'high':
      return report.highImpactCount > 0;
    case 'medium':
      return report.highImpactCount + report.mediumImpactCount > 0;
    case 'low':
      return report.findings.length > 0;
  }
}

export function mergeConfig(partial: PartialConfig): TelemetryConfig {
  const rules: Record<RuleId, RuleConfig> = {
    'metric-cardinality': mergeRule(
      DEFAULT_CONFIG.rules['metric-cardinality'],
      partial.rules?.['metric-cardinality'],
    ),
    'queue-consumers': mergeRule(
      DEFAULT_CONFIG.rules['queue-consumers'],
      partial.rules?.['queue-consumers'],
    ),
    'error-swallowing': mergeRule(
      DEFAULT_CONFIG.rules['error-swallowing'],
      partial.rules?.['error-swallowing'],
    ),
    'http-handlers': mergeRule(
      DEFAULT_CONFIG.rules['http-handlers'],
      partial.rules?.['http-handlers'],
    ),
    'otel-naming': mergeRule(
      DEFAULT_CONFIG.rules['otel-naming'],
      partial.rules?.['otel-naming'],
    ),
  };

  return {
    version: 1,
    blockOn: resolveBlockOn(partial.blockOn, partial.mode, DEFAULT_CONFIG.blockOn),
    include: partial.include ?? DEFAULT_CONFIG.include,
    exclude: partial.exclude ?? DEFAULT_CONFIG.exclude,
    telemetry: {
      spans: partial.telemetry?.spans ?? DEFAULT_CONFIG.telemetry.spans,
      spanErrors:
        partial.telemetry?.spanErrors ?? DEFAULT_CONFIG.telemetry.spanErrors,
      metrics: partial.telemetry?.metrics ?? DEFAULT_CONFIG.telemetry.metrics,
      logs: partial.telemetry?.logs ?? DEFAULT_CONFIG.telemetry.logs,
    },
    rules,
  };
}

export function loadConfig(
  cwd: string,
  configPath = '.telemetry-prs.yml',
): TelemetryConfig {
  const resolved = path.isAbsolute(configPath)
    ? configPath
    : path.join(cwd, configPath);

  if (!fs.existsSync(resolved)) {
    return mergeConfig({});
  }

  const raw = fs.readFileSync(resolved, 'utf8');
  const parsed = (YAML.parse(raw) ?? {}) as PartialConfig;

  if (parsed.version !== undefined && parsed.version !== 1) {
    throw new Error(
      `Unsupported .telemetry-prs.yml version: ${String(parsed.version)} (expected 1)`,
    );
  }

  if (
    parsed.blockOn !== undefined &&
    !VALID_BLOCK_ON.has(parsed.blockOn)
  ) {
    throw new Error(
      `Invalid blockOn "${String(parsed.blockOn)}" in ${configPath} (expected "none", "high", "medium", or "low")`,
    );
  }

  if (
    parsed.mode !== undefined &&
    parsed.mode !== 'comment' &&
    parsed.mode !== 'fail'
  ) {
    throw new Error(
      `Invalid mode "${String(parsed.mode)}" in ${configPath} (expected "comment" or "fail")`,
    );
  }

  if (parsed.rules) {
    for (const [ruleId, ruleCfg] of Object.entries(parsed.rules)) {
      if (ruleCfg?.impact !== undefined && !VALID_IMPACTS.has(ruleCfg.impact)) {
        throw new Error(
          `Invalid impact "${String(ruleCfg.impact)}" for rule "${ruleId}" in ${configPath} (expected "high", "medium", or "low")`,
        );
      }
    }
  }

  return mergeConfig(parsed);
}
