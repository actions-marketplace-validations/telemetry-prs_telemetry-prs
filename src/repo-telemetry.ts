import fs from 'node:fs';
import path from 'node:path';
import type { RepoTelemetryStatus } from './types.ts';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.yarn',
  'coverage',
  '.wrangler',
]);

const EXACT_SDK_PACKAGES = new Set([
  'dd-trace',
  'newrelic',
  'prom-client',
  'hot-shots',
  'node-statsd',
  'pino',
  'winston',
  'bunyan',
  'roarr',
  'tslog',
  'consola',
  'elastic-apm-node',
  'applicationinsights',
  'aws-xray-sdk',
  'aws-xray-sdk-core',
  '@microlabs/otel-cf-workers',
  '@vercel/otel',
]);

const SDK_PACKAGE_PREFIXES = [
  '@opentelemetry/',
  '@sentry/',
  '@honeycombio/',
  '@aws-lambda-powertools/',
];

const WRANGLER_FILENAMES = ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'];

function isObservabilityPackage(pkgName: string): boolean {
  if (EXACT_SDK_PACKAGES.has(pkgName)) {
    return true;
  }
  return SDK_PACKAGE_PREFIXES.some((prefix) => pkgName.startsWith(prefix));
}

function collectCandidateDirs(rootDir: string): string[] {
  const dirs = [rootDir];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return dirs;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
      continue;
    }
    const childDir = path.join(rootDir, entry.name);
    dirs.push(childDir);

    if (entry.name === 'packages' || entry.name === 'apps' || entry.name === 'services') {
      let subEntries: fs.Dirent[];
      try {
        subEntries = fs.readdirSync(childDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subEntries) {
        if (!sub.isDirectory() || SKIP_DIRS.has(sub.name) || sub.name.startsWith('.')) {
          continue;
        }
        dirs.push(path.join(childDir, sub.name));
      }
    }
  }

  return dirs;
}

function readPackageJsonDeps(pkgPath: string): string[] | null {
  if (!fs.existsSync(pkgPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    return [
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
      ...Object.keys(parsed.peerDependencies ?? {}),
    ];
  } catch {
    return null;
  }
}

function wranglerHasObservabilityEnabled(filePath: string): boolean {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }

  if (filePath.endsWith('.toml')) {
    const sections = content.split(/(?:^|\r?\n)(?=\[)/);
    for (const section of sections) {
      const trimmed = section.trim();
      if (!/^\[observability(?:\.[^\]]+)?\]/i.test(trimmed)) {
        continue;
      }
      if (/^\s*enabled\s*=\s*true\b/im.test(trimmed)) {
        return true;
      }
    }
    return false;
  }

  return /"observability"\s*:\s*\{[\s\S]*?"enabled"\s*:\s*true/i.test(content);
}

export function detectRepoTelemetry(rootDir: string): RepoTelemetryStatus {
  const dirs = collectCandidateDirs(rootDir);
  const detected = new Set<string>();
  let checkedManifests = 0;
  let hasWranglerConfig = false;

  for (const dir of dirs) {
    const deps = readPackageJsonDeps(path.join(dir, 'package.json'));
    if (deps !== null) {
      checkedManifests += 1;
      for (const dep of deps) {
        if (isObservabilityPackage(dep)) {
          detected.add(dep);
        }
      }
    }

    for (const wranglerName of WRANGLER_FILENAMES) {
      const wranglerPath = path.join(dir, wranglerName);
      if (!fs.existsSync(wranglerPath)) {
        continue;
      }
      checkedManifests += 1;
      hasWranglerConfig = true;
      if (wranglerHasObservabilityEnabled(wranglerPath)) {
        detected.add('cloudflare-observability');
      }
    }
  }

  const detectedSdks = Array.from(detected).sort();
  return {
    checkedManifests,
    detectedSdks,
    hasWranglerConfig,
    hasAnySdk: detectedSdks.length > 0,
  };
}
