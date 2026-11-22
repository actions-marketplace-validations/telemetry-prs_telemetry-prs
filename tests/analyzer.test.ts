import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeTargets } from '../src/analyzer/index.ts';
import { DEFAULT_CONFIG, mergeConfig } from '../src/config.ts';
import { formatPrComment, REPORT_MARKER } from '../src/reporter/markdown.ts';

test('flags uninstrumented Express route and ignores instrumented or trivial ones', () => {
  const code = `
import express from 'express';
const router = express.Router();

// Trivial 1-line healthcheck (< minLines: 4) -> ignored
router.get('/health', (_req, res) => res.send('ok'));

// Non-route Map.get -> must never be flagged
const cache = new Map<string, string>();
cache.get('user-1');

// Uninstrumented checkout handler -> flagged
router.post('/checkout', async (req, res) => {
  const items = req.body.items;
  const total = items.reduce((sum: number, i: any) => sum + i.price, 0);
  await chargeCard(req.body.customerId, total);
  res.status(201).json({ total });
});

// Instrumented with OpenTelemetry span -> passes
router.post('/refund', async (req, res) => {
  return tracer.startActiveSpan('http.refund', async (span) => {
    span.setAttribute('order.id', req.body.orderId);
    await refundOrder(req.body.orderId);
    span.end();
    res.json({ refunded: true });
  });
});

// Instrumented via higher-order wrapper -> passes
router.delete('/orders/:id', withSpan('http.cancel_order', async (req, res) => {
  await cancelOrder(req.params.id);
  const status = 'cancelled';
  res.json({ status });
}));
`;

  const report = analyzeTargets(
    [{ filePath: 'src/routes/checkout.ts', content: code }],
    DEFAULT_CONFIG,
  );

  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]?.ruleId, 'http-handlers');
  assert.equal(report.findings[0]?.symbolName, 'POST /checkout');
  assert.equal(report.findings[0]?.severity, 'warning');
});

test('flags uninstrumented BullMQ and KafkaJS workers as errors', () => {
  const code = `
import { Worker } from 'bullmq';

new Worker('invoice-pdf', async (job) => {
  const invoice = await loadInvoice(job.data.invoiceId);
  const pdf = await renderPdf(invoice);
  await uploadPdf(pdf);
});

consumer.run({
  eachMessage: async ({ message }) => {
    const payload = JSON.parse(message.value.toString());
    await syncLedger(payload);
  },
});

new Worker('email-send', async (job) => {
  jobsCounter.add(1, { queue: 'email-send' });
  await sendEmail(job.data);
});
`;

  const report = analyzeTargets(
    [{ filePath: 'src/workers/billing.ts', content: code }],
    DEFAULT_CONFIG,
  );

  assert.equal(report.errorsCount, 2);
  assert.deepEqual(
    report.findings.map((f) => f.symbolName),
    ['Worker(invoice-pdf)', 'kafka.eachMessage'],
  );
});

test('flags Next.js App Router handlers and respects diff line scoping', () => {
  const code = `
export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const data = await fetchLegacyThing(id);
  return Response.json(data);
}

export async function POST(request: Request) {
  const body = await request.json();
  const created = await createWidget(body);
  return Response.json(created, { status: 201 });
}
`;

  const report = analyzeTargets(
    [
      {
        filePath: 'app/api/widgets/route.ts',
        content: code,
        addedLines: new Set([9, 10, 11, 12, 13]),
      },
    ],
    DEFAULT_CONFIG,
  );

  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]?.symbolName, 'POST app/api/widgets/route.ts');
});

test('detects error-swallowing catch blocks while allowing rethrow, logging, and span.recordException', () => {
  const code = `
async function runTasks() {
  try {
    await stepOne();
  } catch (err) {
    return null;
  }

  try {
    await stepTwo();
  } catch (err) {
    throw err;
  }

  try {
    await stepThree();
  } catch (err) {
    logger.error({ err }, 'stepThree failed');
    return null;
  }

  try {
    await stepFour();
  } catch (err) {
    span.recordException(err);
    return null;
  }
}
`;

  const report = analyzeTargets(
    [{ filePath: 'src/service.ts', content: code }],
    DEFAULT_CONFIG,
  );

  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]?.ruleId, 'error-swallowing');
  assert.equal(report.findings[0]?.line, 5);
});

