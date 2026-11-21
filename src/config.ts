import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type {
  CheckMode,
  RuleConfig,
  RuleId,
  TelemetryConfig,
  TelemetryPatterns,
} from './types.ts';

export const DEFAULT_CONFIG: TelemetryConfig = {
  version: 1,
  mode: 'comment',
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
    'http-handlers': {
      enabled: true,
      severity: 'warning',
      require: ['span', 'metric'],
      matchMode: 'any',
      minLines: 4,
      description:
        'HTTP route handlers should emit a custom span or business metric',
    },
    'queue-consumers': {
      enabled: true,
      severity: 'error',
      require: ['span', 'metric'],
      matchMode: 'any',
      minLines: 3,
      description:
        'Background jobs and queue consumers run off-request and must be instrumented',
    },
    'error-swallowing': {
      enabled: true,
      severity: 'warning',
      require: ['span-error', 'log', 'metric'],
      matchMode: 'any',
      minLines: 1,
      description:
        'Catch blocks that do not rethrow should record an exception, log, or increment an error metric',
    },
    'otel-naming': {
      enabled: true,
      severity: 'warning',
      require: [],
      matchMode: 'any',
      minLines: 1,
      description:
        'OpenTelemetry span names should be static, low-cardinality, and descriptive',
    },
  },
};

interface PartialConfig {
  version?: number;
  mode?: CheckMode;
  include?: string[];
  exclude?: string[];
  telemetry?: Partial<TelemetryPatterns>;
  rules?: Partial<Record<RuleId, Partial<RuleConfig>>>;
}

export function mergeConfig(partial: PartialConfig): TelemetryConfig {
  const rules: Record<RuleId, RuleConfig> = {
    'http-handlers': {
      ...DEFAULT_CONFIG.rules['http-handlers'],
      ...(partial.rules?.['http-handlers'] ?? {}),
    },
    'queue-consumers': {
      ...DEFAULT_CONFIG.rules['queue-consumers'],
      ...(partial.rules?.['queue-consumers'] ?? {}),
    },
    'error-swallowing': {
      ...DEFAULT_CONFIG.rules['error-swallowing'],
      ...(partial.rules?.['error-swallowing'] ?? {}),
    },
    'otel-naming': {
      ...DEFAULT_CONFIG.rules['otel-naming'],
      ...(partial.rules?.['otel-naming'] ?? {}),
    },
  };

  return {
    version: 1,
    mode: partial.mode ?? DEFAULT_CONFIG.mode,
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
    parsed.mode !== undefined &&
    parsed.mode !== 'comment' &&
    parsed.mode !== 'fail'
  ) {
    throw new Error(
      `Invalid mode "${String(parsed.mode)}" in ${configPath} (expected "comment" or "fail")`,
    );
  }

  return mergeConfig(parsed);
}
