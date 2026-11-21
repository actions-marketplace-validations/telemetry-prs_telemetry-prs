#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  analyzeDiffFiles,
  analyzeTargets,
  shouldCheckFile,
} from './analyzer/index.ts';
import { loadConfig } from './config.ts';
import { parseUnifiedDiff } from './diff.ts';
import {
  formatPrComment,
  formatTerminalReport,
} from './reporter/markdown.ts';
import type { CheckMode, TelemetryConfig } from './types.ts';

function printUsage(): void {
  console.log(`Usage:
  telemetry-prs check [--base <ref>] [--config <path>] [--mode comment|fail] [--format text|markdown|json]
  telemetry-prs scan <dir-or-file> [--config <path>] [--mode comment|fail] [--format text|markdown|json]

Commands:
  check   Analyze git diff against <ref> (default: HEAD; or staged/working tree)
  scan    Scan all matching TS/JS files in a directory or single file (ignores git diff)
`);
}

function collectFilesRecursive(
  rootDir: string,
  targetPath: string,
  config: TelemetryConfig,
  out: string[],
): void {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    const rel = path.relative(rootDir, targetPath).replace(/\\/g, '/');
    if (shouldCheckFile(rel, config)) {
      out.push(rel);
    }
    return;
  }

  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === '.git' ||
      entry.name === '.yarn' ||
      entry.name === 'dist' ||
      entry.name === 'build'
    ) {
      continue;
    }
    collectFilesRecursive(rootDir, path.join(targetPath, entry.name), config, out);
  }
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) {
    return undefined;
  }
  return args[idx + 1];
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '-h' || command === '--help') {
    printUsage();
    process.exit(0);
  }

  const cwd = process.cwd();
  const configPath = parseFlag(args, '--config') ?? '.telemetry-prs.yml';
  const modeOverride = parseFlag(args, '--mode') as CheckMode | undefined;
  const format = parseFlag(args, '--format') ?? 'text';

  const config = loadConfig(cwd, configPath);
  if (modeOverride === 'comment' || modeOverride === 'fail') {
    config.mode = modeOverride;
  }

  let report;

  if (command === 'check') {
    const baseRef = parseFlag(args, '--base');
    const gitArgs = baseRef
      ? ['diff', '-U0', `${baseRef}...HEAD`]
      : ['diff', '-U0', 'HEAD'];

    const diffText = execFileSync('git', gitArgs, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    const diffFiles = parseUnifiedDiff(diffText);
    report = analyzeDiffFiles(cwd, diffFiles, config);
  } else if (command === 'scan') {
    const targetArg = args[1] && !args[1].startsWith('--') ? args[1] : '.';
    const resolvedTarget = path.resolve(cwd, targetArg);
    const scanRoot = fs.statSync(resolvedTarget).isDirectory()
      ? resolvedTarget
      : path.dirname(resolvedTarget);

    const files: string[] = [];
    collectFilesRecursive(scanRoot, resolvedTarget, config, files);

    const targets = files.map((relPath) => ({
      filePath: relPath,
      content: fs.readFileSync(path.join(scanRoot, relPath), 'utf8'),
    }));
    report = analyzeTargets(targets, config);
  } else {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(2);
  }

  if (format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else if (format === 'markdown') {
    console.log(formatPrComment(report));
  } else {
    console.log(formatTerminalReport(report));
  }

  if (config.mode === 'fail' && report.errorsCount > 0) {
    process.exit(1);
  }
}

main();
