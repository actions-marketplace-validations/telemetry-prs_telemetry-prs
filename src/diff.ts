import type { DiffFile } from './types.ts';

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function parsePatchAddedLines(patch: string): Set<number> {
  const added = new Set<number>();
  const lines = patch.split(/\r?\n/);

  let currentNewLine = 0;
  let inHunk = false;

  for (const line of lines) {
    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch) {
      currentNewLine = Number.parseInt(hunkMatch[1] ?? '0', 10);
      inHunk = true;
      continue;
    }

    if (!inHunk) {
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      added.add(currentNewLine);
      currentNewLine += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Deleted line: does not advance new file line counter
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file"
    } else {

      currentNewLine += 1;
    }
  }

  return added;
}

export function parseUnifiedDiff(diffText: string): DiffFile[] {
  const results = new Map<string, Set<number>>();
  const lines = diffText.split(/\r?\n/);

  let currentFile: string | null = null;
  let currentNewLine = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      currentFile = null;
      inHunk = false;
      continue;
    }

    if (line.startsWith('+++ ')) {
      const rawPath = line.slice(4).trim();
      if (rawPath === '/dev/null') {
        currentFile = null;
        continue;
      }
      const normalized = rawPath.startsWith('b/') ? rawPath.slice(2) : rawPath;
      currentFile = normalized.replace(/\\/g, '/');
      if (!results.has(currentFile)) {
        results.set(currentFile, new Set<number>());
      }
      inHunk = false;
      continue;
    }

    if (!currentFile) {
      continue;
    }

    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch) {
      currentNewLine = Number.parseInt(hunkMatch[1] ?? '0', 10);
      inHunk = true;
      continue;
    }

    if (!inHunk) {
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      results.get(currentFile)?.add(currentNewLine);
      currentNewLine += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Deleted line
    } else if (line.startsWith('\\')) {
      // Metadata line
    } else {
      currentNewLine += 1;
    }
  }

  const diffFiles: DiffFile[] = [];
  for (const [filePath, addedLines] of results.entries()) {
    if (addedLines.size > 0) {
      diffFiles.push({ filePath, addedLines });
    }
  }
  return diffFiles;
}

export function rangeTouchesAddedLines(
  startLine: number,
  endLine: number,
  addedLines: Set<number>,
): boolean {
  for (const line of addedLines) {
    if (line >= startLine && line <= endLine) {
      return true;
    }
  }
  return false;
}