test('respects telemetry-prs-ignore directives (global and rule-specific)', () => {
  const code = `
// telemetry-prs-ignore
router.post('/internal-ping', async (req, res) => {
  const a = 1;
  const b = 2;
  const c = a + b;
  res.json({ c });
});

// telemetry-prs-ignore: queue-consumers
new Worker('debug-noop', async (job) => {
  const id = job.id;
  await noop(id);
});
`;

  const report = analyzeTargets(
    [{ filePath: 'src/routes/internal.ts', content: code }],
    DEFAULT_CONFIG,
  );

  assert.equal(report.findings.length, 0);
});

test('supports custom telemetry patterns and matchMode: all', () => {
  const config = mergeConfig({
    telemetry: {
      spans: ['myCompanyTrace('],
      metrics: ['statsd.increment('],
    },
    rules: {
      'http-handlers': {
        require: ['span', 'metric'],
        matchMode: 'all',
      },
    },
  });

  const code = `
router.post('/pay', async (req, res) => {
  myCompanyTrace('pay', async () => {
    await charge(req.body);
  });
  res.json({ ok: true });
});
`;

  const report = analyzeTargets(
    [{ filePath: 'src/routes/pay.ts', content: code }],
    config,
  );

  assert.equal(report.findings.length, 1);
  assert.deepEqual(report.findings[0]?.missingSignals, ['metric']);

  const markdown = formatPrComment(report);
  assert.ok(markdown.includes(REPORT_MARKER));
  assert.ok(markdown.includes('POST /pay'));
});

test('flags uninstrumented tRPC query/mutation procedures and avoids SQL db.query false positives', () => {
  const code = `
export const orderRouter = router({
  getOrder: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const row = await ctx.db.query('SELECT * FROM orders WHERE id = $1', [input.id]);
      const normalized = normalizeOrder(row);
      return normalized;
    }),

  createOrder: protectedProcedure
    .input(z.object({ total: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const order = await ctx.db.insertOrder(input.total);
      await notifyFulfillment(order.id);
      return order;
    }),

  refundOrder: protectedProcedure.mutation(async ({ input }) => {
    return tracer.startActiveSpan('orders.refund', async (span) => {
      span.setAttribute('order.id', input.id);
      const res = await runRefund(input.id);
      span.end();
      return res;
    });
  }),
});

// Negative tests: SQL calls must never trigger tRPC detection
async function runRawSql(db: any) {
  await db.query('SELECT 1');
  await db.query('SELECT * FROM users', (err: any, rows: any) => {
    const count = rows.length;
    console.log(err, count);
    return count;
  });
}
`;

  const report = analyzeTargets(
    [{ filePath: 'src/trpc/orders.ts', content: code }],
    DEFAULT_CONFIG,
  );

  assert.equal(report.findings.length, 2);
  assert.deepEqual(
    report.findings.map((f) => ({
      ruleId: f.ruleId,
      symbolName: f.symbolName,
      framework: f.framework,
    })),
    [
      { ruleId: 'http-handlers', symbolName: 'trpc.query getOrder', framework: 'trpc' },
      { ruleId: 'http-handlers', symbolName: 'trpc.mutation createOrder', framework: 'trpc' },
    ],
  );
});

