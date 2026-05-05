# Roadmap

Concrete deferred work. Items are listed in priority order. Sprint 1 closed
out the dispatcher, the Drizzle-backed stores, and Redis-pub/sub cancellation;
everything below is what's still gap to a production deployment.

## 1. BullMQ → Anthropic → Playwright dispatcher ✅

`apps/runner/src/agent/dispatch.ts` runs end-to-end. BullMQ worker pulls a run
job, loads flow + inputs through the store interface, instantiates an
Anthropic client, opens a Playwright browser context, and feeds both into
`runAgent`. Per-tenant Redis semaphore caps concurrency, per-domain token
bucket rate-limits, Redis pub/sub propagates cancellation, and infra failures
land in DLQ with the original payload preserved. Tests in
`apps/runner/src/agent/dispatch.test.ts` cover the four contract paths against
the live Redis service in CI.

## 2. Drizzle-backed `RunStore` / `FlowStore` ✅

`packages/db/src/stores/` ships both the in-memory and Postgres-backed
implementations behind a single interface. The control-plane keeps the
`MemoryRunStore` for unit tests; the runner uses `PgRunStore` against the
partitioned `runs` table with monthly partitions created lazily on first
insert. Idempotency conflicts are handled at the DB layer via the existing
unique index. Tests run parameterized against both backends in CI.

## 3. Distributed cancellation via Redis pub/sub ✅

Each runner subscribes to `runs:cancel:*` on start; `DELETE /runs/:id`
publishes onto the channel keyed on `run_id`. The dispatcher's per-run
`AbortController` propagates through the agent loop to both the LLM
provider's in-flight HTTP call and the Playwright executor's in-flight
primitive.

## 4. S3-compatible artifact uploader ✅

`apps/runner/src/agent/artifacts/uploader.ts` uses `@aws-sdk/client-s3`,
gzip-compresses DOM, ships PNG screenshots and JSONL console logs, and warns
when an upload exceeds 5s. Keys follow `artifacts/{tenant}/{run}/{step}/{kind}.{ext}`.
The MinIO service in CI exercises the round-trip.

## 5. Live mock-site eval CLI path

`pnpm eval run --suite golden_v1 --provider anthropic` exists as a CLI flag
today but isn't wired against the dispatcher; it bypasses the queue and runs
synchronously. The plan is to enqueue each flow onto the `runs` queue, await
completion via SSE, and write the result alongside the hermetic baseline.
Gated on `ANTHROPIC_API_KEY`; intentionally not part of `eval-smoke`.

## 6. Live mock-site CI workflow

A second CI workflow that runs `pnpm eval run --provider anthropic` against
the mock fastify sites with a stored `secrets.ANTHROPIC_API_KEY`. Runs on
nightly schedule, not on every PR — keeps the per-PR check budget lean.

## 7. Drizzle migration tooling

Migrations land via `pnpm migrate` reading the single `0001_init.sql` file.
The next iteration generates incremental SQL via `drizzle-kit` and adds a
`pnpm migrate:rollback` for the in-place dev story. Production deployments
get a separate `pnpm migrate:deploy` that runs inside the runner image's
init container.

## 8. Real-internet flows — out of scope

We will not run the eval against live websites. Mock sites under
`tests/fixtures/sites/` are the contract. Real sites churn, break
determinism, and turn loop regressions into "did Amazon change their
checkout" debates.
