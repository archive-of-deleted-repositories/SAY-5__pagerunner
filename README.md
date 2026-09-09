# PageRunner

Browser agent orchestration platform: an HTTP control plane accepts flow definitions and run requests, a worker pool drives Playwright browsers through tool-using agent loops with bounded budgets, and a deterministic replay path lets failed runs be re-executed against captured DOM snapshots. Built to study how agent loops behave when subjected to backpressure, retries, partial-failure preservation, and golden-flow regression gates.

## What's wired

- Agent loop with hard step / token / wall-clock / cost budgets, per-step retries, and cooperative cancellation. ✅
- Golden-flow regression suite (10 flows, fake provider, scripted DOM). ✅
- Anthropic provider (`@anthropic-ai/sdk`, typed errors, abort propagation, no in-provider retries). ✅
- Playwright executor (one BrowserContext per run, DOM/screenshot/console artifacts per step). ✅
- BullMQ → Anthropic → Playwright dispatcher with per-tenant Redis semaphores, per-domain token buckets, Redis pub/sub cancellation, and DLQ classification. ✅
- Drizzle-backed `RunStore` and `FlowStore` alongside the in-memory variants used in unit tests. ✅
- S3-compatible artifact uploader (gzipped DOM, PNG screenshot, JSONL console). ✅
- Replay CLI against captured DOM traces. ✅

## Golden-flow results (`golden_v1`, fake provider)

| flow_name                                    | success_rate | average_steps_to_success | replay_determinism_score |
| -------------------------------------------- | ------------ | ------------------------ | ------------------------ |
| branch on extracted value                    | 1.00         | 5                        | 1.00                     |
| dropdown plus date picker                    | 1.00         | 7                        | 1.00                     |
| step retries on flaky selector then succeeds | 1.00         | 4                        | 1.00                     |
| file upload with progress wait               | 1.00         | 5                        | 1.00                     |
| multi-step form with validation              | 1.00         | 7                        | 1.00                     |
| infinite scroll until target                 | 1.00         | 6                        | 1.00                     |
| login then read profile                      | 1.00         | 6                        | 1.00                     |
| paginated scrape three pages                 | 1.00         | 7                        | 1.00                     |
| dismiss popup then proceed                   | 1.00         | 5                        | 1.00                     |
| search and extract first result              | 1.00         | 5                        | 1.00                     |
| **suite (10 flows)**                         | **1.00**     | **5.7**                  | **1.00**                 |

Hermetic suite results — loop correctness only. Source artifact: [`eval/baselines/golden_v1_fake.json`](./eval/baselines/golden_v1_fake.json). Regenerate with `pnpm bench-eval`.

Live agent runs against the mock fastify sites are gated behind `ANTHROPIC_API_KEY`. The hermetic numbers above remain the always-on regression signal.

## Performance

Numbers below are from `pnpm bench` — **200 runs of each of the 10 golden flows (2000 total)** on an M-series Mac, FakeLLMProvider against the in-process mock executor, 8 in-process workers. Source artifact: [`bench/results/2000runs_2026-05-07T20-06-10-959Z.json`](./bench/results/2000runs_2026-05-07T20-06-10-959Z.json). Methodology in [`bench/README.md`](./bench/README.md).

| Metric                               | Value     |
| ------------------------------------ | --------- |
| Run turnaround P50                   | 0.11 ms   |
| Run turnaround P95                   | 0.35 ms   |
| Run turnaround P99                   | 0.58 ms   |
| Run turnaround P999                  | 1.85 ms   |
| Run turnaround max                   | 2.16 ms   |
| Replay determinism (50 replays)      | 1.000     |
| Simulated cost per run (mean)        | $0.005700 |
| Simulated cost per run (P95)         | $0.007000 |
| Failures (budget / tool / infra DLQ) | 0 / 0 / 0 |

P50/P95 in microseconds, HDR-bucketed (~6% relative error per bucket). Source: same bench artifact above; sampled with `performance.now()` per step.

| tool     | P50 (us) | P95 (us) | samples |
| -------- | -------- | -------- | ------- |
| click    | 7        | 37       | 3200    |
| extract  | 8        | 23       | 2600    |
| finish   | 9        | 23       | 2000    |
| navigate | 10       | 27       | 2000    |
| type     | 8        | 26       | 1000    |
| wait     | 8        | 20       | 600     |

Read these as the loop+executor overhead floor — what the dispatcher adds on top of the model call. **Live runs are dominated by Anthropic latency** (1-3s per step at Sonnet 4.7) and **Playwright tool execution** (50-500ms per browser action). FakeLLM cost numbers are deterministic per scripted tool sequence; they exercise the cost-tracking code path but are not predictive of live spend. To run live: `ANTHROPIC_API_KEY=sk-... pnpm bench:cheap`.