test('detects AWS Lambda handlers by directory or event type and splits HTTP vs queue-consumers', () => {
  const httpByDirCode = `
export async function handler(event: any) {
  const payload = JSON.parse(event.body ?? '{}');
  const order = await createOrder(payload);
  return { statusCode: 201, body: JSON.stringify(order) };
}
`;

  const httpByTypeCode = `
import type { APIGatewayProxyEvent } from 'aws-lambda';

export const handler = async (event: APIGatewayProxyEvent) => {
  const userId = event.pathParameters?.id;
  const profile = await loadProfile(userId);
  return { statusCode: 200, body: JSON.stringify(profile) };
};
`;

  const sqsCode = `
import type { SQSEvent } from 'aws-lambda';

export const handler = async (event: SQSEvent) => {
  for (const record of event.Records) {
    await processOrderMessage(record.body);
  }
};
`;

  const eventBridgeCode = `
import type { EventBridgeEvent } from 'aws-lambda';

export async function handler(event: EventBridgeEvent<'OrderCreated', any>) {
  const detail = event.detail;
  await syncWarehouse(detail.orderId);
  return { ok: true };
}
`;

  const scheduledCode = `
import type { ScheduledEvent } from 'aws-lambda';

export async function handler(event: ScheduledEvent) {
  const time = event.time;
  await purgeExpiredSessions(time);
  return { purged: true };
}
`;

  const instrumentedLambdaCode = `
export async function handler(event: any) {
  return tracer.startActiveSpan('lambda.checkout', async (span) => {
    await charge(event.body);
    span.end();
    return { statusCode: 200 };
  });
}
`;

  const nonLambdaUtilCode = `
export async function handler(value: number) {
  const doubled = value * 2;
  const tripled = value * 3;
  return doubled + tripled;
}
`;

  const report = analyzeTargets(
    [
      { filePath: 'functions/create-order.ts', content: httpByDirCode },
      { filePath: 'src/profile-lambda.ts', content: httpByTypeCode },
      { filePath: 'lambdas/order-consumer.ts', content: sqsCode },
      { filePath: 'handlers/warehouse-sync.ts', content: eventBridgeCode },
      { filePath: 'src/cron-cleanup.ts', content: scheduledCode },
      { filePath: 'api/checkout.ts', content: instrumentedLambdaCode },
      { filePath: 'src/utils/math.ts', content: nonLambdaUtilCode },
    ],
    DEFAULT_CONFIG,
  );

  assert.equal(report.findings.length, 5);
  assert.deepEqual(
    report.findings.map((f) => ({
      filePath: f.filePath,
      ruleId: f.ruleId,
      severity: f.severity,
      framework: f.framework,
    })),
    [
      {
        filePath: 'functions/create-order.ts',
        ruleId: 'http-handlers',
        severity: 'warning',
        framework: 'aws-lambda',
      },
      {
        filePath: 'handlers/warehouse-sync.ts',
        ruleId: 'queue-consumers',
        severity: 'error',
        framework: 'aws-lambda',
      },
      {
        filePath: 'lambdas/order-consumer.ts',
        ruleId: 'queue-consumers',
        severity: 'error',
        framework: 'aws-lambda',
      },
      {
        filePath: 'src/cron-cleanup.ts',
        ruleId: 'queue-consumers',
        severity: 'error',
        framework: 'aws-lambda',
      },
      {
        filePath: 'src/profile-lambda.ts',
        ruleId: 'http-handlers',
        severity: 'warning',
        framework: 'aws-lambda',
      },
    ],
  );
});

test('detects Cloudflare Workers default export fetch, queue, and scheduled handlers', () => {
  const code = `
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const data = await env.KV.get(url.pathname);
    return new Response(data ?? 'not found');
  },

  async queue(batch: MessageBatch, env: Env) {
    for (const msg of batch.messages) {
      await env.DB.insert(msg.body);
      msg.ack();
    }
  },

  async scheduled(event: ScheduledEvent, env: Env) {
    await tracer.startActiveSpan('cf.scheduled_rollup', async (span) => {
      await rollupDailyMetrics(env, event.cron);
      span.end();
    });
  },
} satisfies ExportedHandler<Env>;
`;

  const report = analyzeTargets(
    [{ filePath: 'src/worker.ts', content: code }],
    DEFAULT_CONFIG,
  );

  assert.equal(report.findings.length, 2);
  assert.deepEqual(
    report.findings.map((f) => ({
      ruleId: f.ruleId,
      severity: f.severity,
      symbolName: f.symbolName,
      framework: f.framework,
    })),
    [
      {
        ruleId: 'http-handlers',
        severity: 'warning',
        symbolName: 'cloudflare.fetch',
        framework: 'cloudflare-workers',
      },
      {
        ruleId: 'queue-consumers',
        severity: 'error',
        symbolName: 'cloudflare.queue',
        framework: 'cloudflare-workers',
      },
    ],
  );
});

