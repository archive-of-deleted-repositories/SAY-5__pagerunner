/* eslint-disable no-console */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runAgent } from '../apps/runner/src/agent/loop.js';
import { FakeLLMProvider } from '../apps/runner/src/agent/fake-llm.js';
import { ScriptedExecutor } from '../apps/runner/src/agent/scripted-executor.js';
import type { ToolCall } from '../packages/agent-tools/src/index.js';
import { ToolLatencyRegistry } from '../packages/shared/src/hdr.js';

const FLOWS_DIR = join(process.cwd(), 'eval/flows');
const RESULTS_DIR = join(process.cwd(), 'bench/results');

const DEFAULT_RUNS_PER_FLOW = 100;
const DEFAULT_REPLAYS = 50;
const DEFAULT_CONCURRENCY = 8;

interface FlowSpec {
  id: string;
  name: string;
  suite: string;
  script: ToolCall[];
  setup?: { extract?: Record<string, string>; failFirst?: string[] };
}

interface JobSpec {
  jobId: number;
  flow: FlowSpec;
}

interface StepSample {
  tool: string;
  latencyUs: number;
}

interface RunSample {
  jobId: number;
  flowId: string;
  flowName: string;
  status: 'succeeded' | 'failed' | 'budget_exceeded' | 'cancelled' | 'dlq';
  errorCode?: string;
  steps: number;
  toolSeq: string[];
  latencyMs: number;
  costUsd: number;
  perStep: StepSample[];
}

interface CliArgs {
  runsPerFlow: number;
  replays: number;
  concurrency: number;
  provider: 'fake' | 'anthropic';
  model: string | undefined;
  outPath: string | undefined;
  scaleSmokeTest: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const provider = (get('--provider') as 'fake' | 'anthropic' | undefined) ?? 'fake';
  const runsArg = get('--runs') ?? process.env['BENCH_RUNS_PER_FLOW'];
  const replaysArg = get('--replays') ?? process.env['BENCH_REPLAYS'];
  const concurrencyArg = get('--concurrency') ?? process.env['BENCH_CONCURRENCY'];
  const args: CliArgs = {
    runsPerFlow: runsArg ? Number(runsArg) : DEFAULT_RUNS_PER_FLOW,
    replays: replaysArg ? Number(replaysArg) : DEFAULT_REPLAYS,
    concurrency: concurrencyArg ? Number(concurrencyArg) : DEFAULT_CONCURRENCY,
    provider,
    model: get('--model'),
    outPath: get('--output'),
    scaleSmokeTest: argv.includes('--smoke'),
  };
  if (args.scaleSmokeTest) {
    args.runsPerFlow = 10;
    args.replays = 5;
  }
  return args;
}

