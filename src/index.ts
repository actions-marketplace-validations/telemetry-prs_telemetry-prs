import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { analyzeDiffFiles } from './analyzer/index.ts';
import {
  loadConfig,
  resolveBlockOn,
  shouldBlockOnImpact,
} from './config.ts';
import { parsePatchAddedLines, parseUnifiedDiff } from './diff.ts';
import {
  formatPrComment,
  type FormatPrCommentOptions,
  REPORT_MARKER,
} from './reporter/markdown.ts';
import { formatSarifReport } from './reporter/sarif.ts';
import type { DiffFile } from './types.ts';

async function getPrDiffFiles(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<DiffFile[]> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  const diffFiles: DiffFile[] = [];
  for (const file of files) {
    if (file.status === 'removed' || !file.patch) {
      continue;
    }
    const addedLines = parsePatchAddedLines(file.patch);
    if (addedLines.size > 0) {
      diffFiles.push({
        filePath: file.filename.replace(/\\/g, '/'),
        addedLines,
      });
    }
  }
  return diffFiles;
}

function isGitHubPermissionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const maybeStatus = (error as { status?: unknown }).status;
  if (maybeStatus === 403) {
    return true;
  }
  const message =
    error instanceof Error
      ? error.message
      : String((error as { message?: unknown }).message ?? '');
  return /resource not accessible by integration|forbidden/i.test(message);
}

function getLocalGitDiffFiles(cwd: string): DiffFile[] {
  const attempts: string[][] = [
    ['diff', '-U0', 'HEAD~1...HEAD'],
    ['diff', '-U0', 'HEAD'],
  ];
  for (const args of attempts) {
    try {
      const diffOutput = execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return parseUnifiedDiff(diffOutput);
    } catch {
      continue;
    }
  }
  core.warning(
    'Unable to read local git diff (shallow clone or single commit). Pass github-token on pull_request events or set fetch-depth: 2.',
  );
  return [];
}

async function upsertPrComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  pullNumber: number,
  body: string,
  hasFindings: boolean,
): Promise<void> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100,
  });

  const existing = comments.find((c) => c.body?.includes(REPORT_MARKER));

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
    return;
  }

  if (!hasFindings) {
    return;
  }

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body,
  });
}

function getPrLinkOptions(): FormatPrCommentOptions {
  const pr = github.context.payload.pull_request as
    | { head?: { sha?: string } }
    | undefined;
  const headSha = pr?.head?.sha || github.context.sha || undefined;
  if (!headSha || !process.env.GITHUB_REPOSITORY) {
    return {};
  }

  const serverUrl = (
    github.context.serverUrl ||
    process.env.GITHUB_SERVER_URL ||
    'https://github.com'
  ).replace(/\/+$/, '');
  const { owner, repo } = github.context.repo;
  return {
    repoUrl: `${serverUrl}/${owner}/${repo}`,
    headSha,
  };
}

async function run(): Promise<void> {
  try {
    const cwd = process.cwd();
    const configPath = core.getInput('config') || '.telemetry-prs.yml';
    const blockOnInput = core.getInput('block-on');
    const modeOverride = core.getInput('mode');
    const token = core.getInput('github-token');
    const commentOnPr = core.getInput('comment-on-pr') !== 'false';
    const annotate = core.getInput('annotate') === 'true';
    const sarifFile = core.getInput('sarif-file');

    const config = loadConfig(cwd, configPath);
    config.blockOn = resolveBlockOn(
      blockOnInput || undefined,
      modeOverride || undefined,
      config.blockOn,
    );

    const pr = github.context.payload.pull_request;
    let diffFiles: DiffFile[];

    if (pr && token) {
      const octokit = github.getOctokit(token);
      diffFiles = await getPrDiffFiles(
        octokit,
        github.context.repo.owner,
        github.context.repo.repo,
        pr.number,
      );
    } else {
      diffFiles = getLocalGitDiffFiles(cwd);
    }

    const report = analyzeDiffFiles(cwd, diffFiles, config);

    core.setOutput('findings-count', String(report.findings.length));
    core.setOutput('high-impact-count', String(report.highImpactCount));
    core.setOutput('medium-impact-count', String(report.mediumImpactCount));
    core.setOutput('low-impact-count', String(report.lowImpactCount));
    core.setOutput('coverage-percent', String(report.coveragePercent));

    if (sarifFile) {
      const resolvedSarif = path.resolve(cwd, sarifFile);
      fs.mkdirSync(path.dirname(resolvedSarif), { recursive: true });
      fs.writeFileSync(resolvedSarif, formatSarifReport(report), 'utf8');
    }

    if (annotate) {
      for (const f of report.findings) {
        const props = {
          title: `Telemetry PRs (${f.ruleId} · ${f.impact} impact)`,
          file: f.filePath,
          startLine: f.line,
          endLine: f.endLine,
        };
        const msg = `${f.message} ${f.suggestion}`;
        if (f.impact === 'high') {
          core.error(msg, props);
        } else if (f.impact === 'medium') {
          core.warning(msg, props);
        } else {
          core.notice(msg, props);
        }
      }
    }

    const markdown = formatPrComment(report, getPrLinkOptions());
    await core.summary.addRaw(markdown).write();

    if (pr && token && commentOnPr) {
      const octokit = github.getOctokit(token);
      try {
        await upsertPrComment(
          octokit,
          github.context.repo.owner,
          github.context.repo.repo,
          pr.number,
          markdown,
          report.findings.length > 0,
        );
      } catch (commentError) {
        if (isGitHubPermissionError(commentError)) {
          core.warning(
            'Skipped PR comment because GITHUB_TOKEN lacks pull-requests: write permission (common on fork PRs). Results were still written to the Job Summary and annotations.',
          );
        } else {
          throw commentError;
        }
      }
    }

    if (shouldBlockOnImpact(report, config.blockOn)) {
      core.setFailed(
        `Telemetry PRs blocked on ${config.blockOn}-impact threshold (${report.highImpactCount} high, ${report.mediumImpactCount} medium, ${report.lowImpactCount} low impact).`,
      );
    }
  } catch (error) {
    core.setFailed(
      error instanceof Error ? error.message : `Unexpected error: ${String(error)}`,
    );
  }
}

void run();