test('detects GraphQL Query and Mutation resolvers only in *resolver* files', () => {
  const resolverCode = `
export const resolvers = {
  Query: {
    getOrder: async (_parent: unknown, args: { id: string }, ctx: any) => {
      const order = await ctx.orders.findById(args.id);
      const enriched = enrichOrder(order);
      return enriched;
    },
    async listOrders(_parent: unknown, _args: unknown, ctx: any) {
      return tracer.startActiveSpan('graphql.list_orders', async (span) => {
        const list = await ctx.orders.list();
        span.end();
        return list;
      });
    },
  },
  Mutation: {
    async createOrder(_parent: unknown, args: { total: number }, ctx: any) {
      const created = await ctx.orders.create(args.total);
      await ctx.events.publish(created);
      return created;
    },
  },
};
`;

  const nonResolverCode = `
export const schemaMap = {
  Query: {
    getOrder: async (id: string) => {
      const a = id.trim();
      const b = a.toLowerCase();
      return b;
    },
  },
};
`;

  const report = analyzeTargets(
    [
      { filePath: 'src/graphql/order.resolver.ts', content: resolverCode },
      { filePath: 'src/utils/schema-map.ts', content: nonResolverCode },
    ],
    DEFAULT_CONFIG,
  );

  assert.equal(report.findings.length, 2);
  assert.deepEqual(
    report.findings.map((f) => ({
      filePath: f.filePath,
      ruleId: f.ruleId,
      symbolName: f.symbolName,
      framework: f.framework,
    })),
    [
      {
        filePath: 'src/graphql/order.resolver.ts',
        ruleId: 'http-handlers',
        symbolName: 'Query.getOrder',
        framework: 'graphql',
      },
      {
        filePath: 'src/graphql/order.resolver.ts',
        ruleId: 'http-handlers',
        symbolName: 'Mutation.createOrder',
        framework: 'graphql',
      },
    ],
  );
});

test('otel-naming rule flags high-cardinality, empty, and generic span names while allowing valid static names and ignore directives', () => {
  const code = `
async function run(userId: string, orderId: string) {
  // 1. High-cardinality template literal -> flagged
  await tracer.startActiveSpan(\`user-\${userId}\`, async (span) => {
    await loadUser(userId);
    span.end();
  });

  // 2. High-cardinality string concatenation -> flagged
  const s1 = tracer.startSpan('order-' + orderId);
  s1.end();

  // 3. Empty / whitespace span names -> flagged
  const s2 = tracer.startSpan('');
  s2.end();
  const s3 = tracer.startActiveSpan('   ', (span) => {
    span.end();
  });

  // 4. Generic span names -> flagged
  const s4 = tracer.startSpan('handler');
  const s5 = tracer.startSpan('fn');
  const s6 = tracer.startSpan('span');
  s4.end(); s5.end(); s6.end();

  // 5. Valid static span names -> pass
  await tracer.startActiveSpan('orders.create', async (span) => {
    span.setAttribute('order.id', orderId);
    span.end();
  });
  const s7 = tracer.startSpan(\`billing.charge\`);
  const s8 = tracer.startSpan('billing.' + 'refund');
  s7.end(); s8.end();

  // 6. Ignored via telemetry-prs-ignore and rule-specific directive -> skipped
  // telemetry-prs-ignore: otel-naming
  const s9 = tracer.startSpan(\`debug-\${userId}\`);
  // telemetry-prs-ignore
  const s10 = tracer.startSpan('default');
  s9.end(); s10.end();
}
`;

  const report = analyzeTargets(
    [{ filePath: 'src/services/orders.ts', content: code }],
    DEFAULT_CONFIG,
  );

  assert.equal(report.findings.length, 7);
  assert.ok(report.findings.every((f) => f.ruleId === 'otel-naming'));
  assert.ok(report.findings.every((f) => f.severity === 'warning'));
  assert.ok(
    report.findings[0]?.message.includes('span.setAttribute') &&
      report.findings[0]?.suggestion.includes('span.setAttribute'),
  );
  assert.ok(report.findings[1]?.message.includes('high-cardinality'));
  assert.ok(report.findings[2]?.message.includes('empty'));
  assert.ok(report.findings[3]?.message.includes('empty'));
  assert.ok(report.findings[4]?.message.includes('generic'));
  assert.ok(report.findings[5]?.message.includes('generic'));
  assert.ok(report.findings[6]?.message.includes('generic'));

  const scopedUntouched = analyzeTargets(
    [
      {
        filePath: 'src/services/orders.ts',
        content: code,
        addedLines: new Set([5]),
      },
    ],
    DEFAULT_CONFIG,
  );
  assert.equal(scopedUntouched.findings.length, 0);

  const scopedTouched = analyzeTargets(
    [
      {
        filePath: 'src/services/orders.ts',
        content: code,
        addedLines: new Set([10]),
      },
    ],
    DEFAULT_CONFIG,
  );
  assert.equal(scopedTouched.findings.length, 1);
  assert.equal(scopedTouched.findings[0]?.ruleId, 'otel-naming');
  assert.equal(scopedTouched.findings[0]?.line, 10);
});

