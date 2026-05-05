import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBench } from './bench';

describe('bench harness', () => {
  jest.setTimeout(60_000);

  it('runs at small scale and emits a results JSON with expected keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pagerunner-bench-'));
    const out = join(dir, 'small.json');
    const result = await runBench({
      argv: ['--runs', '1', '--replays', '2', '--concurrency', '2', '--output', out],
    });
    expect(existsSync(out)).toBe(true);
    expect(result.outPath).toBe(out);
    const parsed = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
    for (const key of [
      'generatedAt',
      'provider',
      'model',
      'runsPerFlow',
      'totalRuns',
      'concurrency',
      'turnaroundMs',
      'perFlow',
      'perTool',
      'replayDeterminism',
      'simulatedCost',
      'failureBreakdown',
    ]) {
      expect(parsed).toHaveProperty(key);
    }
    expect(parsed['provider']).toBe('fake');
    expect(parsed['totalRuns']).toBe(10); // 1 run × 10 flows
    const perFlow = parsed['perFlow'] as Array<Record<string, unknown>>;
    expect(perFlow).toHaveLength(10);
    expect(result.stdout).toContain('pagerunner bench');
    expect(result.stdout).toContain('run turnaround');
    expect(result.stdout).toContain('per-tool latency');
  });

  it('errors clearly when --provider anthropic without API key', async () => {
    const prev = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      await expect(runBench({ argv: ['--provider', 'anthropic', '--runs', '1'] })).rejects.toThrow(
        /ANTHROPIC_API_KEY/,
      );
    } finally {
      if (prev !== undefined) process.env['ANTHROPIC_API_KEY'] = prev;
    }
  });
});
