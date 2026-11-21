import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeTargets } from '../src/analyzer/index.ts';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.ts';
import { runInit } from '../src/init.ts';
import { buildSarifReport } from '../src/reporter/sarif.ts';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('buildSarifReport emits valid SARIF 2.1.0 with rules and locations', () => {
  const code = `
new Worker('emails', async (job) => {
  const payload = parseJob(job);
  await sendMail(payload);
});
`;
  const report = analyzeTargets(
    [{ filePath: 'src/workers/emails.ts', content: code }],
    DEFAULT_CONFIG,
  );
  const sarif = buildSarifReport(report);

  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs.length, 1);
  assert.equal(sarif.runs[0]?.tool.driver.rules.length, 4);
  assert.equal(sarif.runs[0]?.results.length, 1);
  assert.equal(sarif.runs[0]?.results[0]?.ruleId, 'queue-consumers');
  assert.equal(sarif.runs[0]?.results[0]?.level, 'error');
  assert.equal(
    sarif.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri,
    'src/workers/emails.ts',
  );
});

test('loadConfig merges YAML overrides and rejects invalid version or mode', () => {
  const dir = makeTempDir('telemetry-prs-cfg-');
  try {
    fs.writeFileSync(
      path.join(dir, '.telemetry-prs.yml'),
      'version: 1\nmode: fail\nrules:\n  http-handlers:\n    severity: error\n',
      'utf8',
    );
    const loaded = loadConfig(dir);
    assert.equal(loaded.mode, 'fail');
    assert.equal(loaded.rules['http-handlers'].severity, 'error');
    assert.equal(loaded.rules['queue-consumers'].severity, 'error');

    fs.writeFileSync(path.join(dir, 'bad-ver.yml'), 'version: 2\n', 'utf8');
    assert.throws(() => loadConfig(dir, 'bad-ver.yml'), /Unsupported/);

    fs.writeFileSync(path.join(dir, 'bad-mode.yml'), 'mode: strict\n', 'utf8');
    assert.throws(() => loadConfig(dir, 'bad-mode.yml'), /Invalid mode/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runInit detects packages and source dirs and writes config and workflow', () => {
  const dir = makeTempDir('telemetry-prs-init-');
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        dependencies: {
          pino: '^9.0.0',
          'prom-client': '^15.0.0',
          'dd-trace': '^5.0.0',
        },
      }),
      'utf8',
    );

    const first = runInit({ cwd: dir, workflow: true });
    assert.equal(first.configWritten, true);
    assert.equal(first.workflowWritten, true);
    assert.deepEqual(first.detectedDirs, ['src', 'app']);
    assert.ok(first.detectedPackages.includes('pino'));
    assert.ok(first.detectedPackages.includes('prom-client'));
    assert.ok(first.detectedPackages.includes('dd-trace'));

    const loaded = loadConfig(dir);
    assert.ok(loaded.telemetry.spans.includes('tracer.trace('));
    assert.ok(loaded.include.includes('src/**/*.{ts,js,mts,cts,mjs,cjs}'));
    assert.ok(fs.existsSync(path.join(dir, '.github', 'workflows', 'telemetry-prs.yml')));

    const second = runInit({ cwd: dir, workflow: true });
    assert.equal(second.configWritten, false);
    assert.equal(second.workflowWritten, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI check runs end-to-end on a git diff and respects --mode fail and --format sarif', () => {
  const dir = makeTempDir('telemetry-prs-git-');
  const cliPath = path.resolve(process.cwd(), 'src', 'cli.ts');
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });

    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'legacy.ts'),
      `router.post('/legacy', async (req, res) => {\n  const a = 1;\n  const b = 2;\n  res.json({ a, b });\n});\n`,
      'utf8',
    );
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: dir, stdio: 'ignore' });

    fs.writeFileSync(
      path.join(dir, 'src', 'worker.ts'),
      `new Worker('payouts', async (job) => {\n  const data = job.data;\n  await runPayout(data);\n});\n`,
      'utf8',
    );
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'add uninstrumented worker'], { cwd: dir, stdio: 'ignore' });

    const sarifRun = spawnSync(
      process.execPath,
      [cliPath, 'check', '--base', 'HEAD~1', '--format', 'sarif'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(sarifRun.status, 0);
    const sarif = JSON.parse(sarifRun.stdout);
    assert.equal(sarif.version, '2.1.0');
    assert.equal(sarif.runs[0].results.length, 1);
    assert.equal(sarif.runs[0].results[0].ruleId, 'queue-consumers');

    const failRun = spawnSync(
      process.execPath,
      [cliPath, 'check', '--base', 'HEAD~1', '--mode', 'fail'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(failRun.status, 1);
    assert.ok(failRun.stdout.includes('Worker(payouts)'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