test('formatPrComment renders clickable GitHub file links when repoUrl and headSha are provided', () => {
  const code = `
router.post('/pay', async (req, res) => {
  const amount = req.body.amount;
  const receipt = await charge(amount);
  res.json({ receipt });
});
`;

  const report = analyzeTargets(
    [{ filePath: 'src/routes/pay.ts', content: code }],
    DEFAULT_CONFIG,
  );

  assert.equal(report.findings.length, 1);
  const line = report.findings[0]!.line;

  const linkedMarkdown = formatPrComment(report, {
    repoUrl: 'https://github.com/acme/payments/',
    headSha: 'abc1234',
  });
  assert.ok(
    linkedMarkdown.includes(
      `[\`src/routes/pay.ts:${line}\`](https://github.com/acme/payments/blob/abc1234/src/routes/pay.ts#L${line})`,
    ),
  );

  const plainMarkdown = formatPrComment(report);
  assert.ok(plainMarkdown.includes(`| \`src/routes/pay.ts:${line}\` |`));
  assert.ok(!plainMarkdown.includes('https://github.com/'));
});

test('skips "use client" modules, non-worker handleRequest, and API routes under queues/', () => {
  const clientCode = `
'use client';
export async function handleRequest(e: any) {
  e.preventDefault();
  const res = await fetch('/api/login');
  return res.json();
}
`;

  const pagesApiQueuesCode = `
export async function syncQueueRoute(req: any, res: any) {
  const name = req.query.name;
  const items = await loadItems(name);
  res.json(items);
}
`;

  const report = analyzeTargets(
    [
      { filePath: 'utils/auth-helpers/client.ts', content: clientCode },
      { filePath: 'pages/api/queues/[[...path]].ts', content: pagesApiQueuesCode },
    ],
    DEFAULT_CONFIG,
  );

  assert.equal(report.findings.length, 0);
});

test('does not let queue.add or session.set falsely satisfy metric instrumentation', () => {
  const code = `
router.post('/jobs', async (req, res) => {
  const job = await emailQueue.add('send', req.body);
  req.session.set('lastJobId', job.id);
  res.json({ id: job.id });
});

router.post('/jobs-instrumented', async (req, res) => {
  const job = await emailQueue.add('send', req.body);
  jobsEnqueuedCounter.add(1, { queue: 'email' });
  res.json({ id: job.id });
});
`;

  const report = analyzeTargets(
    [{ filePath: 'src/routes/jobs.ts', content: code }],
    DEFAULT_CONFIG,
  );

  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]?.symbolName, 'POST /jobs');
});

