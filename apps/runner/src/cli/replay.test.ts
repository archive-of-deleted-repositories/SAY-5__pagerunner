import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runAgent } from '../agent/loop';
import { FakeLLMProvider } from '../agent/fake-llm';
import { ScriptedExecutor } from '../agent/scripted-executor';
import { verifyTrace, formatMarkdownReport, type RunTrace } from './replay';
import type { ToolCall } from '@pagerunner/agent-tools';

/**
 * Replay verifier round-trip: drive a real run with FakeLLM + ScriptedExecutor,
 * snapshot the (tool, input, output) per step into a trace, then run the
 * verifier and assert determinism_score == 1.0. Then mutate one step's
 * recorded output and re-verify; the verifier should report drift.
 */

const buildScript = (): ToolCall[] => [
  { tool: 'navigate', input: { url: 'http://example.test/login' } },
  { tool: 'type', input: { selector: '#user', text: 'alice' } },
  { tool: 'click', input: { selector: '#submit' } },
  { tool: 'extract', input: { selector: '#profile-name' } },
  { tool: 'finish', input: { result: { ok: true } } },
];

const captureTrace = async (script: ToolCall[]): Promise<RunTrace> => {
  const llm = new FakeLLMProvider(script, 0);
  const executor = new ScriptedExecutor();
  const captured: Array<{ idx: number; domAfter: string }> = [];
  const result = await runAgent({
    llm,
    executor,
    budget: { maxSteps: script.length },
    onStep: (step, cap) => captured.push({ idx: step.idx, domAfter: cap.domAfter }),
  });
  return {
    runId: 'run_test_replay',
    flowId: 'flow_test_replay',
    flowVersion: 1,
    steps: result.steps.map((s, i) => ({
      idx: s.idx,
      tool: s.tool,
      input: s.input,
      output: s.output ?? {},
      domAfter: captured[i]?.domAfter ?? '',
    })),
  };
};

describe('replay CLI verifier', () => {
  it('reports determinism_score == 1.0 for an unmodified trace', async () => {
    const script = buildScript();
    const trace = await captureTrace(script);
    const report = await verifyTrace(trace);
    expect(report.replaysMatch).toBe(true);
    expect(report.determinismScore).toBe(1);
    expect(report.driftCount).toBe(0);
    expect(report.recordedStepCount).toBe(report.replayedStepCount);
  });

  it.each([21, 501])(
    'replays a captured %i-step run beyond live-run default budgets',
    async (steps) => {
      const script: ToolCall[] = [
        ...Array.from(
          { length: steps - 1 },
          (_, index): ToolCall => ({
            tool: 'click',
            input: { selector: `#step-${index}` },
          }),
        ),
        { tool: 'finish', input: { result: { ok: true } } },
      ];
      const trace = await captureTrace(script);
      expect(trace.steps).toHaveLength(steps);
      const report = await verifyTrace(trace);
      expect(report.replayedStepCount).toBe(steps);
      expect(report.replaysMatch).toBe(true);
      expect(report.determinismScore).toBe(1);
    },
  );

  it('reports output_mismatch when one step output is tampered', async () => {
    const script = buildScript();
    const trace = await captureTrace(script);
    const tampered: RunTrace = {
      ...trace,
      steps: trace.steps.map((s, i) =>
        i === 3 ? { ...s, output: { ...s.output, value: 'TAMPERED_VALUE' } } : s,
      ),
    };
    const report = await verifyTrace(tampered);
    expect(report.replaysMatch).toBe(false);
    expect(report.determinismScore).toBeLessThan(1);
    expect(report.driftCount).toBe(1);
    expect(report.drifts[0]?.idx).toBe(3);
    expect(report.drifts[0]?.reason).toBe('output_mismatch');
  });

  it('reports drift when one step tool is replaced by extract', async () => {
    const script = buildScript();
    const trace = await captureTrace(script);
    // Replace step 2's tool with extract over a selector that yields a
    // different output shape from the original click step. The FakeLLM
    // re-scripts on the tampered tool; the loop validates and runs
    // extract; the recorded output (click's `{selector, ok}`) won't
    // match the replayed extract output (`{selector, value}`).
    const tampered: RunTrace = {
      ...trace,
      steps: trace.steps.map((s, i) =>
        i === 2 ? { ...s, tool: 'extract', input: { selector: '#submit' } } : s,
      ),
    };
    const report = await verifyTrace(tampered);
    expect(report.replaysMatch).toBe(false);
    expect(report.determinismScore).toBeLessThan(1);
    // The recorded input has no `multiple` field; schema parse adds
    // `multiple: false`, so step 2 surfaces input_mismatch first.
    expect(report.drifts.find((d) => d.idx === 2)).toBeTruthy();
  });

  it('reports input_mismatch when one step input gains an unrecorded field', async () => {
    const script = buildScript();
    const trace = await captureTrace(script);
    const tampered: RunTrace = {
      ...trace,
      steps: trace.steps.map((s, i) =>
        i === 0 ? { ...s, input: { ...s.input, sneakyField: 'should_not_be_here' } } : s,
      ),
    };
    const report = await verifyTrace(tampered);
    // Schemas use `.parse` which strips unknown fields, so the loop's
    // validated input drops `sneakyField`. The recorded input has it,
    // so the comparison flags input_mismatch at step 0.
    expect(report.replaysMatch).toBe(false);
    expect(report.drifts.find((d) => d.idx === 0)?.reason).toBe('input_mismatch');
  });

  it('formatMarkdownReport renders deterministic output when drift exists', async () => {
    const trace = await captureTrace(buildScript());
    const tampered: RunTrace = {
      ...trace,
      steps: trace.steps.map((s, i) =>
        i === 0 ? { ...s, output: { ...s.output, url: 'http://drifted.test/' } } : s,
      ),
    };
    const report = await verifyTrace(tampered);
    const md = formatMarkdownReport(report);
    expect(md).toContain('replays_match: false');
    expect(md).toContain('drift_count: 1');
    expect(md).toContain('## drifts');
    expect(md).toContain('output_mismatch');
  });

  it('handles an empty trace as determinism_score == 1.0', async () => {
    const trace: RunTrace = {
      runId: 'r',
      flowId: 'f',
      flowVersion: 1,
      steps: [],
    };
    const report = await verifyTrace(trace);
    expect(report.determinismScore).toBe(1);
    expect(report.replaysMatch).toBe(true);
  });
});

describe('replay CLI process', () => {
  let directory: string;
  let tracePath: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pagerunner-replay-test-'));
    tracePath = join(directory, 'captured trace.json');
    writeFileSync(tracePath, JSON.stringify(await captureTrace(buildScript())));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const invoke = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [require.resolve('tsx/cli'), resolve(__dirname, 'replay.ts'), ...args],
      { encoding: 'utf8', timeout: 10_000 },
    );

  it('accepts the documented positional trace path', () => {
    const result = invoke(tracePath);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('replays_match: true');
    expect(result.stdout).toContain('determinism_score: 1.0000');
  });

  it('preserves named trace, report and quiet options', () => {
    const reportPath = join(directory, 'report.md');
    const result = invoke('--report', reportPath, '--no-stdout', '--trace', tracePath);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(readFileSync(reportPath, 'utf8')).toContain('replays_match: true');
  });

  it.each([['--trace'], ['--report'], ['--unknown']])(
    'rejects malformed arguments %j as usage errors',
    (...args) => {
      const result = invoke(...args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('usage:');
    },
  );

  it('rejects ambiguous trace paths instead of ignoring one', () => {
    const result = invoke('--trace', tracePath, tracePath);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage:');
  });
});
