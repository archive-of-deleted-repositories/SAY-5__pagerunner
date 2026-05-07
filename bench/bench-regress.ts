/* eslint-disable no-console */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runBench } from './bench.js';

/**
 * Bench regression gate. Runs a fresh bench at small scale (configurable via
 * --runs) and compares headline metrics against a committed baseline.
 *
 * Metrics are classified into two buckets:
 *
 *   - "stable": deterministic under FakeLLMProvider (mean steps per flow,
 *     success rate, simulated cost). These gate the regression check.
 *   - "noisy": wall-clock latencies that depend on the runner machine's
 *     load (turnaroundMs, perTool.p50/p95). These are reported in the
 *     Markdown table but do not gate by default. Pass `--strict` to fail
 *     the build when *any* metric drifts past --threshold (used for the
 *     2000-run baseline check, where latencies are stable enough to gate).
 *
 * Exit code 0 = within threshold. Exit code 1 = drift detected.
 * The Markdown report is always printed to stdout.
 */

interface BenchSummaryShape {
  generatedAt: string;
  totalRuns: number;
  turnaroundMs: { p50: number; p95: number; p99: number; p999: number; max: number };
  perFlow: Array<{ flowId: string; flowName: string; meanSteps: number; successRate: number }>;
  perTool: Array<{ tool: string; p50: number; p95: number; samples: number }>;
  simulatedCost: { meanPerRunUsd: number; p95PerRunUsd: number };
  failureBreakdown: { succeeded: number; budgetExceeded: number; toolFailed: number };
}

interface CliArgs {
  baselinePath: string;
  freshPath: string | undefined;
  runs: number;
  thresholdPct: number;
  reportPath: string | undefined;
  strict: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const baselinePath = get('--baseline');
  if (!baselinePath) {
    throw new Error('--baseline <path> is required');
  }
  return {
    baselinePath,
    freshPath: get('--fresh'),
    runs: Number(get('--runs') ?? '50'),
    thresholdPct: Number(get('--threshold') ?? '30'),
    reportPath: get('--report'),
    strict: argv.includes('--strict'),
  };
}

interface DriftRow {
  metric: string;
  bucket: 'stable' | 'noisy';
  baseline: number;
  fresh: number;
  driftPct: number;
}

function pctChange(baseline: number, fresh: number): number {
  if (baseline === 0 && fresh === 0) return 0;
  if (baseline === 0) return Infinity;
  return ((fresh - baseline) / baseline) * 100;
}

function compare(baseline: BenchSummaryShape, fresh: BenchSummaryShape): DriftRow[] {
  const rows: DriftRow[] = [];
  const push = (metric: string, bucket: DriftRow['bucket'], b: number, f: number): void => {
    rows.push({ metric, bucket, baseline: b, fresh: f, driftPct: pctChange(b, f) });
  };
  // Stable metrics — deterministic under FakeLLMProvider.
  push(
    'simulated_cost_mean_per_run_usd',
    'stable',
    baseline.simulatedCost.meanPerRunUsd,
    fresh.simulatedCost.meanPerRunUsd,
  );
  const baselineFlows = new Map(baseline.perFlow.map((f) => [f.flowId, f]));
  for (const flow of fresh.perFlow) {
    const b = baselineFlows.get(flow.flowId);
    if (!b) continue;
    push(`flow[${flow.flowId}].mean_steps`, 'stable', b.meanSteps, flow.meanSteps);
    push(`flow[${flow.flowId}].success_rate`, 'stable', b.successRate, flow.successRate);
  }
  // Noisy metrics — depend on runner-machine load.
  push('turnaround_p50_ms', 'noisy', baseline.turnaroundMs.p50, fresh.turnaroundMs.p50);
  push('turnaround_p95_ms', 'noisy', baseline.turnaroundMs.p95, fresh.turnaroundMs.p95);
  push('turnaround_p99_ms', 'noisy', baseline.turnaroundMs.p99, fresh.turnaroundMs.p99);
  const baselineTools = new Map(baseline.perTool.map((t) => [t.tool, t]));
  for (const tool of fresh.perTool) {
    const b = baselineTools.get(tool.tool);
    if (!b) continue;
    push(`tool[${tool.tool}].p50_us`, 'noisy', b.p50, tool.p50);
    push(`tool[${tool.tool}].p95_us`, 'noisy', b.p95, tool.p95);
  }
  return rows;
}