test('measures minLines on effective body lines so decorator-heavy 1-line NestJS methods are skipped', () => {
  const code = `
class ArticlesController {
  @ApiOperation({ summary: 'Get all articles' })
  @ApiResponse({ status: 200, description: 'Return all articles.' })
  @Get()
  async findAll(@Query() query: any) {
    // Delegate straight to service
    return this.articleService.findAll(query);
  }

  @Post()
  async create(@Body() dto: any) {
    const validated = validateArticle(dto);
    const created = await this.articleService.create(validated);
    return { article: created };
  }
}
`;

  const report = analyzeTargets(
    [{ filePath: 'src/article/article.controller.ts', content: code }],
    DEFAULT_CONFIG,
  );

  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]?.symbolName, '@Post create');
});

test('handles Logger.error case-insensitively, error forwarding, and benign parse probes in catch blocks', () => {
  const code = `
async function handlers(req: any, res: any, next: any, ctx: any, raw: string) {
  try {
    await doA();
  } catch (e) {
    Logger.error('doA failed', e);
    return null;
  }

  try {
    await doB();
  } catch (e) {
    return next(e);
  }

  try {
    await doC();
  } catch (e) {
    ctx.app.emit('error', e, ctx);
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }

  try {
    await chargeStripe(req.body);
  } catch (err) {
    return res.status(500).json({ ok: false });
  }
}
`;

  const report = analyzeTargets(
    [{ filePath: 'src/handlers.ts', content: code }],
    DEFAULT_CONFIG,
  );

  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]?.ruleId, 'error-swallowing');
  assert.equal(report.findings[0]?.symbolName, 'catch (err)');
});

test('detects Next.js Pages API routes, Server Actions, Hapi routes, and Agenda jobs with coverage stats', () => {
  const pagesApiCode = `
export default async function handler(req: any, res: any) {
  const userId = req.query.id;
  const user = await loadUser(userId);
  res.status(200).json(user);
}
`;

  const serverActionsCode = `
'use server';
export async function updateBillingPlan(customerId: string, planId: string) {
  const customer = await loadCustomer(customerId);
  await stripe.subscriptions.update(customer.subId, { plan: planId });
  return { ok: true };
}

export async function createInvoice(customerId: string) {
  return tracer.startActiveSpan('billing.create_invoice', async (span) => {
    const inv = await stripe.invoices.create({ customer: customerId });
    span.end();
    return inv;
  });
}
`;

  const hapiAndAgendaCode = `
server.route({
  method: 'POST',
  path: '/v1/payouts',
  handler: async (request: any, h: any) => {
    const payout = await createPayout(request.payload);
    await notifyFinance(payout.id);
    return h.response(payout).code(201);
  },
});

agenda.define('nightly-reconcile', async (job: any) => {
  const rows = await loadPendingLedgerEntries();
  await reconcileEntries(rows);
});
`;

  const report = analyzeTargets(
    [
      { filePath: 'pages/api/users.ts', content: pagesApiCode },
      { filePath: 'app/actions/billing.ts', content: serverActionsCode },
      { filePath: 'src/server.ts', content: hapiAndAgendaCode },
    ],
    DEFAULT_CONFIG,
  );

  assert.equal(report.checkedUnits, 5);
  assert.equal(report.passedUnits, 1);
  assert.equal(report.coveragePercent, 20);
  assert.equal(report.errorsCount, 1);
  assert.equal(report.warningsCount, 3);
  assert.deepEqual(
    report.findings.map((f) => ({
      ruleId: f.ruleId,
      framework: f.framework,
      symbolName: f.symbolName,
    })),
    [
      {
        ruleId: 'http-handlers',
        framework: 'nextjs-server-action',
        symbolName: 'action updateBillingPlan',
      },
      {
        ruleId: 'http-handlers',
        framework: 'nextjs-pages',
        symbolName: 'API pages/api/users.ts',
      },
      {
        ruleId: 'http-handlers',
        framework: 'hapi',
        symbolName: 'POST /v1/payouts',
      },
      {
        ruleId: 'queue-consumers',
        framework: 'agenda',
        symbolName: 'agenda.define(nightly-reconcile)',
      },
    ],
  );
});

