# Telemetry PRs

Catch missing OpenTelemetry spans, metrics, and logs in TypeScript/Node.js pull requests — **fast, static, vendor-neutral, and 100% inside your CI**.

Auto-instrumentation covers HTTP and database calls, not the business logic, background jobs, queue consumers, and silent catch blocks that leave teams blind during outages. Telemetry PRs runs on every PR diff, reports touched-code telemetry coverage, and flags uninstrumented paths before they merge.

## Why CI-native & static?

- **Your code never leaves your CI runner.** No SaaS upload, no LLM API keys, no external network calls.
- **Vendor-neutral.** Works with OpenTelemetry going to Datadog, Grafana, Honeycomb, Dash0, Jaeger, or anything else.
- **Quiet by default.** Only checks code units touched by the PR diff, skips trivial 1–3 line delegators and frontend `'use client'` files, updates a single PR comment in place with clickable file links, stays silent on clean PRs, and supports inline `// telemetry-prs-ignore` directives.

## Quickstart (GitHub Action)

Add `.github/workflows/telemetry-prs.yml`:

```yaml
name: Telemetry Check
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
      - uses: telemetry-prs/telemetry-prs@v0.1.0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

Works zero-config out of the box. Or generate a tailored `.telemetry-prs.yml` (auto-detecting `pino`, `winston`, `prom-client`, `@opentelemetry/api`, `dd-trace`, and source folders):

```bash
node dist/cli.cjs init --workflow
```

### Action Inputs & Outputs

| Input | Default | Description |
| :--- | :--- | :--- |
| `config` | `.telemetry-prs.yml` | Path to configuration file |
| `mode` | `comment` | `comment` (report only) or `fail` (exit non-zero on `error`-severity gaps) |
| `github-token` | `${{ github.token }}` | Token for reading PR diffs and updating the PR comment |
| `comment-on-pr` | `true` | Post/update a single summary comment on the PR |
| `annotate` | `true` | Emit inline file/line annotations on changed lines |
| `sarif-file` | `""` | Optional path to write SARIF 2.1.0 output for GitHub Code Scanning |

Outputs: `findings-count`, `errors-count`, `warnings-count`, `coverage-percent`.

## Built-in Rules (v1)

| Rule | Default Severity | What it checks |
| :--- | :--- | :--- |
| `http-handlers` | `warning` | Express, Fastify, Hapi, Hono, Koa, NestJS, Next.js App Router, Next.js Pages API, Next.js `'use server'` actions, tRPC procedures, AWS Lambda HTTP handlers, Cloudflare Workers `fetch`, Cloudflare Pages `onRequest*` functions, and GraphQL `Query`/`Mutation` resolvers missing a custom span or business metric |
| `queue-consumers` | `error` | BullMQ `Worker`, Bull `queue.process`, Agenda `agenda.define`, KafkaJS `eachMessage`/`eachBatch`, RabbitMQ `channel.consume`, SQS consumers, cron jobs, Inngest, AWS Lambda queue/event handlers, Cloudflare Workers `queue`/`scheduled`, and `workers/` functions |
| `error-swallowing` | `warning` | `catch` blocks that do not rethrow or forward errors (`next(e)`, `done(e)`, `emit('error', ...)`) and emit no `recordException`, structured error log, or error metric (benign parse/probe fallbacks like `JSON.parse` are skipped) |
| `otel-naming` | `warning` | `startActiveSpan` / `startSpan` calls with high-cardinality dynamic names (`` `user-${id}` ``, `'order-' + id`) or empty/generic names (`'handler'`, `'fn'`, `'span'`) |

### Silencing deliberate exceptions

```ts
// telemetry-prs-ignore
router.post('/internal/noop', async (req, res) => { ... });

// telemetry-prs-ignore: error-swallowing
// telemetry-prs-ignore: otel-naming
```

## Local CLI

```bash
node dist/cli.cjs init --workflow
node dist/cli.cjs check --base origin/main
node dist/cli.cjs scan ./src
node dist/cli.cjs scan ./examples --format markdown
node dist/cli.cjs scan ./examples --format sarif
```

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT
