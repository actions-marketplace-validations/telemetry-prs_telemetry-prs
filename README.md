# Telemetry PRs

Catch missing OpenTelemetry spans, metrics, and logs in TypeScript/Node.js pull requests — **fast, static, vendor-neutral, and 100% inside your CI**.

Auto-instrumentation covers HTTP and database calls, not the business logic, background jobs, queue consumers, and silent catch blocks that leave teams blind during outages. Telemetry PRs runs on every PR diff and flags uninstrumented code paths before they merge.

## Why CI-native & static?

- **Your code never leaves your CI runner.** No SaaS upload, no LLM API keys, no external network calls.
- **Vendor-neutral.** Works with OpenTelemetry going to Datadog, Grafana, Honeycomb, Dash0, Jaeger, or anything else.
- **Quiet by default.** Only checks code units touched by the PR diff, updates a single PR comment in place, skips clean PRs silently, and supports inline `// telemetry-prs-ignore` directives.

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
      - uses: actions/checkout@v4
      - uses: your-org/telemetry-prs@v0.1.0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

Works zero-config out of the box. To customize rules or match your team's tracing/logging wrappers, copy [`.telemetry-prs.example.yml`](./.telemetry-prs.example.yml) to `.telemetry-prs.yml` at the root of your repo.

## Built-in Rules (v1)

| Rule | Default Severity | What it checks |
| :--- | :--- | :--- |
| `http-handlers` | `warning` | Express, Fastify, Hono, Koa, NestJS, Next.js App Router, tRPC (`.query`/`.mutation`), AWS Lambda, Cloudflare Workers (`fetch`), and GraphQL (`Query`/`Mutation`) handlers missing a custom span or business metric |
| `queue-consumers` | `error` | BullMQ `Worker`, Bull `queue.process`, KafkaJS `eachMessage`/`eachBatch`, RabbitMQ `channel.consume`, SQS consumers, AWS Lambda (`SQSEvent`/`EventBridge`/`Scheduled`), Cloudflare Workers (`queue`/`scheduled`), cron jobs, and `workers/` functions |
| `error-swallowing` | `warning` | `catch` blocks that do not rethrow and emit no `recordException`, structured error log, or error metric |
| `otel-naming` | `warning` | `startActiveSpan`/`startSpan` calls with high-cardinality template literals or string concatenation, empty names, or generic placeholders (`handler`, `fn`, `function`, `test`, `span`, `default`) |

### Silencing deliberate exceptions

```ts
// telemetry-prs-ignore
router.post('/internal/noop', async (req, res) => { ... });

// Or ignore a single rule:
// telemetry-prs-ignore: error-swallowing
// telemetry-prs-ignore: otel-naming
```

## Local CLI

Test Telemetry PRs against any local repository or diff:

```bash
# Check current git diff against origin/main
node dist/cli.cjs check --base origin/main

# Scan an entire directory (great for auditing an existing service)
node dist/cli.cjs scan ./src
node dist/cli.cjs scan ./examples --format markdown
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
