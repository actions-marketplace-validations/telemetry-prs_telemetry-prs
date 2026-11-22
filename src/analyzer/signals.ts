import ts from 'typescript';
import type { RuleId, SignalKind, TelemetryPatterns } from '../types.ts';

const IGNORE_RE = /telemetry-prs-ignore(?::\s*([a-z0-9-,\s]+))?/i;

const NON_METRIC_RECEIVER_RE =
  /(?:^|[.\s])(queue|queues|set|map|headers|cookies|session|cache|searchparams|params|res|reply|response|req|request|formdata|classlist|list|items|errors|tags|flags|store|db|redis|client|socket|router|app)$/i;

const NON_METRIC_SUFFIX_RE =
  /(queue|queues|set|map|headers|cookies|session|cache|list|params|store|storage|jar|bucket|state|registry|options|config|ctx|context)$/i;

const AMBIGUOUS_METRIC_METHODS = new Set(['.add(', '.set(']);

const BARE_ERROR_FORWARD_CALLEES = new Set([
  'next',
  'done',
  'cb',
  'callback',
  'reject',
]);

const METHOD_ERROR_FORWARD_CALLEES = new Set([
  'errorhandler',
  'handleerror',
  'onerror',
  'onwarning',
  'captureexception',
  'capturemessage',
  'notify',
]);

const ERROR_REPORTER_CALLBACK_RE =
  /\b(on\w*error|errorhandler|handleerror|reporterror)\b/i;

const BENIGN_PROBE_PATTERNS = [
  'JSON.parse(',
  'decodeURIComponent(',
  'decodeURI(',
  'new URL(',
  'statSync(',
  'lstatSync(',
  'accessSync(',
  'existsSync(',
  'readFileSync(',
  'require.resolve(',
  'sessionStorage.',
  'localStorage.',
  '.json(',
  'atob(',
  'btoa(',
];

export function hasIgnoreDirective(
  sourceFile: ts.SourceFile,
  nodes: ts.Node[],
  ruleId: RuleId,
): boolean {
  const fullText = sourceFile.getFullText();

  for (const node of nodes) {
    const ranges = [
      ...(ts.getLeadingCommentRanges(fullText, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(fullText, node.getEnd()) ?? []),
    ];

    for (const range of ranges) {
      const commentText = fullText.slice(range.pos, range.end);
      const match = IGNORE_RE.exec(commentText);
      if (!match) {
        continue;
      }
      const ruleList = match[1]?.trim();
      if (!ruleList) {
        return true;
      }
      const rules = ruleList
        .split(/[,\s]+/)
        .map((r) => r.trim().toLowerCase())
        .filter(Boolean);
      if (rules.includes(ruleId)) {
        return true;
      }
    }
  }

  return false;
}

function matchesAnyPattern(
  text: string,
  patterns: string[],
  caseInsensitive = false,
): boolean {
  const haystack = caseInsensitive ? text.toLowerCase() : text;
  for (const pattern of patterns) {
    if (pattern.length === 0) {
      continue;
    }
    const needle = caseInsensitive ? pattern.toLowerCase() : pattern;
    if (haystack.includes(needle)) {
      return true;
    }
  }
  return false;
}

export function isNonMetricReceiver(receiverText: string): boolean {
  const cleaned = receiverText.replace(/\?\.|!/g, '.').trim();
  const lastSegment = cleaned.split('.').pop() ?? cleaned;
  return (
    NON_METRIC_RECEIVER_RE.test(cleaned) ||
    NON_METRIC_SUFFIX_RE.test(lastSegment)
  );
}

function matchesMetricPattern(
  callText: string,
  receiverText: string | null,
  patterns: string[],
): boolean {
  for (const pattern of patterns) {
    if (pattern.length === 0 || !callText.includes(pattern)) {
      continue;
    }
    if (
      receiverText !== null &&
      AMBIGUOUS_METRIC_METHODS.has(pattern) &&
      isNonMetricReceiver(receiverText)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

export function detectSignals(
  sourceFile: ts.SourceFile,
  bodyNode: ts.Node,
  patterns: TelemetryPatterns,
  wrapperCalleeText?: string,
): SignalKind[] {
  const found = new Set<SignalKind>();

  const checkText = (text: string, receiverText: string | null): void => {
    if (matchesAnyPattern(text, patterns.spans)) {
      found.add('span');
    }
    if (matchesAnyPattern(text, patterns.spanErrors)) {
      found.add('span-error');
    }
    if (matchesMetricPattern(text, receiverText, patterns.metrics)) {
      found.add('metric');
    }
    if (matchesAnyPattern(text, patterns.logs, true)) {
      found.add('log');
    }
  };

  if (wrapperCalleeText) {
    checkText(wrapperCalleeText, null);
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const exprText = node.expression.getText(sourceFile);
      const receiverText = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.expression.getText(sourceFile)
        : null;
      checkText(`${exprText}(`, receiverText);
    } else if (ts.isDecorator(node)) {
      const decText = node.getText(sourceFile);
      checkText(decText, null);
    }

    ts.forEachChild(node, visit);
  };

  visit(bodyNode);
  return Array.from(found);
}

export function blockRethrows(
  sourceFile: ts.SourceFile,
  block: ts.Block,
  catchVarName?: string,
): boolean {
  let handled = false;

  const visit = (node: ts.Node): void => {
    if (handled) {
      return;
    }
    if (ts.isThrowStatement(node)) {
      handled = true;
      return;
    }
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      return;
    }
    if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const callee = node.expression;
      const isBareIdentifier = ts.isIdentifier(callee);
      const calleeName = isBareIdentifier
        ? callee.text.toLowerCase()
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text.toLowerCase()
          : '';

      if (
        (isBareIdentifier && BARE_ERROR_FORWARD_CALLEES.has(calleeName)) ||
        METHOD_ERROR_FORWARD_CALLEES.has(calleeName)
      ) {
        handled = true;
        return;
      }

      if (calleeName === 'emit') {
        const firstArg = node.arguments[0];
        if (
          firstArg &&
          ts.isStringLiteral(firstArg) &&
          firstArg.text.toLowerCase() === 'error'
        ) {
          handled = true;
          return;
        }
      }

      if (calleeName === 'push' && catchVarName) {
        const hasErrArg = node.arguments.some(
          (arg) => arg.getText(sourceFile).includes(catchVarName),
        );
        if (hasErrArg) {
          handled = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(block, visit);
  return handled;
}

export function isBenignProbeTryCatch(
  sourceFile: ts.SourceFile,
  tryStmt: ts.TryStatement,
  catchEffectiveLines: number,
): boolean {
  if (catchEffectiveLines > 4) {
    return false;
  }
  const tryBlockStatements = tryStmt.tryBlock.statements;
  if (tryBlockStatements.length > 3) {
    return false;
  }
  const tryText = tryStmt.tryBlock.getText(sourceFile);
  return BENIGN_PROBE_PATTERNS.some((p) => tryText.includes(p));
}

export function isErrorReporterGuardTryCatch(
  sourceFile: ts.SourceFile,
  tryStmt: ts.TryStatement,
  catchBlock: ts.Block,
): boolean {
  if (catchBlock.statements.length !== 0) {
    return false;
  }
  if (tryStmt.tryBlock.statements.length !== 1) {
    return false;
  }
  const tryText = tryStmt.tryBlock.getText(sourceFile);
  return ERROR_REPORTER_CALLBACK_RE.test(tryText);
}
