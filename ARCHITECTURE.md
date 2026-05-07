# Architecture

## Agent loop topology

The loop in `apps/runner/src/agent/loop.ts` is the heart of the system. It owns a single browser context for the duration of one run and walks one tool call at a time:

1. Check budgets (`maxSteps`, `maxWallClockMs`, `maxCostUsd`). Exceed → throw a domain error and the worker tags the run as `failed` with a reason code.
2. Truncate the current DOM observation to 8k chars (with selector hints retained at the head) and ask the `LLMProvider` for the next tool call.
3. Add the LLM cost and tokens to the running totals and re-check budgets.
4. Validate the tool call with the matching Zod schema from `@pagerunner/agent-tools`. Invalid → fail; the loop never executes a tool it can't type-check.
5. Execute through `ToolExecutor`. On `SelectorNotFoundError`, consult the retry policy and either back off and retry or surface the error.
6. Persist the step record (`tool`, `input`, `output`, `latency_ms`, `retry_count`, status) and append the new DOM excerpt to the next observation.
7. If the executed tool was `finish`, return `succeeded` with the agent's final result.

The loop is dependency-injected on the LLM and the executor, so production wires it to Anthropic + Playwright while tests use `FakeLLMProvider` + `ScriptedExecutor`. The interface boundary is what makes the golden eval suite hermetic.

## Budget design

| Budget             | Default | Where checked                                 |
| ------------------ | ------- | --------------------------------------------- |
| `maxSteps`         | 20      | Loop top, before every LLM call               |
| `maxWallClockMs`   | 120,000 | Loop top, against monotonic clock             |
| `maxCostUsd`       | 0.50    | After each LLM call adds to the running total |
| `maxTokensPerStep` | 4,000   | After each LLM call returns                   |

Budgets are _hard caps_, not soft warnings. The loop bails the moment a check fails, with a typed `PageRunnerError` (`STEP_BUDGET_EXCEEDED`, `WALL_CLOCK_EXCEEDED`, `COST_BUDGET_EXCEEDED`, `TOKEN_BUDGET_EXCEEDED`). The worker turns those into terminal `failed` states, never `dlq`, so the cause is obvious in the runs table without a separate audit log.

## Retry policy

`apps/runner/src/agent/retry-policy.ts` is a pure decision table. Two retry levels:

- **Step retries** (selector-not-found and other retryable domain errors): up to 3 attempts with backoff `[500ms, 2s, 8s]`. Same browser context, same step index.
- **Job retries** (infra errors, undeclared exceptions): up to 2 attempts with linear backoff. Fresh browser context. After exhaustion the job goes to the DLQ table with the full trace pointer.

Selector-not-found is treated as flake by default; if a flow is genuinely brittle this surfaces as elevated `retry_count` in the steps table without flooding the DLQ.

## Per-domain rate limit math

`TokenBucket` (`apps/runner/src/agent/token-bucket.ts`) is straightforward: capacity `C`, refill rate `r` tokens/sec. `tryConsume(n)` returns `false` immediately if the bucket can't satisfy; `delayFor(n)` returns ceiling of `((n - tokens) / r) * 1000` ms which the worker uses to schedule a re-check rather than blocking the queue.

Default config is `C=10, r=10` per `target_domain`, configurable per tenant via the `tenants.rate_per_sec` column. A run inherits the slower of (per-tenant cap, per-domain cap) so a multi-domain flow can't aggregate to more than the tenant's allotment.

## Replay determinism

A run's trace consists of: ordered `steps` rows + a DOM snapshot artifact per step in S3. Replay (`apps/runner/src/cli/replay.ts`) reads a trace JSON and:

1. Builds a `FakeLLMProvider` whose script is exactly the recorded tool calls.
2. Builds a `ScriptedExecutor` whose extract values come from the recorded outputs.
3. Runs the loop and compares the new step sequence to the recorded one.
4. Reports a `determinism` score: `1 - (drift_count / step_count)`.

The contract is: against cached DOM, the loop must produce the same tool sequence. Drift > 2% is a regression signal — the loop or the validator changed in a way that materially affects branching.

## Partial failure preservation

Steps are persisted as they finish. If step 7 of 10 fails and the run goes to DLQ, steps 1-6 stay in the `steps` table with their outputs and artifacts. The DLQ entry points at the run id, not a separate trace blob, so:

- The admin UI shows the full step list with the failed step highlighted.
- Replay can re-run from step 0 against the captured DOM and assert the same tool sequence up through step 6.
- A future "resume from N" path is data-shape-compatible: nothing about the run schema changes.

