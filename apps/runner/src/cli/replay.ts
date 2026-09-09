/* eslint-disable no-console */
import { readFileSync, writeFileSync } from 'node:fs';
import { runAgent } from '../agent/loop.js';
import { FakeLLMProvider } from '../agent/fake-llm.js';
import { ScriptedExecutor } from '../agent/scripted-executor.js';
import type { ToolCall } from '@pagerunner/agent-tools';

/**
 * Replay-from-trace verifier. Takes a recorded run trace and re-runs the
 * agent loop against:
 *   - a FakeLLMProvider scripted on the recorded (tool, input) per step
 *   - a deterministic ScriptedExecutor that computes outputs from inputs
 * The replayed step sequence is then compared step-by-step against the
 * trace. Drift surfaces as `tool_mismatch`, `input_mismatch`,
 * `output_mismatch`, `missing_step`, or `extra_step`.
 *
 * If the recorded trace was produced by the same FakeLLM + ScriptedExecutor
 * pipeline (the hermetic golden-flow path), every comparison is byte-equal
 * and `determinism_score == 1.0`. Tampering with any recorded field
 * surfaces as drift.
 *
 * Usage:
 *   pnpm replay <path/to/trace.json>
 *   pnpm replay --trace <path/to/trace.json>
 *   pnpm replay --run-id <runId>            # reads trace from DB (TODO)
 *
 * Optional:
 *   --report <path>     write the Markdown report to <path>
 *   --no-stdout         suppress JSON stdout summary
 */

export interface TraceStep {
  idx: number;
  tool: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  domAfter?: string;
  domSnapshotS3Key?: string;
  screenshotS3Key?: string;
}

export interface RunTrace {
  runId: string;
  flowId: string;
  flowVersion: number;
  steps: TraceStep[];
}

export interface ReplayDriftEntry {
  idx: number;
  reason: 'tool_mismatch' | 'input_mismatch' | 'output_mismatch' | 'missing_step' | 'extra_step';
  recorded?: { tool: string; input: Record<string, unknown>; output?: Record<string, unknown> };
  replayed?: { tool: string; input: Record<string, unknown>; output?: Record<string, unknown> };
}

export interface ReplayReport {
  runId: string;
  flowId: string;
  flowVersion: number;
  recordedStepCount: number;
  replayedStepCount: number;
  driftCount: number;
  replaysMatch: boolean;
  determinismScore: number;
  drifts: ReplayDriftEntry[];
}

const stableStringify = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
};

const inputsEqual = (a: Record<string, unknown>, b: Record<string, unknown>): boolean =>
  stableStringify(a) === stableStringify(b);

