# Changelog

## 2026-05-02 — Dispatcher landed

- `apps/runner/src/agent/dispatch.ts` is real code: BullMQ worker pulls run jobs, applies per-tenant Redis semaphores and per-domain token-bucket rate limits, drives the agent loop with a real Anthropic provider and a real Chromium, and surfaces typed errors into the DLQ.
- `apps/runner/src/agent/providers/anthropic-provider.ts` implements the `LLMProvider` interface against `@anthropic-ai/sdk`. Default model `claude-sonnet-4-7-20250929`. No retries inside the provider — typed `RateLimitError` / `UpstreamError` / `AuthError` surface to the loop. Cost accounting reads `usage.input_tokens` / `usage.output_tokens` and multiplies by the price table in `apps/runner/src/agent/pricing.ts`.
- `apps/runner/src/agent/executors/playwright-executor.ts` owns one `BrowserContext` per run, captures DOM + screenshot + console messages on every tool call, and propagates `AbortSignal` through every Playwright primitive.
- `packages/db/src/stores/` ships `MemoryRunStore` / `MemoryFlowStore` and `PgRunStore` / `PgFlowStore` behind a single interface. Cursors are opaque base64 of `(created_at_iso, run_id)`. Monthly partitions on `runs` are created lazily on first insert.
- `apps/runner/src/agent/artifacts/uploader.ts` uses `@aws-sdk/client-s3` against MinIO locally and S3 in production. Gzip-compresses DOM. Warns on slow uploads; never blocks the loop.
- Distributed cancellation flows over `runs:cancel:{run_id}` Redis pub/sub. Each runner subscribes on start.
- CI: postgres + redis + minio services for the test job. Playwright bundled chromium installed in the test job.

## 2026-05-02 — Sprint 0 baseline

- Agent loop with budgets, retries, FakeLLM, ScriptedExecutor, golden-flow eval suite (10 flows, 1.00 success), and CI green.
