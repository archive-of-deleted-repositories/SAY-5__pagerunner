# PageRunner

Browser agent orchestration platform: an HTTP control plane accepts flow definitions and run requests, a worker pool drives Playwright browsers through tool-using agent loops with bounded budgets, and a deterministic replay path lets failed runs be re-executed against captured DOM snapshots. Built to study how agent loops behave when subjected to backpressure, retries, partial-failure preservation, and golden-flow regression gates.

## What this studies

- Agent loops with hard step / token / wall-clock / cost budgets and how those budgets compose with per-step retries.
- Per-domain backpressure via token buckets keyed on `target_domain`, layered with per-tenant concurrency caps.
- Deterministic replay against a captured DOM trace: re-running an old failure should produce a byte-identical step sequence on the cached pages.
- A golden-flow regression suite that catches loop bugs separately from model regressions by running against a `FakeLLMProvider` with scripted tool calls.

## Layout

| Path                   | Purpose                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `apps/control-plane`   | NestJS REST + SSE API (flows, runs, artifacts, events).                                                         |
| `apps/runner`          | BullMQ worker, Playwright tool executor, agent loop, replay CLI.                                                |
| `apps/admin`           | Next.js 14 dashboard (single page; reads recent runs).                                                          |
| `packages/sdk`         | Typed TS client + SSE wrapper with `Last-Event-ID` resume.                                                      |
| `packages/agent-tools` | Zod schemas for `navigate`, `click`, `type`, `extract`, `wait`, `finish`, exported as both Zod and JSON Schema. |
| `packages/db`          | Drizzle schema, SQL migrations, seed script.                                                                    |
| `packages/shared`      | Errors, ids, structured logger, OTel span helper.                                                               |
| `eval/`                | Golden flow definitions and the eval CLI.                                                                       |
| `tests/`               | Unit tests; integration fixtures live under `tests/fixtures/sites`.                                             |
| `infra/dashboards/`    | Grafana dashboard JSON.                                                                                         |

## Architecture

```
                   ┌─────────────────────────────┐
   HTTP/SDK ─────▶ │  control-plane (NestJS)     │
                   │  /flows /runs /events       │
                   │  in-memory store + EventBus │
                   └────────────┬────────────────┘
                                │ enqueues run jobs (BullMQ)
                                ▼
                   ┌─────────────────────────────┐
                   │  Redis (queue + sem + p/sub)│
                   └────────────┬────────────────┘
                                │
                                ▼
   ┌────────────────────────────────────────────────────────┐
   │  runner (BullMQ worker)                                 │
   │   ┌────────────┐  ┌────────────┐  ┌──────────────────┐ │
   │   │ TokenBucket│  │ AgentLoop  │  │ Playwright/      │ │
   │   │ per domain │─▶│ budgets +  │─▶│ ScriptedExecutor │ │
   │   └────────────┘  │ retries    │  └──────┬───────────┘ │
   │                   └─────┬──────┘         │             │
   │                         ▼                ▼             │
   │                   ┌──────────┐    ┌────────────┐       │
   │                   │ LLM (    │    │ S3/MinIO   │       │
   │                   │ Anthropic│    │ artifacts  │       │
   │                   │ or Fake) │    └────────────┘       │
   │                   └──────────┘                         │
   └────────────────────────────────────────────────────────┘
                         │
                         ▼
                   ┌──────────────┐
                   │ Postgres     │
                   │ runs / steps │
                   │ (partitioned)│
                   └──────────────┘
```

## Quickstart

Requires Node 20, pnpm 10, and (for integration paths) Docker.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm eval run --suite golden_v1 --limit 3
```

Bring up the local stack:

```sh
docker compose up -d postgres redis minio
pnpm migrate
pnpm seed
pnpm --filter @pagerunner/control-plane dev
```

Drive a flow via the SDK:

```ts
import { PageRunnerClient } from '@pagerunner/sdk';
const c = new PageRunnerClient({ baseUrl: 'http://localhost:3000' });
const flow = await c.createFlow({
  name: 'demo',
  dag: {
    nodes: [
      { id: 'n', tool: 'navigate', next: 'f' },
      { id: 'f', tool: 'finish' },
    ],
  },
});
const run = await c.createRun({ flowId: flow.id, idempotencyKey: 'demo-1' });
```

## Reproducibility

The eval CLI runs the golden suite end-to-end through the agent loop using a `FakeLLMProvider` with scripted tool calls and a `ScriptedExecutor` that simulates DOM responses. CI runs a 3-flow subset on every push; the full suite is one command:

```sh
pnpm eval run --suite golden_v1
```

Replay a previous run from a captured trace:

```sh
pnpm --filter @pagerunner/runner replay path/to/trace.json
```

The replay script reports a `determinism` score in `[0, 1]` based on whether the replayed step sequence matches the recorded tools.

## Design targets

These are targets the architecture is laid out to hit; numbers are not yet measured under load.

| Metric                                | Target                   |
| ------------------------------------- | ------------------------ |
| P95 run turnaround (≤20 actions)      | < 90s                    |
| Golden flow success rate (rolling 7d) | ≥ 95%                    |
| Per-run cost (live model)             | < $0.08                  |
| Replay determinism on cached DOM      | ≥ 98%                    |
| Step budget enforcement               | hard cap, never exceeded |

Live measurements are <TBD: see eval CLI history table>.

## Tests

- Unit: token-bucket math, DAG validator (cycles, unreachable, branches), retry policy decision table, idempotency, agent-loop budgets, SDK round-trip against a transient NestJS instance, SSE event-bus replay via `Last-Event-ID`.
- Integration (gated on `RUN_INTEGRATION=1`, requires Docker): full Playwright run against the local mock fastify server, replay determinism, cancellation propagation.
- Coverage gate: 80% lines / statements in CI.

Run them with `pnpm test` (unit) or `RUN_INTEGRATION=1 pnpm test` (full).

## What this is not

- Not a hosted service. There is no auth layer, billing, or multi-region story.
- Not an evaluation framework for the underlying model. The CI eval uses a deterministic fake to catch loop regressions; live-model evaluation is a BYOK path documented but unstaffed.
- Not a low-code flow builder. Flows are JSON DAGs; the admin app is a read-only inspector.

## Known issues

- The production dispatcher (`apps/runner/src/agent/dispatch.ts`) is a placeholder. The worker shell, agent loop, executor, FakeLLM, retry, and budgets are wired and tested; connecting them to the real BullMQ consumer plus Playwright executor is the next step.
- Runs are persisted in-memory in the control-plane today. Migrating onto the Drizzle schema (already present) is the second next step.

## License

MIT — see [LICENSE](./LICENSE).