const outputsEqual = (
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean => stableStringify(a ?? {}) === stableStringify(b ?? {});

export async function verifyTrace(trace: RunTrace): Promise<ReplayReport> {
  // Empty trace is trivially deterministic — nothing to drive.
  if (trace.steps.length === 0) {
    return {
      runId: trace.runId,
      flowId: trace.flowId,
      flowVersion: trace.flowVersion,
      recordedStepCount: 0,
      replayedStepCount: 0,
      driftCount: 0,
      replaysMatch: true,
      determinismScore: 1,
      drifts: [],
    };
  }

  // FakeLLMProvider scripted on (tool, input) per recorded step.
  const script: ToolCall[] = trace.steps.map((s) => ({ tool: s.tool, input: s.input }) as ToolCall);
  // Replay is local and free; simulated live-run cost must not truncate it.
  const llm = new FakeLLMProvider(script, 0);
  // Deterministic ScriptedExecutor — computes outputs from inputs.
  const executor = new ScriptedExecutor();

  const result = await runAgent({
    llm,
    executor,
    // Bound replay by the captured sequence, independent of live-run defaults.
    budget: { maxSteps: trace.steps.length },
    sleep: async () => undefined,
  });

  const drifts: ReplayDriftEntry[] = [];
  const recordedLen = trace.steps.length;
  const replayedLen = result.steps.length;
  const longest = Math.max(recordedLen, replayedLen);

  for (let i = 0; i < longest; i += 1) {
    const recorded = trace.steps[i];
    const replayed = result.steps[i];
    if (recorded && !replayed) {
      drifts.push({
        idx: i,
        reason: 'missing_step',
        recorded: { tool: recorded.tool, input: recorded.input, output: recorded.output },
      });
      continue;
    }
    if (!recorded && replayed) {
      drifts.push({
        idx: i,
        reason: 'extra_step',
        replayed: {
          tool: replayed.tool,
          input: replayed.input,
          ...(replayed.output ? { output: replayed.output } : {}),
        },
      });
      continue;
    }
    if (!recorded || !replayed) continue;

    if (recorded.tool !== replayed.tool) {
      drifts.push({
        idx: i,
        reason: 'tool_mismatch',
        recorded: { tool: recorded.tool, input: recorded.input, output: recorded.output },
        replayed: {
          tool: replayed.tool,
          input: replayed.input,
          ...(replayed.output ? { output: replayed.output } : {}),
        },
      });
      continue;
    }
    if (!inputsEqual(recorded.input, replayed.input)) {
      drifts.push({
        idx: i,
        reason: 'input_mismatch',
        recorded: { tool: recorded.tool, input: recorded.input, output: recorded.output },
        replayed: {
          tool: replayed.tool,
          input: replayed.input,
          ...(replayed.output ? { output: replayed.output } : {}),
        },
      });
      continue;
    }
    if (!outputsEqual(recorded.output, replayed.output)) {
      drifts.push({
        idx: i,
        reason: 'output_mismatch',
        recorded: { tool: recorded.tool, input: recorded.input, output: recorded.output },
        replayed: {
          tool: replayed.tool,
          input: replayed.input,
          ...(replayed.output ? { output: replayed.output } : {}),
        },
      });
    }
  }

  const determinismScore = longest === 0 ? 1 : 1 - drifts.length / longest;
  return {
    runId: trace.runId,
    flowId: trace.flowId,
    flowVersion: trace.flowVersion,
    recordedStepCount: recordedLen,
    replayedStepCount: replayedLen,
    driftCount: drifts.length,
    replaysMatch: drifts.length === 0,
    determinismScore,
    drifts,
  };
}

export function formatMarkdownReport(report: ReplayReport): string {
  const lines: string[] = [];
  lines.push(`# replay report — ${report.runId}`);
  lines.push('');
  lines.push(`- flow_id: ${report.flowId}`);
  lines.push(`- flow_version: ${report.flowVersion}`);
  lines.push(`- recorded_steps: ${report.recordedStepCount}`);
  lines.push(`- replayed_steps: ${report.replayedStepCount}`);
  lines.push(`- drift_count: ${report.driftCount}`);
  lines.push(`- replays_match: ${report.replaysMatch}`);
  lines.push(`- determinism_score: ${report.determinismScore.toFixed(4)}`);
  if (report.drifts.length > 0) {
    lines.push('');
    lines.push('## drifts');
    for (const d of report.drifts) {
      lines.push(`### step ${d.idx} (${d.reason})`);
      if (d.recorded) {
        lines.push(
          `- recorded: ${d.recorded.tool} input=${JSON.stringify(d.recorded.input)}` +
            (d.recorded.output ? ` output=${JSON.stringify(d.recorded.output)}` : ''),
        );
      }
      if (d.replayed) {
        lines.push(
          `- replayed: ${d.replayed.tool} input=${JSON.stringify(d.replayed.input)}` +
            (d.replayed.output ? ` output=${JSON.stringify(d.replayed.output)}` : ''),
        );
      }
    }
  }
  return lines.join('\n') + '\n';
}

interface CliArgs {
  tracePath: string | undefined;
  runId: string | undefined;
  reportPath: string | undefined;
  noStdout: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    tracePath: undefined,
    runId: undefined,
    reportPath: undefined,
    noStdout: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-stdout') {
      args.noStdout = true;
    } else if (arg === '--trace' || arg === '--run-id' || arg === '--report') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error(`missing value for ${arg}`);
      const key = arg === '--trace' ? 'tracePath' : arg === '--run-id' ? 'runId' : 'reportPath';
      if (args[key]) throw new Error(`duplicate ${arg}`);
      args[key] = value;
    } else if (arg && !arg.startsWith('-')) {
      if (args.tracePath) throw new Error('specify only one trace path');
      args.tracePath = arg;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (args.tracePath && args.runId) throw new Error('choose a trace path or --run-id, not both');
  return args;
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('usage: pnpm replay <path> | --trace <path> | --run-id <runId>');
    process.exit(2);
  }
  if (!args.tracePath && !args.runId) {
    console.error('usage: pnpm replay <path> | --trace <path> | --run-id <runId>');
    process.exit(2);
  }
  let trace: RunTrace;
  if (args.tracePath) {
    trace = JSON.parse(readFileSync(args.tracePath, 'utf8')) as RunTrace;
  } else {
    // The DB-backed path is intentionally not wired in this CLI iteration.
    // The dispatcher persists steps and artifacts to Postgres; reading them
    // back into the RunTrace shape requires a small adapter that joins
    // `steps` with `artifacts` per step. Tracked in ROADMAP.md.
    console.error(
      'replay --run-id <id> reads from Postgres; not wired in this CLI iteration. Use --trace.',
    );
    process.exit(2);
  }
  const report = await verifyTrace(trace);
  const md = formatMarkdownReport(report);
  if (args.reportPath) writeFileSync(args.reportPath, md);
  if (!args.noStdout) {
    process.stdout.write(md);
  }
  if (!report.replaysMatch) {
    process.exit(1);
  }
}

const isMain = (): boolean => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return argv1.endsWith('cli/replay.ts') || argv1.endsWith('cli/replay.js');
};

if (isMain()) {
  main().catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg);
    process.exit(1);
  });
}
