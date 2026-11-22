import path from 'node:path';
import ts from 'typescript';
import type { CodeUnit, SpanNameIssue, TelemetryPatterns } from '../types.ts';
import {
  blockRethrows,
  detectSignals,
  hasIgnoreDirective,
  isBenignProbeTryCatch,
  isErrorReporterGuardTryCatch,
  isNonMetricReceiver,
} from './signals.ts';

const HTTP_METHODS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'head',
  'all',
]);

const NEXTJS_HTTP_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

const NEST_HTTP_DECORATORS = new Set([
  'Get',
  'Post',
  'Put',
  'Patch',
  'Delete',
  'All',
  'Options',
  'Head',
]);

const WORKER_DIR_RE = /(?:^|\/)(workers?|jobs?|consumers?|queues?)\//i;
const WORKER_PACKAGE_ROOT_RE = /(?:^|\/)workers?\/(?:src|lib|app|utils|helpers)\//i;
const HTTP_ROUTE_DIR_RE = /(?:^|\/)(api|routes?|controllers?)\//i;
const WORKER_NAME_RE = /^(process|consume|handle)[A-Z]\w*(Job|Message|Event|Task|Queue)$/;

const CLOUDFLARE_PAGES_DIR_RE = /(?:^|\/)functions\//i;
const CLOUDFLARE_PAGES_HANDLERS = new Set([
  'onRequest',
  'onRequestGet',
  'onRequestPost',
  'onRequestPut',
  'onRequestPatch',
  'onRequestDelete',
  'onRequestHead',
  'onRequestOptions',
]);

const LAMBDA_DIR_RE = /(?:^|\/)(functions?|lambdas?|handlers?|api)\//i;
const LAMBDA_TYPE_RE = /(Event|APIGateway|SQS|EventBridge|Scheduled)/;
const LAMBDA_QUEUE_TYPE_RE = /(SQSEvent|SQSHandler|EventBridge|Scheduled)/i;
const RESOLVER_FILE_RE = /resolver/i;

const OTEL_SPAN_METHODS = new Set(['startActiveSpan', 'startSpan']);
const GENERIC_SPAN_NAMES = new Set([
  'handler',
  'fn',
  'function',
  'test',
  'span',
  'default',
]);

const OTEL_METRIC_VALUE_ATTR_METHODS = new Set(['add', 'record']);
const PROM_METRIC_ATTR_METHODS = new Set(['inc', 'dec', 'observe', 'set', 'labels']);
const PROM_METRIC_CTORS = new Set(['Counter', 'Histogram', 'Gauge', 'Summary']);

const HIGH_CARDINALITY_LABEL_KEY_RE =
  /^(?:id|uuid|guid|email|useremail|ip|clientip|ipaddress|remoteaddr|url|rawurl|fullurl|token|accesstoken|timestamp|createdat|errormessage|errmessage|stack|stacktrace|(?:user|customer|account|order|request|trace|span|session|correlation|job|invoice|payment|transaction|entity|record|item|member|org|organization|tenant)id)$/i;

