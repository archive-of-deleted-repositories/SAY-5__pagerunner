import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runBenchRegress } from './bench-regress';

interface SummaryShape {
  generatedAt: string;
  totalRuns: number;
  turnaroundMs: { p50: number; p95: number; p99: number; p999: number; max: number };
  perFlow: Array<{ flowId: string; flowName: string; meanSteps: number; successRate: number }>;
  perTool: Array<{ tool: string; p50: number; p95: number; samples: number }>;
  simulatedCost: { meanPerRunUsd: number; p95PerRunUsd: number };
  failureBreakdown: { succeeded: number; budgetExceeded: number; toolFailed: number };
}

const baseSummary: SummaryShape = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  totalRuns: 2000,
  turnaroundMs: { p50: 1, p95: 2, p99: 3, p999: 4, max: 5 },
  perFlow: [
    { flowId: 'login', flowName: 'login', meanSteps: 6, successRate: 1 },
    { flowId: 'search', flowName: 'search', meanSteps: 5, successRate: 1 },
  ],
  perTool: [
    { tool: 'click', p50: 10, p95: 30, samples: 1000 },
    { tool: 'navigate', p50: 12, p95: 35, samples: 1000 },
  ],
  simulatedCost: { meanPerRunUsd: 0.005, p95PerRunUsd: 0.007 },
  failureBreakdown: { succeeded: 2000, budgetExceeded: 0, toolFailed: 0 },
};

describe('bench-regress', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'bench-regress-test-'));
  });

  it('flags zero offenders when fresh matches baseline exactly', async () => {
    const baselinePath = join(tmp, 'baseline.json');
    const freshPath = join(tmp, 'fresh.json');
    writeFileSync(baselinePath, JSON.stringify(baseSummary));
    writeFileSync(freshPath, JSON.stringify(baseSummary));

    const r = await runBenchRegress([
      '--baseline',
      baselinePath,
      '--fresh',
      freshPath,
      '--threshold',
      '30',
    ]);
    expect(r.offenders).toHaveLength(0);
    expect(r.report).toContain('offenders: 0');
  });

  it('default mode ignores noisy-bucket drift', async () => {
    const noisyOnly: SummaryShape = JSON.parse(JSON.stringify(baseSummary));
    // Latencies move 10x — well past 30%, but they are noisy bucket only.
    noisyOnly.turnaroundMs.p95 = 20;
    noisyOnly.perTool[0]!.p95 = 300;
    const baselinePath = join(tmp, 'baseline.json');
    const freshPath = join(tmp, 'fresh.json');
    writeFileSync(baselinePath, JSON.stringify(baseSummary));
    writeFileSync(freshPath, JSON.stringify(noisyOnly));
    const r = await runBenchRegress([
      '--baseline',
      baselinePath,
      '--fresh',
      freshPath,
      '--threshold',
      '30',
    ]);
    expect(r.offenders).toHaveLength(0);
  });

  it('strict mode flags noisy-bucket drift past threshold', async () => {
    const noisyOnly: SummaryShape = JSON.parse(JSON.stringify(baseSummary));
    noisyOnly.turnaroundMs.p95 = 20;
    const baselinePath = join(tmp, 'baseline.json');
    const freshPath = join(tmp, 'fresh.json');
    writeFileSync(baselinePath, JSON.stringify(baseSummary));
    writeFileSync(freshPath, JSON.stringify(noisyOnly));
    const r = await runBenchRegress([
      '--baseline',
      baselinePath,
      '--fresh',
      freshPath,
      '--threshold',
      '30',
      '--strict',
    ]);
    expect(r.offenders.map((o) => o.metric)).toContain('turnaround_p95_ms');
  });

  it('flags stable-bucket drift in default mode', async () => {
    const drifted: SummaryShape = JSON.parse(JSON.stringify(baseSummary));
    // Mean steps for the login flow goes 6 -> 9 = 50% drift.
    drifted.perFlow[0]!.meanSteps = 9;
    const baselinePath = join(tmp, 'baseline.json');
    const freshPath = join(tmp, 'fresh.json');
    writeFileSync(baselinePath, JSON.stringify(baseSummary));
    writeFileSync(freshPath, JSON.stringify(drifted));
    const r = await runBenchRegress([
      '--baseline',
      baselinePath,
      '--fresh',
      freshPath,
      '--threshold',
      '30',
    ]);
    expect(r.offenders.map((o) => o.metric)).toContain('flow[login].mean_steps');
  });

  it('treats threshold of 30% as inclusive (no offender at exactly 30%)', async () => {
    const at30: SummaryShape = JSON.parse(JSON.stringify(baseSummary));
    // 0.005 -> 0.0065 = exactly 30%
    at30.simulatedCost.meanPerRunUsd = 0.0065;
    const baselinePath = join(tmp, 'baseline.json');
    const freshPath = join(tmp, 'fresh.json');
    writeFileSync(baselinePath, JSON.stringify(baseSummary));
    writeFileSync(freshPath, JSON.stringify(at30));
    const r = await runBenchRegress([
      '--baseline',
      baselinePath,
      '--fresh',
      freshPath,
      '--threshold',
      '30',
    ]);
    expect(r.offenders).toHaveLength(0);
  });

  it('catches improvements that go past threshold (sign-agnostic)', async () => {
    const improved: SummaryShape = JSON.parse(JSON.stringify(baseSummary));
    // 100% improvement on cost
    improved.simulatedCost.meanPerRunUsd = 0;
    const baselinePath = join(tmp, 'baseline.json');
    const freshPath = join(tmp, 'fresh.json');
    writeFileSync(baselinePath, JSON.stringify(baseSummary));
    writeFileSync(freshPath, JSON.stringify(improved));
    const r = await runBenchRegress([
      '--baseline',
      baselinePath,
      '--fresh',
      freshPath,
      '--threshold',
      '30',
    ]);
    expect(r.offenders.map((o) => o.metric)).toContain('simulated_cost_mean_per_run_usd');
  });
});
