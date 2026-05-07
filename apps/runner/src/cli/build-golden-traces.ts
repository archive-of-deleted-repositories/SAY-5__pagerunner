/* eslint-disable no-console */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent } from '../agent/loop.js';
import { FakeLLMProvider } from '../agent/fake-llm.js';
import { ScriptedExecutor } from '../agent/scripted-executor.js';
import type { ToolCall } from '@pagerunner/agent-tools';
import type { RunTrace } from './replay.js';

/**
 * Generates a deterministic trace per committed golden flow by running the
 * FakeLLM + ScriptedExecutor pipeline once per flow and writing the captured
 * step list to `eval/replays/<flow_id>.trace.json`.
 *
 * The traces are checked into the repo so the `replay-determinism-smoke` CI
 * job can replay them and assert determinism_score == 1.0 without re-running
 * the dispatcher. Regenerate with `tsx apps/runner/src/cli/build-golden-traces.ts`.
 */

const FLOWS_DIR = join(process.cwd(), 'eval/flows');
const REPLAYS_DIR = join(process.cwd(), 'eval/replays');

interface FlowSpec {
  id: string;
  name: string;
  suite: string;
  script: ToolCall[];
  setup?: { extract?: Record<string, string>; failFirst?: string[] };
}

const buildExecutor = (flow: FlowSpec): ScriptedExecutor => {
  const ex = new ScriptedExecutor();
  if (flow.setup?.extract) {
    for (const [k, v] of Object.entries(flow.setup.extract)) ex.setExtract(k, v);
  }
  // failFirst is intentionally NOT applied here: we want the determinism
  // signal to track the happy-path replay shape. error-recovery paths
  // exercise retry behaviour, which is covered separately in unit tests.
  return ex;
};

async function main(): Promise<void> {
  mkdirSync(REPLAYS_DIR, { recursive: true });
  const files = readdirSync(FLOWS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  for (const file of files) {
    const flow = JSON.parse(readFileSync(join(FLOWS_DIR, file), 'utf8')) as FlowSpec;
    const llm = new FakeLLMProvider(flow.script);
    const executor = buildExecutor(flow);
    const captured: Array<{ idx: number; domAfter: string }> = [];
    const result = await runAgent({
      llm,
      executor,
      sleep: async () => undefined,
      onStep: (s, cap) => captured.push({ idx: s.idx, domAfter: cap.domAfter }),
    });
    if (result.status !== 'succeeded') {
      console.error(`flow ${flow.id} did not succeed (status=${result.status}); skipping`);
      continue;
    }
    const trace: RunTrace = {
      runId: `golden_${flow.id}`,
      flowId: flow.id,
      flowVersion: 1,
      steps: result.steps.map((s, i) => ({
        idx: s.idx,
        tool: s.tool,
        input: s.input,
        output: s.output ?? {},
        domAfter: captured[i]?.domAfter ?? '',
      })),
    };
    const outPath = join(REPLAYS_DIR, `${flow.id}.trace.json`);
    writeFileSync(outPath, JSON.stringify(trace, null, 2) + '\n');
    console.info(`wrote ${outPath} (${trace.steps.length} steps)`);
  }
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(msg);
  process.exit(1);
});