function formatReport(
  baseline: BenchSummaryShape,
  fresh: BenchSummaryShape,
  rows: DriftRow[],
  thresholdPct: number,
  strict: boolean,
  offenders: DriftRow[],
): string {
  const lines: string[] = [];
  lines.push('# bench-regress report');
  lines.push('');
  lines.push(`- baseline_generated_at: ${baseline.generatedAt}`);
  lines.push(`- baseline_total_runs: ${baseline.totalRuns}`);
  lines.push(`- fresh_generated_at: ${fresh.generatedAt}`);
  lines.push(`- fresh_total_runs: ${fresh.totalRuns}`);
  lines.push(`- threshold_pct: ${thresholdPct}`);
  lines.push(`- mode: ${strict ? 'strict (gates noisy + stable)' : 'default (gates stable only)'}`);
  lines.push(`- offenders: ${offenders.length}`);
  lines.push('');
  lines.push('| metric | bucket | baseline | fresh | drift_pct |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const driftStr = Number.isFinite(r.driftPct) ? r.driftPct.toFixed(1) : 'inf';
    lines.push(`| ${r.metric} | ${r.bucket} | ${r.baseline} | ${r.fresh} | ${driftStr} |`);
  }
  if (offenders.length > 0) {
    lines.push('');
    lines.push('## offenders (|drift_pct| > threshold)');
    for (const r of offenders) {
      const driftStr = Number.isFinite(r.driftPct) ? r.driftPct.toFixed(1) : 'inf';
      lines.push(`- ${r.metric} (${r.bucket}): ${r.baseline} -> ${r.fresh} (${driftStr}%)`);
    }
  }
  return lines.join('\n') + '\n';
}

export interface RegressResult {
  baseline: BenchSummaryShape;
  fresh: BenchSummaryShape;
  rows: DriftRow[];
  offenders: DriftRow[];
  thresholdPct: number;
  strict: boolean;
  report: string;
}

export async function runBenchRegress(argv: string[]): Promise<RegressResult> {
  const args = parseArgs(argv);
  const baseline = JSON.parse(readFileSync(args.baselinePath, 'utf8')) as BenchSummaryShape;

  let fresh: BenchSummaryShape;
  if (args.freshPath) {
    fresh = JSON.parse(readFileSync(args.freshPath, 'utf8')) as BenchSummaryShape;
  } else {
    const tmpDir = mkdtempSync(join(tmpdir(), 'bench-regress-'));
    const outPath = join(tmpDir, 'fresh.json');
    const result = await runBench({
      argv: ['--runs', String(args.runs), '--replays', '0', '--output', outPath],
    });
    fresh = result.summary as unknown as BenchSummaryShape;
  }

  const rows = compare(baseline, fresh);
  const candidates = args.strict ? rows : rows.filter((r) => r.bucket === 'stable');
  const offenders = candidates.filter((r) => Math.abs(r.driftPct) > args.thresholdPct);
  const report = formatReport(baseline, fresh, rows, args.thresholdPct, args.strict, offenders);
  if (args.reportPath) writeFileSync(args.reportPath, report);
  return {
    baseline,
    fresh,
    rows,
    offenders,
    thresholdPct: args.thresholdPct,
    strict: args.strict,
    report,
  };
}

const isMain = (): boolean => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return argv1.endsWith('bench-regress.ts') || argv1.endsWith('bench-regress.js');
};

if (isMain()) {
  runBenchRegress(process.argv.slice(2))
    .then((r) => {
      process.stdout.write(r.report);
      if (r.offenders.length > 0) {
        process.stderr.write(
          `bench-regress: ${r.offenders.length} metrics drifted > ${r.thresholdPct}%\n`,
        );
        process.exit(1);
      }
    })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(msg);
      process.exit(1);
    });
}
