import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { DEFAULT_CONFIG } from './config.ts';

export interface InitOptions {
  cwd: string;
  workflow?: boolean;
  force?: boolean;
}

export interface InitResult {
  configPath: string;
  configWritten: boolean;
  workflowPath?: string;
  workflowWritten: boolean;
  detectedPackages: string[];
  detectedDirs: string[];
}

const KNOWN_SOURCE_DIRS = [
  { dir: 'src', glob: 'src/**/*.{ts,js,mts,cts,mjs,cjs}' },
  { dir: 'app', glob: 'app/**/*.{ts,js}' },
  { dir: 'pages/api', glob: 'pages/api/**/*.{ts,js}' },
  { dir: 'functions', glob: 'functions/**/*.{ts,js}' },
  { dir: 'lambdas', glob: 'lambdas/**/*.{ts,js}' },
];

const PACKAGE_TELEMETRY_HINTS: Record<
  string,
  { spans?: string[]; metrics?: string[]; logs?: string[] }
> = {
  '@opentelemetry/api': {
    spans: ['startActiveSpan', 'startSpan', 'trace.getTracer'],
    metrics: ['.add(', '.record(', 'createCounter', 'createHistogram'],
  },
  'prom-client': {
    metrics: ['.inc(', '.dec(', '.observe(', '.set('],
  },
  'hot-shots': {
    metrics: ['statsd.increment(', 'statsd.histogram(', 'statsd.timing(', 'statsd.gauge('],
  },
  'dd-trace': {
    spans: ['tracer.trace(', 'tracer.wrap(', 'startSpan'],
  },
  pino: {
    logs: ['logger.info', 'logger.warn', 'logger.error', 'logger.fatal', 'req.log.', 'request.log.'],
  },
  winston: {
    logs: ['logger.info', 'logger.warn', 'logger.error', 'winston.error', 'winston.warn'],
  },
  bunyan: {
    logs: ['log.info', 'log.warn', 'log.error', 'log.fatal'],
  },
};

const WORKFLOW_TEMPLATE = `name: Telemetry Check

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  telemetry-prs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: telemetry-prs/telemetry-prs@v0
        with:
          github-token: \${{ secrets.GITHUB_TOKEN }}
`;

function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}

function readPackageDeps(cwd: string): Set<string> {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return new Set();
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
  } catch {
    return new Set();
  }
}

export function runInit(options: InitOptions): InitResult {
  const deps = readPackageDeps(options.cwd);
  const detectedPackages: string[] = [];

  const spans = [...DEFAULT_CONFIG.telemetry.spans];
  const metrics = [...DEFAULT_CONFIG.telemetry.metrics];
  const logs = [...DEFAULT_CONFIG.telemetry.logs];

  for (const [pkgName, hints] of Object.entries(PACKAGE_TELEMETRY_HINTS)) {
    if (!deps.has(pkgName)) {
      continue;
    }
    detectedPackages.push(pkgName);
    if (hints.spans) spans.push(...hints.spans);
    if (hints.metrics) metrics.push(...hints.metrics);
    if (hints.logs) logs.push(...hints.logs);
  }

  const detectedDirs: string[] = [];
  const includeGlobs: string[] = [];
  for (const entry of KNOWN_SOURCE_DIRS) {
    if (fs.existsSync(path.join(options.cwd, entry.dir))) {
      detectedDirs.push(entry.dir);
      includeGlobs.push(entry.glob);
    }
  }

  const configObject = {
    version: 1,
    blockOn: DEFAULT_CONFIG.blockOn,
    include: includeGlobs.length > 0 ? includeGlobs : DEFAULT_CONFIG.include,
    exclude: DEFAULT_CONFIG.exclude,
    telemetry: {
      spans: unique(spans),
      spanErrors: DEFAULT_CONFIG.telemetry.spanErrors,
      metrics: unique(metrics),
      logs: unique(logs),
    },
    rules: {
      'metric-cardinality': {
        enabled: DEFAULT_CONFIG.rules['metric-cardinality'].enabled,
        impact: DEFAULT_CONFIG.rules['metric-cardinality'].impact,
      },
      'queue-consumers': {
        enabled: DEFAULT_CONFIG.rules['queue-consumers'].enabled,
        impact: DEFAULT_CONFIG.rules['queue-consumers'].impact,
        require: DEFAULT_CONFIG.rules['queue-consumers'].require,
        matchMode: DEFAULT_CONFIG.rules['queue-consumers'].matchMode,
        minLines: DEFAULT_CONFIG.rules['queue-consumers'].minLines,
      },
      'error-swallowing': {
        enabled: DEFAULT_CONFIG.rules['error-swallowing'].enabled,
        impact: DEFAULT_CONFIG.rules['error-swallowing'].impact,
        require: DEFAULT_CONFIG.rules['error-swallowing'].require,
        matchMode: DEFAULT_CONFIG.rules['error-swallowing'].matchMode,
        minLines: DEFAULT_CONFIG.rules['error-swallowing'].minLines,
      },
      'http-handlers': {
        enabled: DEFAULT_CONFIG.rules['http-handlers'].enabled,
        impact: DEFAULT_CONFIG.rules['http-handlers'].impact,
        require: DEFAULT_CONFIG.rules['http-handlers'].require,
        matchMode: DEFAULT_CONFIG.rules['http-handlers'].matchMode,
        minLines: DEFAULT_CONFIG.rules['http-handlers'].minLines,
      },
      'otel-naming': {
        enabled: DEFAULT_CONFIG.rules['otel-naming'].enabled,
        impact: DEFAULT_CONFIG.rules['otel-naming'].impact,
      },
    },
  };

  const configPath = path.join(options.cwd, '.telemetry-prs.yml');
  let configWritten = false;
  if (!fs.existsSync(configPath) || options.force) {
    fs.writeFileSync(configPath, YAML.stringify(configObject), 'utf8');
    configWritten = true;
  }

  let workflowPath: string | undefined;
  let workflowWritten = false;
  if (options.workflow) {
    workflowPath = path.join(
      options.cwd,
      '.github',
      'workflows',
      'telemetry-prs.yml',
    );
    if (!fs.existsSync(workflowPath) || options.force) {
      fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
      fs.writeFileSync(workflowPath, WORKFLOW_TEMPLATE, 'utf8');
      workflowWritten = true;
    }
  }

  return {
    configPath,
    configWritten,
    workflowPath,
    workflowWritten,
    detectedPackages,
    detectedDirs,
  };
}