## Schema and migrations

Drizzle owns the schema (`packages/db/src/schema.ts`). `runs` is partitioned by month on `created_at`; six rolling partitions are pre-created and a `runs_default` partition catches stragglers. Indexes:

- `(tenant_id, status, created_at DESC)` for the dashboard list query.
- Unique `(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL` to enforce dedup at the database level (the in-memory store mirrors this contract for tests).

Migrations are plain SQL in `packages/db/migrations`. Drizzle-kit can generate diffs against a shadow DB (`pnpm --filter @pagerunner/db generate`); the SQL files in the repo are the canonical source so reviewers don't need to install the kit to read them.

## Distributed cancellation

A run can be cancelled by `POST /v1/runs/{id}/cancel`. The control-plane writes `status = cancelling` to the DB synchronously and then publishes on the channel `runs:cancel:<run_id>` (Redis `PUBLISH`). Each dispatcher pod opens a dedicated `ioredis` connection and `PSUBSCRIBE`s the pattern `runs:cancel:*` at startup.

When a `pmessage` arrives, every pod looks up the run id in its in-memory `runId -> AbortController` map. The pod that owns the run aborts the controller; the agent loop catches `AbortError`, unwinds tool execution, and the dispatcher writes `status = cancelled` to the DB. Pods that don't have a handle for that run no-op the message — there's no coordination protocol because there's no shared state to reconcile.

Pub/sub is best-effort delivery. If Redis disconnects mid-run the pod that owns the run never sees the cancel; the run completes normally on its own budget. The local AbortController is the source of truth for the running pod. The DB still reflects `cancelling` so the operator sees the intent; the next status transition is whatever the run terminates with (`succeeded`, `failed`, `dlq`). The control-plane keeps the cancel idempotent — re-issuing the request from `cancelling` re-publishes without re-writing the DB row.

Two-pod coverage in `apps/runner/src/agent/dispatch.distributed-cancel.test.ts` boots two `Dispatcher` instances against the same Redis: pod A claims a long-running job whose `LLMProvider.step` blocks on the abort signal, pod B publishes the cancel via the same `CancelPublisher` the control-plane uses. The test asserts (a) pod A aborts within 2 seconds of the publish, (b) the run lands at `cancelled`, (c) pod B's `pmessage` handler is a clean no-op.

## Event bus and SSE resume

`EventBus` keeps a per-run ring buffer (256 events). `GET /runs/{id}/events` flushes the buffered events past `Last-Event-ID` first, then attaches a live subscriber. The contract is: a client that disconnects mid-stream and reconnects with `Last-Event-ID: <last-seen>` will not miss any event in the buffer window.

In production this would back onto Redis pub/sub (live fan-out) plus a TTL'd `run_events` table (longer resume window). The in-memory shape is sufficient for the SDK round-trip + resume test that lives in `tests/unit/event-bus.test.ts`.

## Observability surface

Custom OTel spans wrap `agent.llm` and `agent.tool` with attributes `tool`, `llm_model`, `tokens_in`, `tokens_out`, `cost_usd`, `retry_count`, `dom_size_bytes`, `target_domain`. Trace context propagates from the API into the BullMQ job payload. Prometheus metrics:

| Name                    | Type      | Labels                     |
| ----------------------- | --------- | -------------------------- |
| `run_duration_seconds`  | histogram | `tenant`, `flow`, `status` |
| `step_duration_seconds` | histogram | `tool`, `tenant`           |
| `queue_depth`           | gauge     | `queue`                    |
| `dlq_total`             | counter   | `tenant`, `reason`         |
| `cost_usd_total`        | counter   | `tenant`, `flow`, `model`  |

The Grafana dashboard JSON in `infra/dashboards/pagerunner.json` covers RED metrics, queue depth, cost burn, and the rolling golden-flow success rate.

## What's deliberately not here

- **No multi-region failover.** Single-region Postgres + Redis. Out of scope for a portfolio project.
- **No auth.** Bearer-token plumbing is present in the SDK so the surface is honest, but no token validation in the API.
- **No flow-builder UI.** Flows are JSON DAGs. The admin app is a read-only inspector.
- **No browser pooling.** Each run gets a fresh Playwright context. Pooling is a worthwhile follow-up; it doesn't change the loop's contract.
- **No live-model eval in CI.** The deterministic fake catches loop regressions; live evaluation requires an Anthropic key and must be run as a BYOK off-CI job.