### Regression gate

`pnpm bench-regress --baseline <path> --runs <n>` runs a fresh bench and compares against a committed baseline. Default mode gates on stable metrics only (per-flow mean steps, success rate, simulated cost) with a 30% drift threshold; `--strict` also gates on noisy metrics (turnaround latency, per-tool microsecond P50/P95). The CI `bench-regress` job runs at 50 runs/flow against the 2000-run baseline above.

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
| `packages/db`          | Drizzle schema, SQL migrations, in-memory and Postgres-backed stores.                                           |
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
   │   │ TokenBucket│  │ AgentLoop  │  │ Playwright       │ │
   │   │ per domain │─▶│ budgets +  │─▶│ Executor         │ │
   │   └────────────┘  │ retries    │  └──────┬───────────┘ │
   │                   └─────┬──────┘         │             │
   │                         ▼                ▼             │
   │                   ┌──────────┐    ┌────────────┐       │
   │                   │ Anthropic│    │ S3/MinIO   │       │
   │                   │ provider │    │ artifacts  │       │
   │                   │ (or Fake)│    └────────────┘       │
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

## How to run

### (a) Hermetic — no API key needed

The agent loop, executor, and store contracts all run against `FakeLLMProvider` and `ScriptedExecutor`. CI uses this path; locals can run it the same way.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm eval run --suite golden_v1 --provider fake
```

### (b) Live — requires `ANTHROPIC_API_KEY`

The dispatcher drives a real Chromium against the mock fastify sites under `tests/fixtures/sites/`. No real-internet sites — that opens evasion-test territory we don't want.

```sh
export ANTHROPIC_API_KEY=sk-...
pnpm exec playwright install --with-deps chromium
pnpm dispatcher start
```

The control-plane API enqueues runs onto the `runs` BullMQ queue; the dispatcher picks them up, applies per-tenant concurrency caps and per-domain rate limits, then runs the loop. Artifacts land in S3 (or MinIO for local).

## Reproducibility

The eval CLI runs the golden suite end-to-end through the agent loop using a `FakeLLMProvider` with scripted tool calls and a `ScriptedExecutor` that simulates DOM responses. CI runs a 3-flow subset on every push; the full suite is one command:

```sh
pnpm eval run --suite golden_v1
```

Replay a previous run from a captured trace:

```sh
pnpm --filter @pagerunner/runner replay path/to/trace.json
```

The replay script reports a `determinism` score in `[0, 1]` based on whether the replayed step sequence matches the recorded tools. The positional trace path and `--trace <path>` are equivalent. Replay uses the captured step count as its bound, so valid traces longer than the default live-run step budget can be verified. It uses a local fake provider with no simulated cost charge; live agent budget defaults remain unchanged.

## Design targets

These are targets the architecture is laid out to hit; numbers are not yet measured under load.

| Metric                                | Target                   |
| ------------------------------------- | ------------------------ |
| P95 run turnaround (≤20 actions)      | < 90s                    |
| Golden flow success rate (rolling 7d) | ≥ 95%                    |
| Per-run cost (live model)             | < $0.08                  |
| Replay determinism on cached DOM      | ≥ 98%                    |
| Step budget enforcement               | hard cap, never exceeded |

## Tests

- Unit: token-bucket math, DAG validator (cycles, unreachable, branches), retry policy decision table, idempotency, agent-loop budgets, SDK round-trip against a transient NestJS instance, SSE event-bus replay via `Last-Event-ID`, Anthropic provider against a mocked `fetch`.
- Integration (run by CI against postgres + redis + MinIO services): Drizzle-backed RunStore, BullMQ dispatcher end-to-end with `FakeLLMProvider`, S3 artifact upload round-trip, Playwright executor against the local mock site.
- Gated live: Anthropic provider + Playwright executor end-to-end run against the mock site, skipped when `ANTHROPIC_API_KEY` is unset.
- Coverage gate: 80% lines / statements in CI.

Run them with `pnpm test`.

## What this is not

- Not a hosted service. There is no auth layer, billing, or multi-region story.
- Not an evaluation framework for the underlying model. The CI eval uses a deterministic fake to catch loop regressions; live-model evaluation is a BYOK path.
- Not a low-code flow builder. Flows are JSON DAGs; the admin app is a read-only inspector.
- No proxy rotation, no captcha solving, no headful mode toggle, no anti-bot evasion.
- No real-internet integration tests. Mock sites under `tests/fixtures/sites/` are the contract.

## Known issues

See [ROADMAP.md](./ROADMAP.md) for deferred work and the order it lands.

## License

MIT — see [LICENSE](./LICENSE).
