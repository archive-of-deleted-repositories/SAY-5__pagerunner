# Roadmap

Concrete deferred work. Items are listed in priority order. The CI eval today
runs the loop against a `FakeLLMProvider` and a `ScriptedExecutor`; everything
below is what the gap to live behavior looks like.

## 1. BullMQ → Anthropic → Playwright dispatcher (highest priority)

**What.** Replace the placeholder in `apps/runner/src/agent/dispatch.ts` with
the real consumer: BullMQ worker pulls a run job, loads the flow + inputs from
the DB, instantiates an Anthropic client, opens a Playwright browser context,
and feeds both into `runAgent`.

**Why deferred.** Sprint 0 is the loop, executor, retry policy, budgets, and
golden-flow regression suite. Those work without any network. The dispatcher
adds three external dependencies (Redis worker contract, Anthropic API,
Playwright browser lifecycle) and is not testable hermetically; landing it
before the loop is solid would conflate model regressions with loop
regressions.

**What changes when it lands.**

- The eval CLI grows a `--provider anthropic` path that requires
  `ANTHROPIC_API_KEY` and reports real per-flow latency, real cost, and
  real success rate against the mock sites under `tests/fixtures/sites/`.
- The README results table grows a "Live" column.
- `eval-smoke` in CI stays on the fake provider; live runs are opt-in via a
  separate workflow with `secrets.ANTHROPIC_API_KEY`.

## 2. Drizzle-backed `RunStore` / `FlowStore`

**What.** Today the control-plane stores flows and runs in process memory. The
Drizzle schema and migrations already exist under `packages/db/`; the swap is
implementation, not design.

**What changes when it lands.** Restarts stop dropping in-flight runs;
horizontal scaling of the control plane becomes possible.

## 3. Local-mock-site integration tests in CI

**What.** `tests/fixtures/sites/server.ts` is a Fastify app with deterministic
responses. The integration suite that drives Playwright against it runs locally
under `RUN_INTEGRATION=1` but is not gated in CI.

**Why deferred.** Browser binaries and per-test browser launches push the CI
budget; we want them gated behind a separate workflow rather than the main
required check.

**What changes when it lands.** A second CI job runs the full mock-site suite
on every push to `main`, separate from `eval-smoke`.

## 4. Live distributed cancellation via Redis pub/sub

**What.** Cancelling a run today flips an in-process flag. With multiple runner
replicas, cancellation needs to hop processes. The plan is a Redis channel keyed
on `run_id`; each runner subscribes on job start and unsubscribes on
completion.

**What changes when it lands.** `DELETE /runs/:id` propagates within one heartbeat
across all replicas; cooperative cancellation tests in the loop become
end-to-end.

## 5. Real-internet flows — out of scope

We will not run the eval against live websites. Mock sites under
`tests/fixtures/sites/` are the contract. Real sites churn, break determinism,
and turn loop regressions into "did Amazon change their checkout" debates.