function loadGoldenFlows(): FlowSpec[] {
  const files = readdirSync(FLOWS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const flows: FlowSpec[] = [];
  for (const f of files) {
    const data = JSON.parse(readFileSync(join(FLOWS_DIR, f), 'utf8')) as FlowSpec;
    flows.push(data);
  }
  return flows;
}

function buildExecutor(flow: FlowSpec): ScriptedExecutor {
  const ex = new ScriptedExecutor();
  if (flow.setup?.extract) {
    for (const [k, v] of Object.entries(flow.setup.extract)) ex.setExtract(k, v);
  }
  if (flow.setup?.failFirst) {
    for (const sel of flow.setup.failFirst) ex.failNextOn(sel);
  }
  return ex;
}

async function runOne(flow: FlowSpec): Promise<{
  status: RunSample['status'];
  errorCode?: string;
  perStep: StepSample[];
  toolSeq: string[];
  costUsd: number;
}> {
  const llm = new FakeLLMProvider(flow.script);
  const executor = buildExecutor(flow);
  const perStep: StepSample[] = [];
  const result = await runAgent({
    llm,
    executor,
    sleep: async () => undefined,
    onStep: (s) => {
      perStep.push({ tool: s.tool, latencyUs: s.latencyUs });
    },
  });
  const sample: {
    status: RunSample['status'];
    errorCode?: string;
    perStep: StepSample[];
    toolSeq: string[];
    costUsd: number;
  } = {
    status: result.status,
    perStep,
    toolSeq: result.steps.map((s) => s.tool),
    costUsd: result.totalCostUsd,
  };
  if (result.errorCode) sample.errorCode = result.errorCode;
  return sample;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? 0;
  return a + (b - a) * (pos - lo);
}

interface RunPool {
  next(): JobSpec | undefined;
}

function makePool(jobs: JobSpec[]): RunPool {
  let i = 0;
  return {
    next: () => (i < jobs.length ? jobs[i++] : undefined),
  };
}

async function drainPool(
  pool: RunPool,
  concurrency: number,
  onComplete: (sample: RunSample, dequeueAtMs: number) => void,
): Promise<void> {
  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push(
      (async () => {
        while (true) {
          const job = pool.next();
          if (!job) return;
          // Approximates "queue-pull → terminal state": measure from the moment
          // the worker dequeues the job to the moment the run reaches terminal.
          const start = performance.now();
          let res: Awaited<ReturnType<typeof runOne>> | undefined;
          let caught: unknown;
          try {
            res = await runOne(job.flow);
          } catch (e) {
            caught = e;
          }
          const end = performance.now();
          if (caught) {
            const errorCode =
              typeof caught === 'object' && caught !== null && 'code' in caught
                ? String((caught as { code: unknown }).code)
                : 'UNKNOWN';
            const sample: RunSample = {
              jobId: job.jobId,
              flowId: job.flow.id,
              flowName: job.flow.name,
              status: 'failed',
              errorCode,
              steps: 0,
              toolSeq: [],
              latencyMs: end - start,
              costUsd: 0,
              perStep: [],
            };
            onComplete(sample, start);
            continue;
          }
          if (!res) continue;
          const sample: RunSample = {
            jobId: job.jobId,
            flowId: job.flow.id,
            flowName: job.flow.name,
            status: res.status,
            steps: res.toolSeq.length,
            toolSeq: res.toolSeq,
            latencyMs: end - start,
            costUsd: res.costUsd,
            perStep: res.perStep,
          };
          if (res.errorCode) sample.errorCode = res.errorCode;
          onComplete(sample, start);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

function classifyFailure(
  sample: RunSample,
): 'succeeded' | 'budget_exceeded' | 'tool_failed' | 'infra_dlq' {
  if (sample.status === 'succeeded') return 'succeeded';
  const code = sample.errorCode ?? 'UNKNOWN';
  if (
    code === 'STEP_BUDGET_EXCEEDED' ||
    code === 'COST_BUDGET_EXCEEDED' ||
    code === 'WALLCLOCK_BUDGET_EXCEEDED' ||
    code === 'TOKEN_BUDGET_EXCEEDED'
  ) {
    return 'budget_exceeded';
  }
  if (code === 'INFRA' || code === 'INFRA_ERROR' || code === 'UPSTREAM_ERROR') {
    return 'infra_dlq';
  }
  return 'tool_failed';
}

interface BenchSummary {
  generatedAt: string;
  provider: 'fake' | 'anthropic';
  model: string;
  runsPerFlow: number;
  totalRuns: number;
  concurrency: number;
  turnaroundMs: { p50: number; p95: number; p99: number; p999: number; max: number };
  perFlow: Array<{ flowId: string; flowName: string; meanSteps: number; successRate: number }>;
  /**
   * Per-tool step latency. P50/P95 are HDR-bucketed microseconds (~6%
   * relative error per bucket). `latencyUnit` is always `us`.
   */
  perTool: Array<{ tool: string; p50: number; p95: number; samples: number; latencyUnit: 'us' }>;
  replayDeterminism: { score: number; samples: number };
  simulatedCost: { meanPerRunUsd: number; p95PerRunUsd: number };
  failureBreakdown: {
    succeeded: number;
    budgetExceeded: number;
    toolFailed: number;
    infraDlq: number;
  };
}

function summarize(samples: RunSample[], replayScore: number, args: CliArgs): BenchSummary {
  const turnaround = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  // Per-tool latency aggregates through the HDR registry. The agent loop
  // already emits integer microseconds per step (sampled with
  // `performance.now()`), so we just record into the histogram and read back
  // P50/P95 at summary time. ~6% relative-error per bucket; documented in the
  // README caption.
  const registry = new ToolLatencyRegistry();
  for (const s of samples) {
    for (const step of s.perStep) registry.record(step.tool, step.latencyUs);
  }
  const perTool = registry
    .snapshot([0.5, 0.95])
    .map((row) => ({
      tool: row.tool,
      p50: Math.round(row.percentilesUs[0.5] ?? 0),
      p95: Math.round(row.percentilesUs[0.95] ?? 0),
      samples: row.samples,
      latencyUnit: 'us' as const,
    }))
    .sort((a, b) => a.tool.localeCompare(b.tool));

  const flowGroups = new Map<string, RunSample[]>();
  for (const s of samples) {
    const arr = flowGroups.get(s.flowId);
    if (arr) arr.push(s);
    else flowGroups.set(s.flowId, [s]);
  }
  const perFlow = Array.from(flowGroups.entries())
    .map(([flowId, list]) => {
      const succeeded = list.filter((x) => x.status === 'succeeded');
      const meanSteps =
        succeeded.length === 0 ? 0 : succeeded.reduce((a, x) => a + x.steps, 0) / succeeded.length;
      return {
        flowId,
        flowName: list[0]?.flowName ?? flowId,
        meanSteps: Number(meanSteps.toFixed(2)),
        successRate: Number((succeeded.length / list.length).toFixed(4)),
      };
    })
    .sort((a, b) => a.flowId.localeCompare(b.flowId));

  const succeededSamples = samples.filter((s) => s.status === 'succeeded');
  const sortedCost = succeededSamples.map((s) => s.costUsd).sort((a, b) => a - b);
  const meanCost =
    sortedCost.length === 0 ? 0 : sortedCost.reduce((a, b) => a + b, 0) / sortedCost.length;

  let countedSucc = 0;
  let countedBudget = 0;
  let countedTool = 0;
  let countedInfra = 0;
  for (const s of samples) {
    const cls = classifyFailure(s);
    if (cls === 'succeeded') countedSucc += 1;
    else if (cls === 'budget_exceeded') countedBudget += 1;
    else if (cls === 'tool_failed') countedTool += 1;
    else countedInfra += 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    provider: args.provider,
    model: args.model ?? (args.provider === 'fake' ? 'fake-llm' : 'claude-sonnet'),
    runsPerFlow: args.runsPerFlow,
    totalRuns: samples.length,
    concurrency: args.concurrency,
    turnaroundMs: {
      p50: round2(quantile(turnaround, 0.5)),
      p95: round2(quantile(turnaround, 0.95)),
      p99: round2(quantile(turnaround, 0.99)),
      p999: round2(quantile(turnaround, 0.999)),
      max: round2(turnaround[turnaround.length - 1] ?? 0),
    },
    perFlow,
    perTool,
    replayDeterminism: { score: Number(replayScore.toFixed(4)), samples: 0 },
    simulatedCost: {
      meanPerRunUsd: round6(meanCost),
      p95PerRunUsd: round6(quantile(sortedCost, 0.95)),
    },
    failureBreakdown: {
      succeeded: countedSucc,
      budgetExceeded: countedBudget,
      toolFailed: countedTool,
      infraDlq: countedInfra,
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

async function measureReplayDeterminism(
  samples: RunSample[],
  replays: number,
  flowsById: Map<string, FlowSpec>,
): Promise<{ score: number; samples: number }> {
  const succeeded = samples.filter((s) => s.status === 'succeeded');
  if (succeeded.length === 0 || replays === 0) {
    return { score: 1, samples: 0 };
  }
  const pickCount = Math.min(replays, succeeded.length);
  // Sample without replacement, deterministic order: every Nth completed run.
  const stride = Math.max(1, Math.floor(succeeded.length / pickCount));
  let drift = 0;
  let total = 0;
  let used = 0;
  for (let i = 0; i < succeeded.length && used < pickCount; i += stride) {
    const original = succeeded[i];
    if (!original) continue;
    const flow = flowsById.get(original.flowId);
    if (!flow) continue;
    const replay = await runOne(flow);
    const len = Math.max(original.toolSeq.length, replay.toolSeq.length);
    for (let k = 0; k < len; k++) {
      total += 1;
      if (original.toolSeq[k] !== replay.toolSeq[k]) drift += 1;
    }
    used += 1;
  }
  const score = total === 0 ? 1 : 1 - drift / total;
  return { score, samples: used };
}

function pad(s: string | number, width: number): string {
  const str = String(s);
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}

function rpad(s: string | number, width: number): string {
  return pad(s, width);
}

function formatStdout(summary: BenchSummary): string {
  const lines: string[] = [];
  lines.push(`# pagerunner bench — ${summary.totalRuns} runs (${summary.runsPerFlow} × 10 flows)`);
  lines.push(
    `# ${summary.generatedAt}, provider=${summary.provider}, model=${summary.model}, concurrency=${summary.concurrency}`,
  );
  lines.push('## run turnaround (ms, queue-pull to terminal)');
  lines.push(
    `${rpad('p50', 7)}${rpad('p95', 7)}${rpad('p99', 7)}${rpad('p999', 7)}${rpad('max', 7)}`,
  );
  const t = summary.turnaroundMs;
  lines.push(
    `${rpad(t.p50, 7)}${rpad(t.p95, 7)}${rpad(t.p99, 7)}${rpad(t.p999, 7)}${rpad(t.max, 7)}`,
  );
  lines.push('## steps to success (mean, by flow)');
  lines.push(`${rpad('flow_name', 48)}${rpad('mean_steps', 12)}success_rate`);
  for (const f of summary.perFlow) {
    const pct = (f.successRate * 100).toFixed(1) + '%';
    lines.push(`${rpad(f.flowName, 48)}${rpad(f.meanSteps.toFixed(1), 12)}${pct}`);
  }
  lines.push('## per-tool latency (us, all flows; HDR-bucketed, ~6% relative error)');
  lines.push(`${rpad('tool', 10)}${rpad('p50_us', 10)}${rpad('p95_us', 10)}samples`);
  for (const t2 of summary.perTool) {
    lines.push(`${rpad(t2.tool, 10)}${rpad(t2.p50, 10)}${rpad(t2.p95, 10)}${t2.samples}`);
  }
  lines.push(
    `## replay determinism (${summary.replayDeterminism.samples} replays of completed runs)`,
  );
  lines.push(`score: ${summary.replayDeterminism.score.toFixed(3)}`);
  lines.push('## simulated cost (FakeProvider — exercises cost-tracking code path only)');
  lines.push(`mean_per_run_usd : $${summary.simulatedCost.meanPerRunUsd.toFixed(6)}`);
  lines.push(`p95_per_run_usd  : $${summary.simulatedCost.p95PerRunUsd.toFixed(6)}`);
  lines.push('## failure breakdown');
  lines.push(`succeeded           : ${summary.failureBreakdown.succeeded}`);
  lines.push(`budget_exceeded     : ${summary.failureBreakdown.budgetExceeded}`);
  lines.push(`tool_failed         : ${summary.failureBreakdown.toolFailed}`);
  lines.push(`infra_dlq           : ${summary.failureBreakdown.infraDlq}`);
  lines.push(
    '# Local-machine numbers on M-series Mac, FakeLLMProvider against in-process mock executor.',
  );
  lines.push('# Live (BYOK) numbers via `pnpm bench:cheap` once ANTHROPIC_API_KEY is set.');
  lines.push('# See bench/README.md for methodology.');
  return lines.join('\n') + '\n';
}

export interface RunBenchOptions {
  argv?: string[];
}

export interface RunBenchResult {
  summary: BenchSummary;
  outPath: string;
  stdout: string;
}

export async function runBench(opts: RunBenchOptions = {}): Promise<RunBenchResult> {
  const args = parseArgs(opts.argv ?? process.argv.slice(2));

  if (args.provider === 'anthropic') {
    if (!process.env['ANTHROPIC_API_KEY']) {
      throw new Error('ANTHROPIC_API_KEY required for --provider anthropic');
    }
    // The live BYOK path drives the dispatcher against the mock fastify
    // sites; the FakeLLM bench in this file does not reach the network.
    // The live harness is intentionally out of scope until the eval runner
    // wires through the queue (see ROADMAP.md item 5).
    throw new Error(
      '--provider anthropic bench is not wired yet; see ROADMAP.md item 5. ' +
        'For now use the FakeLLM bench: `pnpm bench`.',
    );
  }

  const flows = loadGoldenFlows();
  if (flows.length === 0) throw new Error('no golden flows found');
  const flowsById = new Map(flows.map((f) => [f.id, f]));

  const jobs: JobSpec[] = [];
  let id = 0;
  for (const flow of flows) {
    for (let i = 0; i < args.runsPerFlow; i++) {
      jobs.push({ jobId: id++, flow });
    }
  }
  // Deterministic interleave: round-robin so per-tenant fairness shows up
  // even at low concurrency. We sort by jobId-mod-flowCount.
  jobs.sort((a, b) => {
    const ai = a.jobId % flows.length;
    const bi = b.jobId % flows.length;
    if (ai !== bi) return ai - bi;
    return a.jobId - b.jobId;
  });

  const samples: RunSample[] = [];
  const pool = makePool(jobs);
  await drainPool(pool, args.concurrency, (s) => {
    samples.push(s);
  });

  const replay = await measureReplayDeterminism(samples, args.replays, flowsById);
  const summary = summarize(samples, replay.score, args);
  summary.replayDeterminism.samples = replay.samples;

  const stamp = summary.generatedAt.replace(/[:.]/g, '-');
  const outPath = args.outPath ?? join(RESULTS_DIR, `${stamp}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');

  const stdout = formatStdout(summary);
  return { summary, outPath, stdout };
}

const isMain = (): boolean => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return argv1.endsWith('bench/bench.ts') || argv1.endsWith('bench.ts');
};

if (isMain()) {
  runBench()
    .then((r) => {
      process.stdout.write(r.stdout);
      process.stdout.write(`# results: ${r.outPath}\n`);
    })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(msg);
      process.exit(1);
    });
}