test('flags NextResponse.next in catch, ignores cookieStore.set as metric, and detects dynamic Hapi routes and error-reporter guards', () => {
  const middlewareCode = `
export async function updateSession(request: any) {
  try {
    const supabase = createClient(request);
    await supabase.auth.getUser();
  } catch (e) {
    return NextResponse.next({ request: { headers: request.headers } });
  }
}
`;

  const serverActionCode = `
'use server';
export async function signInWithEmail(formData: FormData) {
  const cookieStore = cookies();
  const email = String(formData.get('email'));
  cookieStore.set('preferredSignInView', 'email');
  return redirect('/account');
}
`;

  const hapiAndGuardsCode = `
server.route({
  method: route.method,
  path: route.path,
  handler: async (request: any, h: any) => {
    const data = await loadData(request.params);
    return h.response(data).code(200);
  },
});

function reportAndWarn(error: unknown, name: string, deps: any) {
  try {
    deps.onSnapshotError?.(error, name);
  } catch {}

  try {
    createQueue(name);
  } catch (err) {
    deps.onWarning(String(err));
  }
}
`;

  const report = analyzeTargets(
    [
      { filePath: 'utils/supabase/middleware.ts', content: middlewareCode },
      { filePath: 'utils/auth-helpers/server.ts', content: serverActionCode },
      { filePath: 'packages/hapi/src/HapiAdapter.ts', content: hapiAndGuardsCode },
    ],
    DEFAULT_CONFIG,
  );

  assert.deepEqual(
    report.findings.map((f) => ({
      filePath: f.filePath,
      ruleId: f.ruleId,
      framework: f.framework,
      symbolName: f.symbolName,
    })),
    [
      {
        filePath: 'packages/hapi/src/HapiAdapter.ts',
        ruleId: 'http-handlers',
        framework: 'hapi',
        symbolName: 'ROUTE (hapi route)',
      },
      {
        filePath: 'utils/auth-helpers/server.ts',
        ruleId: 'http-handlers',
        framework: 'nextjs-server-action',
        symbolName: 'action signInWithEmail',
      },
      {
        filePath: 'utils/supabase/middleware.ts',
        ruleId: 'error-swallowing',
        framework: 'typescript',
        symbolName: 'catch (e)',
      },
    ],
  );
});

test('skips helper exports in worker/src/ packages and detects Cloudflare Pages onRequest handlers', () => {
  const workerHelperCode = `
export function allTargets(env: any) {
  const priv = parseList(env.PRIVATE_TARGETS);
  const pub = parseList(env.PUBLIC_TARGETS);
  return [...pub, ...priv];
}
`;

  const cfPagesCode = `
export async function onRequestGet({ request, env, waitUntil }: any) {
  const key = new Request(new URL('/api/status', request.url).toString());
  const hit = await caches.default.match(key);
  if (hit) return hit;
  const res = await statusApi(request, env, false);
  if (res.ok) waitUntil(caches.default.put(key, res.clone()));
  return res;
}
`;

  const report = analyzeTargets(
    [
      { filePath: 'worker/src/targets.js', content: workerHelperCode },
      { filePath: 'functions/api/status.js', content: cfPagesCode },
    ],
    DEFAULT_CONFIG,
  );

  assert.equal(report.errorsCount, 0);
  assert.deepEqual(
    report.findings.map((f) => ({
      filePath: f.filePath,
      ruleId: f.ruleId,
      framework: f.framework,
      symbolName: f.symbolName,
    })),
    [
      {
        filePath: 'functions/api/status.js',
        ruleId: 'http-handlers',
        framework: 'cloudflare-pages',
        symbolName: 'onRequestGet functions/api/status.js',
      },
    ],
  );
});
