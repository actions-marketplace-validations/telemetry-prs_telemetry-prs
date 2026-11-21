import { execFileSync } from 'node:child_process';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { analyzeDiffFiles } from './analyzer/index.ts';
import { loadConfig } from './config.ts';
import { parsePatchAddedLines, parseUnifiedDiff } from './diff.ts';
import {
  formatPrComment,
  type FormatPrCommentOptions,
  REPORT_MARKER,
} from './reporter/markdown.ts';
import type { CheckMode, DiffFile } from './types.ts';

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

function getLocalGitDiffFiles(cwd: string): DiffFile[] {
  const diffOutput = execFileSync('git', ['diff', '-U0', 'HEAD~1...HEAD'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return parseUnifiedDiff(diffOutput);
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
    const modeOverride = core.getInput('mode') as CheckMode | '';
    const token = core.getInput('github-token');
    const commentOnPr = core.getInput('comment-on-pr') !== 'false';
    const annotate = core.getInput('annotate') !== 'false';

    const config = loadConfig(cwd, configPath);
    if (modeOverride === 'comment' || modeOverride === 'fail') {
      config.mode = modeOverride;
    }

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
    core.setOutput('errors-count', String(report.errorsCount));
    core.setOutput('warnings-count', String(report.warningsCount));

    if (annotate) {
      for (const f of report.findings) {
        const props = {
          title: `Telemetry PRs (${f.ruleId})`,
          file: f.filePath,
          startLine: f.line,
          endLine: f.endLine,
        };
        const msg = `${f.message} ${f.suggestion}`;
        if (f.severity === 'error') {
          core.error(msg, props);
        } else {
          core.warning(msg, props);
        }
      }
    }

    const markdown = formatPrComment(report, getPrLinkOptions());
    await core.summary.addRaw(markdown).write();

    if (pr && token && commentOnPr) {
      const octokit = github.getOctokit(token);
      await upsertPrComment(
        octokit,
        github.context.repo.owner,
        github.context.repo.repo,
        pr.number,
        markdown,
        report.findings.length > 0,
      );
    }

    if (config.mode === 'fail' && report.errorsCount > 0) {
      core.setFailed(
        `Telemetry PRs found ${report.errorsCount} error-severity instrumentation gap(s).`,
      );
    }
  } catch (error) {
    core.setFailed(
      error instanceof Error ? error.message : `Unexpected error: ${String(error)}`,
    );
  }
}

void run();