const HIGH_CARDINALITY_VALUE_RE =
  /\b(?:req|request)\.(?:url|originalUrl|path)\b|\b(?:err|error)\.(?:message|stack)\b|\bDate\.now\s*\(|\bnew\s+Date\s*\(|\b(?:crypto\.)?randomUUID\s*\(|\buuid(?:v[147])?\s*\(|\bMath\.random\s*\(/;

function normalizeMetricLabelKey(raw: string): string {
  return raw.replace(/[._\-\s]/g, '').toLowerCase();
}

function isHighCardinalityLabelKey(raw: string): boolean {
  return HIGH_CARDINALITY_LABEL_KEY_RE.test(normalizeMetricLabelKey(raw));
}

function inspectMetricAttributesObject(
  sourceFile: ts.SourceFile,
  obj: ts.ObjectLiteralExpression,
): { labels: string[]; values: string[] } {
  const labels = new Set<string>();
  const values = new Set<string>();

  for (const prop of obj.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      const key = prop.name.text;
      if (isHighCardinalityLabelKey(key)) {
        labels.add(key);
      }
      continue;
    }
    if (!ts.isPropertyAssignment(prop)) {
      continue;
    }
    const key = prop.name.getText(sourceFile).replace(/^['"]|['"]$/g, '');
    if (key && isHighCardinalityLabelKey(key)) {
      labels.add(key);
    }
    const valText = prop.initializer.getText(sourceFile);
    if (
      HIGH_CARDINALITY_VALUE_RE.test(valText) ||
      ts.isTemplateExpression(unwrapExpression(prop.initializer))
    ) {
      values.add(valText);
    }
  }

  return {
    labels: Array.from(labels),
    values: Array.from(values),
  };
}

function inspectPromLabelNames(
  sourceFile: ts.SourceFile,
  obj: ts.ObjectLiteralExpression,
): string[] {
  const flagged = new Set<string>();
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      continue;
    }
    const name = prop.name.getText(sourceFile).replace(/^['"]|['"]$/g, '');
    if (name !== 'labelNames') {
      continue;
    }
    const init = unwrapExpression(prop.initializer);
    if (!ts.isArrayLiteralExpression(init)) {
      continue;
    }
    for (const el of init.elements) {
      const label = getStringLiteralText(el);
      if (label && isHighCardinalityLabelKey(label)) {
        flagged.add(label);
      }
    }
  }
  return Array.from(flagged);
}

function getScriptKind(filePath: string): ts.ScriptKind {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function getLineRange(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): { startLine: number; endLine: number; lineCount: number } {
  const start = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  const startLine = start.line + 1;
  const endLine = end.line + 1;
  return {
    startLine,
    endLine,
    lineCount: Math.max(1, endLine - startLine + 1),
  };
}

function countEffectiveBodyLines(
  sourceFile: ts.SourceFile,
  bodyNode: ts.Node,
): number {
  const rawText = bodyNode.getText(sourceFile);
  const withoutBlockComments = rawText.replace(/\/\*[\s\S]*?\*\//g, '');
  let count = 0;
  for (const line of withoutBlockComments.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('//')) {
      continue;
    }
    count += 1;
  }
  return Math.max(1, count);
}

function hasDirectivePrologue(
  sourceFile: ts.SourceFile,
  directive: string,
): boolean {
  const first = sourceFile.statements[0];
  return Boolean(
    first &&
      ts.isExpressionStatement(first) &&
      ts.isStringLiteral(first.expression) &&
      first.expression.text === directive,
  );
}

function isUseClientModule(sourceFile: ts.SourceFile): boolean {
  return hasDirectivePrologue(sourceFile, 'use client');
}

function isUseServerModule(sourceFile: ts.SourceFile): boolean {
  return hasDirectivePrologue(sourceFile, 'use server');
}

function getStringLiteralText(node: ts.Expression | undefined): string | null {
  if (!node) {
    return null;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let curr = expr;
  while (
    ts.isParenthesizedExpression(curr) ||
    ts.isAsExpression(curr) ||
    ts.isSatisfiesExpression(curr)
  ) {
    curr = curr.expression;
  }
  return curr;
}

interface UnwrappedFunction {
  fn: ts.ArrowFunction | ts.FunctionExpression;
  wrapperCalleeText?: string;
}

function unwrapFunctionArg(
  sourceFile: ts.SourceFile,
  rawExpr: ts.Expression,
): UnwrappedFunction | null {
  const expr = unwrapExpression(rawExpr);
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    return { fn: expr };
  }
  if (ts.isCallExpression(expr) && expr.arguments.length > 0) {
    const wrapperCalleeText = `${expr.expression.getText(sourceFile)}(`;
    for (let i = expr.arguments.length - 1; i >= 0; i -= 1) {
      const arg = expr.arguments[i];
      if (!arg) {
        continue;
      }
      const inner = unwrapExpression(arg);
      if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) {
        return { fn: inner, wrapperCalleeText };
      }
    }
  }
  return null;
}

function findEnclosingStatement(node: ts.Node): ts.Node {
  let curr: ts.Node = node;
  while (curr.parent && !ts.isSourceFile(curr.parent)) {
    if (
      ts.isExpressionStatement(curr) ||
      ts.isVariableStatement(curr) ||
      ts.isReturnStatement(curr) ||
      ts.isExportAssignment(curr) ||
      ts.isFunctionDeclaration(curr) ||
      ts.isMethodDeclaration(curr) ||
      ts.isTryStatement(curr)
    ) {
      return curr;
    }
    curr = curr.parent;
  }
  return node;
}

function classifyLambdaHandler(
  sourceFile: ts.SourceFile,
  fn: ts.FunctionLikeDeclaration,
  typeNode: ts.TypeNode | undefined,
  isLambdaDir: boolean,
): { ruleId: 'http-handlers' | 'queue-consumers'; kind: 'http-handler' | 'queue-consumer' } | null {
  const paramTypes = fn.parameters
    .map((p) => (p.type ? p.type.getText(sourceFile) : ''))
    .join(' ');
  const declType = typeNode ? typeNode.getText(sourceFile) : '';
  const combinedTypes = `${paramTypes} ${declType}`.trim();

  if (!isLambdaDir && !LAMBDA_TYPE_RE.test(combinedTypes)) {
    return null;
  }

  if (LAMBDA_QUEUE_TYPE_RE.test(combinedTypes)) {
    return { ruleId: 'queue-consumers', kind: 'queue-consumer' };
  }
  return { ruleId: 'http-handlers', kind: 'http-handler' };
}

function evaluateStaticStringExpr(rawExpr: ts.Expression): string | null {
  const expr = unwrapExpression(rawExpr);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = evaluateStaticStringExpr(expr.left);
    const right = evaluateStaticStringExpr(expr.right);
    if (left !== null && right !== null) {
      return left + right;
    }
  }
  return null;
}

function classifySpanName(
  sourceFile: ts.SourceFile,
  rawArg: ts.Expression,
): { issue?: SpanNameIssue; raw: string } {
  const arg = unwrapExpression(rawArg);
  const raw = arg.getText(sourceFile);

  if (ts.isTemplateExpression(arg)) {
    return { issue: 'high-cardinality', raw };
  }

  if (
    ts.isBinaryExpression(arg) &&
    arg.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const staticVal = evaluateStaticStringExpr(arg);
    if (staticVal === null) {
      return { issue: 'high-cardinality', raw };
    }
    const trimmed = staticVal.trim();
    if (trimmed.length === 0) {
      return { issue: 'empty-name', raw };
    }
    if (GENERIC_SPAN_NAMES.has(trimmed.toLowerCase())) {
      return { issue: 'generic-name', raw };
    }
    return { raw };
  }

  const staticText = evaluateStaticStringExpr(arg);
  if (staticText !== null) {
    const trimmed = staticText.trim();
    if (trimmed.length === 0) {
      return { issue: 'empty-name', raw };
    }
    if (GENERIC_SPAN_NAMES.has(trimmed.toLowerCase())) {
      return { issue: 'generic-name', raw };
    }
  }

  return { raw };
}

function findObjectPropertyFn(
  sourceFile: ts.SourceFile,
  obj: ts.ObjectLiteralExpression,
  propNames: string[],
): { name: string; node: ts.FunctionLikeDeclaration; wrapperCalleeText?: string } | null {
  for (const prop of obj.properties) {
    const propName = prop.name?.getText(sourceFile).replace(/^['"]|['"]$/g, '');
    if (!propName || !propNames.includes(propName)) {
      continue;
    }
    if (ts.isMethodDeclaration(prop)) {
      return { name: propName, node: prop };
    }
    if (ts.isPropertyAssignment(prop)) {
      const unwrapped = unwrapFunctionArg(sourceFile, prop.initializer);
      if (unwrapped) {
        return {
          name: propName,
          node: unwrapped.fn,
          wrapperCalleeText: unwrapped.wrapperCalleeText,
        };
      }
    }
  }
  return null;
}

function hasModifierKind(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  const mods = ts.getModifiers(node);
  return Boolean(mods?.some((m) => m.kind === kind));
}

function hasExportModifier(node: ts.Node): boolean {
  return hasModifierKind(node, ts.SyntaxKind.ExportKeyword);
}

function hasDefaultModifier(node: ts.Node): boolean {
  return hasModifierKind(node, ts.SyntaxKind.DefaultKeyword);
}

function hasAsyncModifier(node: ts.Node): boolean {
  return hasModifierKind(node, ts.SyntaxKind.AsyncKeyword);
}

function getDecorators(node: ts.Node): readonly ts.Decorator[] {
  if (!ts.canHaveDecorators(node)) {
    return [];
  }
  return ts.getDecorators(node) ?? [];
}

export function extractCodeUnits(
  filePath: string,
  sourceText: string,
  patterns: TelemetryPatterns,
): CodeUnit[] {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const sourceFile = ts.createSourceFile(
    normalizedPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(normalizedPath),
  );

  if (isUseClientModule(sourceFile)) {
    return [];
  }

  const units: CodeUnit[] = [];
  const seenNodes = new Set<ts.Node>();

  const registerUnit = (
    unitNode: ts.Node,
    anchorNodes: ts.Node[],
    meta: Omit<
      CodeUnit,
      'startLine' | 'endLine' | 'lineCount' | 'ignored' | 'foundSignals'
    >,
    bodyNode: ts.Node,
    wrapperCalleeText?: string,
  ): void => {
    if (seenNodes.has(unitNode)) {
      return;
    }
    seenNodes.add(unitNode);

    const { startLine, endLine } = getLineRange(sourceFile, unitNode);
    const lineCount = countEffectiveBodyLines(sourceFile, bodyNode);
    const ignored = hasIgnoreDirective(sourceFile, anchorNodes, meta.ruleId);
    const foundSignals = detectSignals(
      sourceFile,
      bodyNode,
      patterns,
      wrapperCalleeText,
    );

    units.push({
      ...meta,
      startLine,
      endLine,
      lineCount,
      ignored,
      foundSignals,
    });
  };

  const isWorkerFile =
    WORKER_DIR_RE.test(normalizedPath) &&
    !WORKER_PACKAGE_ROOT_RE.test(normalizedPath) &&
    !HTTP_ROUTE_DIR_RE.test(normalizedPath);
  const isCloudflarePagesFile = CLOUDFLARE_PAGES_DIR_RE.test(normalizedPath);
  const isNextRouteFile = /(?:^|\/)route\.[jt]sx?$/i.test(normalizedPath);
  const isNextPagesApiFile = /(?:^|\/)pages\/api\/.+\.[jt]s$/i.test(normalizedPath);
  const isServerActionsFile = isUseServerModule(sourceFile);
  const isLambdaDir = LAMBDA_DIR_RE.test(normalizedPath);
  const isResolverFile = RESOLVER_FILE_RE.test(normalizedPath);

  const registerGraphqlObjectResolvers = (
    parentType: 'Query' | 'Mutation',
    obj: ts.ObjectLiteralExpression,
    ownerAnchors: ts.Node[],
  ): void => {
    for (const prop of obj.properties) {
      const fieldName = prop.name?.getText(sourceFile).replace(/^['"]|['"]$/g, '');
      if (!fieldName) {
        continue;
      }

      if (ts.isMethodDeclaration(prop) && prop.body) {
        registerUnit(
          prop,
          [prop, ...ownerAnchors],
          {
            ruleId: 'http-handlers',
            kind: 'http-handler',
            symbolName: `${parentType}.${fieldName}`,
            framework: 'graphql',
          },
          prop.body,
        );
      } else if (ts.isPropertyAssignment(prop)) {
        const unwrapped = unwrapFunctionArg(sourceFile, prop.initializer);
        if (unwrapped) {
          registerUnit(
            unwrapped.fn,
            [unwrapped.fn, prop, ...ownerAnchors],
            {
              ruleId: 'http-handlers',
              kind: 'http-handler',
              symbolName: `${parentType}.${fieldName}`,
              framework: 'graphql',
            },
            unwrapped.fn.body,
            unwrapped.wrapperCalleeText,
          );
          continue;
        }

        const initExpr = unwrapExpression(prop.initializer);
        if (ts.isObjectLiteralExpression(initExpr)) {
          const resolveProp = findObjectPropertyFn(sourceFile, initExpr, [
            'resolve',
          ]);
          if (resolveProp && resolveProp.node.body) {
            registerUnit(
              resolveProp.node,
              [resolveProp.node, prop, ...ownerAnchors],
              {
                ruleId: 'http-handlers',
                kind: 'http-handler',
                symbolName: `${parentType}.${fieldName}`,
                framework: 'graphql',
              },
              resolveProp.node.body,
              resolveProp.wrapperCalleeText,
            );
          }
        }
      }
    }
  };

  const visit = (node: ts.Node): void => {

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text;
      const receiverText = node.expression.expression.getText(sourceFile);
      const args = node.arguments;

      if (HTTP_METHODS.has(methodName) && args.length >= 2) {
        const firstArg = args[0];
        const routeLiteral = getStringLiteralText(firstArg);
        const lastArg = args[args.length - 1];
        const unwrapped = lastArg ? unwrapFunctionArg(sourceFile, lastArg) : null;

        if (unwrapped && (routeLiteral !== null || ts.isRegularExpressionLiteral(firstArg!))) {
          const routeLabel = routeLiteral ?? firstArg!.getText(sourceFile);
          registerUnit(
            unwrapped.fn,
            [unwrapped.fn, node, findEnclosingStatement(node)],
            {
              ruleId: 'http-handlers',
              kind: 'http-handler',
              symbolName: `${methodName.toUpperCase()} ${routeLabel}`,
              framework: 'http-router',
            },
            unwrapped.fn.body,
            unwrapped.wrapperCalleeText,
          );
        }
      }

      if (methodName === 'route' && args.length === 1 && ts.isObjectLiteralExpression(args[0]!)) {
        const obj = args[0]!;
        const handlerProp = findObjectPropertyFn(sourceFile, obj, ['handler']);
        if (handlerProp && handlerProp.node.body) {
          let url = '';
          let routePath = '';
          let hasUrlProp = false;
          let hasPathProp = false;
          let method = 'ROUTE';
          for (const prop of obj.properties) {
            if (ts.isPropertyAssignment(prop)) {
              const name = prop.name.getText(sourceFile).replace(/^['"]|['"]$/g, '');
              const val = getStringLiteralText(prop.initializer);
              if (name === 'url') {
                hasUrlProp = true;
                if (val) url = val;
              }
              if (name === 'path') {
                hasPathProp = true;
                if (val) routePath = val;
              }
              if (name === 'method' && val) method = val.toUpperCase();
            } else if (ts.isShorthandPropertyAssignment(prop)) {
              const name = prop.name.text;
              if (name === 'url') hasUrlProp = true;
              if (name === 'path') hasPathProp = true;
            }
          }
          const isHapi = hasPathProp && !hasUrlProp;
          const routeLabel = url || routePath || (isHapi ? '(hapi route)' : '(fastify route)');
          registerUnit(
            handlerProp.node,
            [handlerProp.node, node, findEnclosingStatement(node)],
            {
              ruleId: 'http-handlers',
              kind: 'http-handler',
              symbolName: `${method} ${routeLabel}`.trim(),
              framework: isHapi ? 'hapi' : 'fastify',
            },
            handlerProp.node.body,
            handlerProp.wrapperCalleeText,
          );
        }
      }

      if (methodName === 'define' && args.length >= 2) {
        const jobName = getStringLiteralText(args[0]);
        const lastArg = args[args.length - 1];
        const unwrapped = lastArg ? unwrapFunctionArg(sourceFile, lastArg) : null;
        if (jobName && unwrapped) {
          registerUnit(
            unwrapped.fn,
            [unwrapped.fn, node, findEnclosingStatement(node)],
            {
              ruleId: 'queue-consumers',
              kind: 'queue-consumer',
              symbolName: `agenda.define(${jobName})`,
              framework: 'agenda',
            },
            unwrapped.fn.body,
            unwrapped.wrapperCalleeText,
          );
        }
      }

      if (methodName === 'process' && args.length >= 1) {
        const lastArg = args[args.length - 1];
        const unwrapped = lastArg ? unwrapFunctionArg(sourceFile, lastArg) : null;
        if (unwrapped) {
          const jobName = getStringLiteralText(args[0]) ?? receiverText;
          registerUnit(
            unwrapped.fn,
            [unwrapped.fn, node, findEnclosingStatement(node)],
            {
              ruleId: 'queue-consumers',
              kind: 'queue-consumer',
              symbolName: `queue.process(${jobName})`,
              framework: 'bull',
            },
            unwrapped.fn.body,
            unwrapped.wrapperCalleeText,
          );
        }
      }

      if (methodName === 'consume' && args.length >= 2) {
        const unwrapped = unwrapFunctionArg(sourceFile, args[1]!);
        if (unwrapped) {
          const queueName = getStringLiteralText(args[0]) ?? 'queue';
          registerUnit(
            unwrapped.fn,
            [unwrapped.fn, node, findEnclosingStatement(node)],
            {
              ruleId: 'queue-consumers',
              kind: 'queue-consumer',
              symbolName: `consume(${queueName})`,
              framework: 'amqp',
            },
            unwrapped.fn.body,
            unwrapped.wrapperCalleeText,
          );
        }
      }

      if (methodName === 'run' && args.length === 1 && ts.isObjectLiteralExpression(args[0]!)) {
        const handlerProp = findObjectPropertyFn(sourceFile, args[0]!, [
          'eachMessage',
          'eachBatch',
        ]);
        if (handlerProp && handlerProp.node.body) {
          registerUnit(
            handlerProp.node,
            [handlerProp.node, node, findEnclosingStatement(node)],
            {
              ruleId: 'queue-consumers',
              kind: 'queue-consumer',
              symbolName: `kafka.${handlerProp.name}`,
              framework: 'kafkajs',
            },
            handlerProp.node.body,
            handlerProp.wrapperCalleeText,
          );
        }
      }

      if (methodName === 'schedule' && args.length >= 2) {
        const unwrapped = unwrapFunctionArg(sourceFile, args[1]!);
        if (unwrapped) {
          const expr = getStringLiteralText(args[0]) ?? 'cron';
          registerUnit(
            unwrapped.fn,
            [unwrapped.fn, node, findEnclosingStatement(node)],
            {
              ruleId: 'queue-consumers',
              kind: 'queue-consumer',
              symbolName: `cron.schedule(${expr})`,
              framework: 'node-cron',
            },
            unwrapped.fn.body,
            unwrapped.wrapperCalleeText,
          );
        }
      }

      if (methodName === 'createFunction' && args.length >= 2) {
        const lastArg = args[args.length - 1];
        const unwrapped = lastArg ? unwrapFunctionArg(sourceFile, lastArg) : null;
        if (unwrapped) {
          registerUnit(
            unwrapped.fn,
            [unwrapped.fn, node, findEnclosingStatement(node)],
            {
              ruleId: 'queue-consumers',
              kind: 'queue-consumer',
              symbolName: `${receiverText}.createFunction`,
              framework: 'inngest',
            },
            unwrapped.fn.body,
            unwrapped.wrapperCalleeText,
          );
        }
      }

      if (methodName === 'create' && args.length === 1 && ts.isObjectLiteralExpression(args[0]!)) {
        const handlerProp = findObjectPropertyFn(sourceFile, args[0]!, [
          'handleMessage',
          'handleMessageBatch',
        ]);
        if (handlerProp && handlerProp.node.body) {
          registerUnit(
            handlerProp.node,
            [handlerProp.node, node, findEnclosingStatement(node)],
            {
              ruleId: 'queue-consumers',
              kind: 'queue-consumer',
              symbolName: `sqs.${handlerProp.name}`,
              framework: 'sqs-consumer',
            },
            handlerProp.node.body,
            handlerProp.wrapperCalleeText,
          );
        }
      }

      if ((methodName === 'query' || methodName === 'mutation') && args.length === 1) {
        const unwrapped = unwrapFunctionArg(sourceFile, args[0]!);
        if (unwrapped) {
          let label = `trpc.${methodName}`;
          const anchors: ts.Node[] = [unwrapped.fn, node];
          if (ts.isPropertyAssignment(node.parent)) {
            const propName = node.parent.name
              .getText(sourceFile)
              .replace(/^['"]|['"]$/g, '');
            if (propName) {
              label = `trpc.${methodName} ${propName}`;
            }
            anchors.push(node.parent);
          } else if (
            ts.isVariableDeclaration(node.parent) &&
            ts.isIdentifier(node.parent.name)
          ) {
            label = `trpc.${methodName} ${node.parent.name.text}`;
            anchors.push(node.parent);
          }
          anchors.push(findEnclosingStatement(node));

          registerUnit(
            unwrapped.fn,
            anchors,
            {
              ruleId: 'http-handlers',
              kind: 'http-handler',
              symbolName: label,
              framework: 'trpc',
            },
            unwrapped.fn.body,
            unwrapped.wrapperCalleeText,
          );
        }
      }
    }

    if (ts.isNewExpression(node) && node.arguments && node.arguments.length >= 2) {
      const ctorName = node.expression.getText(sourceFile);
      if (ctorName === 'Worker' || ctorName.endsWith('.Worker')) {
        const unwrapped = unwrapFunctionArg(sourceFile, node.arguments[1]!);
        if (unwrapped) {
          const queueName = getStringLiteralText(node.arguments[0]) ?? 'worker';
          registerUnit(
            unwrapped.fn,
            [unwrapped.fn, node, findEnclosingStatement(node)],
            {
              ruleId: 'queue-consumers',
              kind: 'queue-consumer',
              symbolName: `Worker(${queueName})`,
              framework: 'bullmq',
            },
            unwrapped.fn.body,
            unwrapped.wrapperCalleeText,
          );
        }
      } else if (ctorName === 'CronJob' || ctorName.endsWith('.CronJob')) {
        const unwrapped = unwrapFunctionArg(sourceFile, node.arguments[1]!);
        if (unwrapped) {
          const expr = getStringLiteralText(node.arguments[0]) ?? 'cron';
          registerUnit(
            unwrapped.fn,
            [unwrapped.fn, node, findEnclosingStatement(node)],
            {
              ruleId: 'queue-consumers',
              kind: 'queue-consumer',
              symbolName: `CronJob(${expr})`,
              framework: 'cron',
            },
            unwrapped.fn.body,
            unwrapped.wrapperCalleeText,
          );
        }
      }
    }

    if (ts.isFunctionDeclaration(node) && node.body) {
      const fnName = node.name?.text ?? 'default';
      if (hasExportModifier(node) && hasDefaultModifier(node) && isNextPagesApiFile) {
        registerUnit(
          node,
          [node],
          {
            ruleId: 'http-handlers',
            kind: 'http-handler',
            symbolName: `API ${normalizedPath}`,
            framework: 'nextjs-pages',
          },
          node.body,
        );
      } else if (hasExportModifier(node) && NEXTJS_HTTP_METHODS.has(fnName) && isNextRouteFile) {
        registerUnit(
          node,
          [node],
          {
            ruleId: 'http-handlers',
            kind: 'http-handler',
            symbolName: `${fnName} ${normalizedPath}`,
            framework: 'nextjs',
          },
          node.body,
        );
      } else if (
        hasExportModifier(node) &&
        isCloudflarePagesFile &&
        CLOUDFLARE_PAGES_HANDLERS.has(fnName)
      ) {
        registerUnit(
          node,
          [node],
          {
            ruleId: 'http-handlers',
            kind: 'http-handler',
            symbolName: `${fnName} ${normalizedPath}`,
            framework: 'cloudflare-pages',
          },
          node.body,
        );
      } else if (hasExportModifier(node) && isServerActionsFile && hasAsyncModifier(node)) {
        registerUnit(
          node,
          [node],
          {
            ruleId: 'http-handlers',
            kind: 'http-handler',
            symbolName: `action ${fnName}`,
            framework: 'nextjs-server-action',
          },
          node.body,
        );
      } else if (hasExportModifier(node) && fnName === 'handler') {
        const lambdaClass = classifyLambdaHandler(
          sourceFile,
          node,
          undefined,
          isLambdaDir,
        );
        if (lambdaClass) {
          registerUnit(
            node,
            [node],
            {
              ruleId: lambdaClass.ruleId,
              kind: lambdaClass.kind,
              symbolName: 'handler',
              framework: 'aws-lambda',
            },
            node.body,
          );
        } else if (isWorkerFile) {
          registerUnit(
            node,
            [node],
            {
              ruleId: 'queue-consumers',
              kind: 'queue-consumer',
              symbolName: fnName,
              framework: 'worker-function',
            },
            node.body,
          );
        }
      } else if (
        hasExportModifier(node) &&
        (isWorkerFile || WORKER_NAME_RE.test(fnName))
      ) {
        registerUnit(
          node,
          [node],
          {
            ruleId: 'queue-consumers',
            kind: 'queue-consumer',
            symbolName: fnName,
            framework: 'worker-function',
          },
          node.body,
        );
      }
    }

    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) {
          continue;
        }
        const varName = decl.name.text;
        const unwrapped = unwrapFunctionArg(sourceFile, decl.initializer);
        if (!unwrapped) {
          continue;
        }

        if (NEXTJS_HTTP_METHODS.has(varName) && isNextRouteFile) {
          registerUnit(
            unwrapped.fn,
            [unwrapped.fn, decl, node],
            {
              ruleId: 'http-handlers',
              kind: 'http-handler',
              symbolName: `${varName} ${normalizedPath}`,
              framework: 'nextjs',
            },
            unwrapped.fn.body,
            unwrapped.wrapperCalleeText,
          );
        } else if (isCloudflarePagesFile && CLOUDFLARE_PAGES_HANDLERS.has(varName)) {
          registerUnit(
            unwrapped.fn,
            [unwrapped.fn, decl, node],
            {
              ruleId: 'http-handlers',
              kind: 'http-handler',
              symbolName: `${varName} ${normalizedPath}`,
              framework: 'cloudflare-pages',
            },
            unwrapped.fn.body,
            unwrapped.wrapperCalleeText,
          );
        } else if (isServerActionsFile && hasAsyncModifier(unwrapped.fn)) {
          registerUnit(
            unwrapped.fn,
            [unwrapped.fn, decl, node],
            {
              ruleId: 'http-handlers',
              kind: 'http-handler',
              symbolName: `action ${varName}`,
              framework: 'nextjs-server-action',
            },
            unwrapped.fn.body,
            unwrapped.wrapperCalleeText,
          );
        } else if (varName === 'handler') {
          const lambdaClass = classifyLambdaHandler(
            sourceFile,
            unwrapped.fn,
            decl.type,
            isLambdaDir,
          );
          if (lambdaClass) {
            registerUnit(
              unwrapped.fn,
              [unwrapped.fn, decl, node],
              {
                ruleId: lambdaClass.ruleId,
                kind: lambdaClass.kind,
                symbolName: 'handler',
                framework: 'aws-lambda',
              },
              unwrapped.fn.body,
              unwrapped.wrapperCalleeText,
            );
          } else if (isWorkerFile) {
            registerUnit(
              unwrapped.fn,
              [unwrapped.fn, decl, node],
              {
                ruleId: 'queue-consumers',
                kind: 'queue-consumer',
                symbolName: varName,
                framework: 'worker-function',
              },
              unwrapped.fn.body,
              unwrapped.wrapperCalleeText,
            );
          }
        } else if (isWorkerFile || WORKER_NAME_RE.test(varName)) {
          registerUnit(
            unwrapped.fn,
            [unwrapped.fn, decl, node],
            {
              ruleId: 'queue-consumers',
              kind: 'queue-consumer',
              symbolName: varName,
              framework: 'worker-function',
            },
            unwrapped.fn.body,
            unwrapped.wrapperCalleeText,
          );
        }
      }
    }

    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const exported = unwrapExpression(node.expression);
      if (isNextPagesApiFile) {
        const unwrapped = unwrapFunctionArg(sourceFile, node.expression);
        if (unwrapped) {
          registerUnit(
            unwrapped.fn,
            [unwrapped.fn, node],
            {
              ruleId: 'http-handlers',
              kind: 'http-handler',
              symbolName: `API ${normalizedPath}`,
              framework: 'nextjs-pages',
            },
            unwrapped.fn.body,
            unwrapped.wrapperCalleeText,
          );
        }
      }
      if (ts.isObjectLiteralExpression(exported)) {
        for (const prop of exported.properties) {
          const propName = prop.name
            ?.getText(sourceFile)
            .replace(/^['"]|['"]$/g, '');
          if (
            propName !== 'fetch' &&
            propName !== 'queue' &&
            propName !== 'scheduled'
          ) {
            continue;
          }

          let fnNode: ts.FunctionLikeDeclaration | null = null;
          let wrapperCalleeText: string | undefined;
          if (ts.isMethodDeclaration(prop) && prop.body) {
            fnNode = prop;
          } else if (ts.isPropertyAssignment(prop)) {
            const unwrapped = unwrapFunctionArg(sourceFile, prop.initializer);
            if (unwrapped) {
              fnNode = unwrapped.fn;
              wrapperCalleeText = unwrapped.wrapperCalleeText;
            }
          }

          if (fnNode && fnNode.body) {
            const isHttp = propName === 'fetch';
            registerUnit(
              fnNode,
              [fnNode, prop, node],
              {
                ruleId: isHttp ? 'http-handlers' : 'queue-consumers',
                kind: isHttp ? 'http-handler' : 'queue-consumer',
                symbolName: `cloudflare.${propName}`,
                framework: 'cloudflare-workers',
              },
              fnNode.body,
              wrapperCalleeText,
            );
          }
        }
      }
    }

    if (isResolverFile) {
      if (ts.isPropertyAssignment(node)) {
        const propName = node.name
          .getText(sourceFile)
          .replace(/^['"]|['"]$/g, '');
        if (propName === 'Query' || propName === 'Mutation') {
          const init = unwrapExpression(node.initializer);
          if (ts.isObjectLiteralExpression(init)) {
            registerGraphqlObjectResolvers(propName, init, [
              node,
              findEnclosingStatement(node),
            ]);
          }
        }
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        (node.name.text === 'Query' || node.name.text === 'Mutation') &&
        node.initializer
      ) {
        const init = unwrapExpression(node.initializer);
        if (ts.isObjectLiteralExpression(init)) {
          registerGraphqlObjectResolvers(node.name.text, init, [
            node,
            findEnclosingStatement(node),
          ]);
        }
      }
    }

    if (ts.isMethodDeclaration(node) && node.body) {
      const decorators = getDecorators(node);
      for (const dec of decorators) {
        const expr = dec.expression;
        const decName = ts.isCallExpression(expr)
          ? expr.expression.getText(sourceFile)
          : expr.getText(sourceFile);
        if (NEST_HTTP_DECORATORS.has(decName)) {
          const methodLabel = node.name.getText(sourceFile);
          registerUnit(
            node,
            [node],
            {
              ruleId: 'http-handlers',
              kind: 'http-handler',
              symbolName: `@${decName} ${methodLabel}`,
              framework: 'nestjs',
            },
            node.body,
          );
          break;
        }
      }
    }

    if (ts.isCatchClause(node)) {
      const catchVarName = node.variableDeclaration?.name.getText(sourceFile);
      const parentTry = ts.isTryStatement(node.parent) ? node.parent : null;
      const catchEffectiveLines = countEffectiveBodyLines(
        sourceFile,
        node.block,
      );
      const isBenignProbe =
        parentTry !== null &&
        (isBenignProbeTryCatch(sourceFile, parentTry, catchEffectiveLines) ||
          isErrorReporterGuardTryCatch(sourceFile, parentTry, node.block));
      const rethrows =
        isBenignProbe || blockRethrows(sourceFile, node.block, catchVarName);
      const anchorNodes = parentTry ? [node, parentTry] : [node];
      const { startLine, endLine } = getLineRange(sourceFile, node);
      const ignored = hasIgnoreDirective(
        sourceFile,
        anchorNodes,
        'error-swallowing',
      );
      const foundSignals = detectSignals(sourceFile, node.block, patterns);

      units.push({
        ruleId: 'error-swallowing',
        kind: 'catch-block',
        symbolName: `catch (${catchVarName ?? ''})`,
        framework: 'typescript',
        startLine,
        endLine,
        lineCount: catchEffectiveLines,
        ignored,
        foundSignals,
        rethrows,
      });
    }

    if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const calleeName = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ts.isIdentifier(node.expression)
          ? node.expression.text
          : null;

      if (calleeName && OTEL_SPAN_METHODS.has(calleeName)) {
        const nameArg = node.arguments[0]!;
        const { issue, raw } = classifySpanName(sourceFile, nameArg);
        const startPos = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        const endPos = sourceFile.getLineAndCharacterOfPosition(
          nameArg.getEnd(),
        );
        const startLine = startPos.line + 1;
        const endLine = endPos.line + 1;
        const anchorNodes = [node, nameArg, findEnclosingStatement(node)];
        const ignored = hasIgnoreDirective(
          sourceFile,
          anchorNodes,
          'otel-naming',
        );

        units.push({
          ruleId: 'otel-naming',
          kind: 'span-name',
          symbolName: `${calleeName}(${raw})`,
          framework: 'opentelemetry',
          startLine,
          endLine,
          lineCount: Math.max(1, endLine - startLine + 1),
          ignored,
          foundSignals: [],
          spanNameIssue: issue,
          spanNameRaw: raw,
        });
      }

      if (ts.isPropertyAccessExpression(node.expression)) {
        const methodName = node.expression.name.text;
        const receiverText = node.expression.expression.getText(sourceFile);

        if (!isNonMetricReceiver(receiverText)) {
          let attrObj: ts.ObjectLiteralExpression | null = null;
          let framework = 'opentelemetry';

          if (
            OTEL_METRIC_VALUE_ATTR_METHODS.has(methodName) &&
            node.arguments.length >= 2 &&
            getStringLiteralText(node.arguments[0]) === null
          ) {
            const candidate = unwrapExpression(node.arguments[1]!);
            if (ts.isObjectLiteralExpression(candidate)) {
              attrObj = candidate;
              framework = 'opentelemetry';
            }
          } else if (
            PROM_METRIC_ATTR_METHODS.has(methodName) &&
            node.arguments.length >= 1
          ) {
            const candidate = unwrapExpression(node.arguments[0]!);
            if (ts.isObjectLiteralExpression(candidate)) {
              attrObj = candidate;
              framework = 'prom-client';
            }
          }

          if (attrObj) {
            const { labels, values } = inspectMetricAttributesObject(
              sourceFile,
              attrObj,
            );
            if (labels.length > 0 || values.length > 0) {
              const { startLine, endLine } = getLineRange(sourceFile, node);
              const anchorNodes = [node, attrObj, findEnclosingStatement(node)];
              const ignored = hasIgnoreDirective(
                sourceFile,
                anchorNodes,
                'metric-cardinality',
              );
              units.push({
                ruleId: 'metric-cardinality',
                kind: 'metric-cardinality',
                symbolName: `${receiverText}.${methodName}`,
                framework,
                startLine,
                endLine,
                lineCount: Math.max(1, endLine - startLine + 1),
                ignored,
                foundSignals: [],
                cardinalityLabels: labels,
                cardinalityValues: values,
              });
            }
          }
        }
      }
    }

    if (ts.isNewExpression(node) && node.arguments && node.arguments.length === 1) {
      const ctorName = node.expression.getText(sourceFile);
      const shortCtor = ctorName.split('.').pop() ?? ctorName;
      if (PROM_METRIC_CTORS.has(shortCtor)) {
        const configArg = unwrapExpression(node.arguments[0]!);
        if (ts.isObjectLiteralExpression(configArg)) {
          const flaggedLabels = inspectPromLabelNames(sourceFile, configArg);
          if (flaggedLabels.length > 0) {
            const { startLine, endLine } = getLineRange(sourceFile, node);
            const anchorNodes = [node, configArg, findEnclosingStatement(node)];
            const ignored = hasIgnoreDirective(
              sourceFile,
              anchorNodes,
              'metric-cardinality',
            );
            units.push({
              ruleId: 'metric-cardinality',
              kind: 'metric-cardinality',
              symbolName: `new ${shortCtor}`,
              framework: 'prom-client',
              startLine,
              endLine,
              lineCount: Math.max(1, endLine - startLine + 1),
              ignored,
              foundSignals: [],
              cardinalityLabels: flaggedLabels,
              cardinalityValues: [],
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return units;
}
