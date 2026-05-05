# bench

Bench harness for the dispatcher + agent loop. Measures the turnaround,
per-tool latency, replay determinism, simulated cost, and terminal-cause
distribution of the loop under a hermetic FakeLLM workload, plus an opt-in
BYOK live path.

## What this measures

- **Run turnaround** — wall time from a worker dequeueing a job to the run
  reaching a terminal state (`succeeded` / `failed` / `dlq`). Reported as
  P50 / P95 / P99 / P999 / max in milliseconds.
- **Steps to success per flow** — mean step count across successful runs of
  each golden flow, plus the per-flow success rate at the harness scale.
- **Replay determinism** — N completed runs are re-executed end-to-end and
  the tool sequence of the replay is compared against the original. Score
  is `1 - (drifted_positions / total_positions)`. A score of `1.000` means
  every replay produced an identical tool sequence.
- **Per-tool step latency** — P50 / P95 of per-step latency, bucketed by
  tool name (`click`, `type`, `navigate`, `extract`, `wait`, `finish`).
- **Simulated cost per successful run** — mean and P95 of `totalCostUsd`
  reported by the agent loop. With `FakeLLMProvider` this number is fully
  deterministic and is the FakeProvider's scripted `costPerCallUsd`
  multiplied by the LLM step count of the run.
- **Failure breakdown by terminal cause** — counts of runs that finished
  in each bucket: `succeeded`, `budget_exceeded` (step / cost / wallclock /
  token), `tool_failed` (executor exhausted retries), `infra_dlq`
  (provider or upstream classified as infra).

## What is held constant

- Workload: 10 golden flows under `eval/flows/*.json`, each enqueued
  `BENCH_RUNS_PER_FLOW` times (default 100, total 1000).
- Provider: `FakeLLMProvider` with the per-flow scripted ToolCall sequence
  baked into the flow JSON. Cost-per-call is the FakeProvider default
  (0.001 USD), so a 6-step run scores `0.006` simulated USD by definition.
- Executor: `ScriptedExecutor` — same code path used by the eval CLI and
  by the dispatcher unit tests. No real browser, no network.
- Concurrency: 8 in-process workers by default, tunable via
  `BENCH_CONCURRENCY=N` or `--concurrency N`.
- Retry policy: production policy with `setTimeout` replaced by a no-op
  sleep so retries don't add wall-clock noise to the measurement.

## Why these scales

- 100 runs per flow × 10 flows yields 1000 samples. That's enough samples
  for a stable P95 (~50 samples beyond the cutoff) without making the
  bench take more than ~10 seconds locally on a FakeLLM workload.
- 50 replays of completed runs gives a determinism score with sub-percent
  granularity (`drift / 50` is the worst-case false-failure precision).
- Default concurrency 8 matches the BullMQ worker default in the
  dispatcher (`workerConcurrency` defaults to 4 per worker process; 8 here
  approximates 2 worker processes on a single host).

## What these numbers mean (and don't)

- Turnaround on FakeLLM is sub-second per run because the LLM call is
  in-process and synchronous and the executor is in-memory. **Live runs
  are dominated by Anthropic latency** (1-3s/step at Sonnet 4.7) **and
  Playwright tool execution** (50-500ms per browser action). Read the
  FakeLLM turnaround numbers as the loop+executor overhead floor — what
  the dispatcher adds on top of the model call.
- FakeLLM cost numbers are deterministic per scripted tool sequence —
  they exercise the cost-tracking code path but are **not predictive of
  live Anthropic spend**. To run live, set `ANTHROPIC_API_KEY` and use
  `pnpm bench:cheap`. Estimated live spend at default scale is in the
  ~$5-10 range on Sonnet 4.7 and ~$0.50-1 on Haiku, depending on average
  steps-per-flow and prompt-cache hit rate. Treat that range as a hint,
  not a quote.
- The harness drives runs through an in-process pool, not through
  BullMQ + Redis. The dispatcher's per-tenant semaphore and per-domain
  token bucket are not exercised here; their behaviour is covered by
  `apps/runner/src/agent/dispatch.test.ts`. The bench measures the loop
  and the loop's executor seam — not the queue.

## Usage

```sh
# default — 100 × 10 flows, FakeLLMProvider, hermetic
pnpm bench

# smaller scale, useful when iterating on the harness
BENCH_RUNS_PER_FLOW=10 BENCH_REPLAYS=5 pnpm bench

# BYOK live path against Haiku — gated on ANTHROPIC_API_KEY
ANTHROPIC_API_KEY=sk-... pnpm bench:cheap
```

Results land in `bench/results/<timestamp>.json`. The harness also prints
a terse columnar summary to stdout. The committed JSON files are the
canonical numbers cited from `README.md`.

## Live (BYOK) status

The `--provider anthropic` path currently **errors** with a pointer to
`ROADMAP.md` item 5 (live mock-site eval CLI path). The CLI flag exists
so we can wire the live bench against the dispatcher in a follow-up
without changing the bench script's surface. Once that lands, the live
path will enqueue runs onto the `runs` BullMQ queue, await SSE
completion, and emit the same JSON shape as the FakeLLM bench so the two
can be diffed.
