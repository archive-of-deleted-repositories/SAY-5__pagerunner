/* eslint-disable no-console */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runAgent } from '../apps/runner/src/agent/loop.js';
import { FakeLLMProvider } from '../apps/runner/src/agent/fake-llm.js';
import { ScriptedExecutor } from '../apps/runner/src/agent/scripted-executor.js';
import type { ToolCall } from '../packages/agent-tools/src/index.js';

const FLOWS_DIR = join(process.cwd(), 'eval/flows');

interface FlowSpec {
  id: string;
  name: string;
  script: ToolCall[];
  setup?: { extract?: Record<string, string>; failFirst?: string[] };
}

interface Suite {
  name: string;
  flows: FlowSpec[];
}

interface FlowResult {
  flow_id: string;
  flow_name: string;
  success: boolean;
  step_count: number;
  replay_determinism_score: number;
  simulated_cost_usd: number;
}

function loadSuite(name: string): Suite {
  const dir = FLOWS_DIR;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const flows: FlowSpec[] = [];
  for (const file of files) {
    const data = JSON.parse(readFileSync(join(dir, file), 'utf8')) as FlowSpec & { suite: string };
    if (data.suite === name) flows.push(data);
  }
  if (flows.length === 0) throw new Error(`no flows for suite ${name}`);
  flows.sort((a, b) => a.id.localeCompare(b.id));
  return { name, flows };
}

function buildExecutor(flow: FlowSpec): ScriptedExecutor {
  const executor = new ScriptedExecutor();
  if (flow.setup?.extract) {
    for (const [k, v] of Object.entries(flow.setup.extract)) executor.setExtract(k, v);
  }
  if (flow.setup?.failFirst) {
    for (const sel of flow.setup.failFirst) executor.failNextOn(sel);
  }
  return executor;
}

async function runOnce(flow: FlowSpec): Promise<{
  status: string;
  toolSeq: string[];
  steps: number;
  costUsd: number;
}> {
  const llm = new FakeLLMProvider(flow.script);
  const executor = buildExecutor(flow);
  const result = await runAgent({ llm, executor, sleep: async () => undefined });
  return {
    status: result.status,
    toolSeq: result.steps.map((s) => s.tool),
    steps: result.steps.length,
    costUsd: result.totalCostUsd,
  };
}

async function evaluateFlow(flow: FlowSpec): Promise<FlowResult> {
  const a = await runOnce(flow);
  const b = await runOnce(flow);
  const len = Math.max(a.toolSeq.length, b.toolSeq.length);
  let drift = 0;
  for (let i = 0; i < len; i++) {
    if (a.toolSeq[i] !== b.toolSeq[i]) drift += 1;
  }
  const determinism = len === 0 ? 1 : 1 - drift / len;
  return {
    flow_id: flow.id,
    flow_name: flow.name,
    success: a.status === 'succeeded',
    step_count: a.steps,
    replay_determinism_score: Number(determinism.toFixed(4)),
    simulated_cost_usd: Number(a.costUsd.toFixed(6)),
  };
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd !== 'run') {
    console.error(
      'usage: pnpm eval run --suite <name> [--provider fake] [--limit <n>] [--output <path>]',
    );
    process.exit(1);
  }
  const suiteName = getArg(args, '--suite') ?? 'golden_v1';
  const provider = getArg(args, '--provider') ?? 'fake';
  const limitArg = getArg(args, '--limit');
  const limit = limitArg !== undefined ? Number(limitArg) : Infinity;
  const outputPath = getArg(args, '--output');

  if (provider !== 'fake') {
    console.error(`unsupported provider "${provider}"; only "fake" is wired today`);
    process.exit(2);
  }

  const suite = loadSuite(suiteName);
  const target = suite.flows.slice(0, limit);

  const flows: FlowResult[] = [];
  for (const flow of target) {
    flows.push(await evaluateFlow(flow));
  }

  const total = flows.length;
  const succeeded = flows.filter((f) => f.success).length;
  const artifact = {
    suite: suiteName,
    provider,
    generated_at: new Date().toISOString(),
    flow_count: total,
    success_rate: total === 0 ? 0 : Number((succeeded / total).toFixed(4)),
    average_steps_to_success:
      succeeded === 0
        ? 0
        : Number(
            (
              flows.filter((f) => f.success).reduce((a, f) => a + f.step_count, 0) / succeeded
            ).toFixed(2),
          ),
    average_replay_determinism_score:
      total === 0
        ? 0
        : Number((flows.reduce((a, f) => a + f.replay_determinism_score, 0) / total).toFixed(4)),
    total_simulated_cost_usd: Number(
      flows.reduce((a, f) => a + f.simulated_cost_usd, 0).toFixed(6),
    ),
    flows,
  };

  const json = JSON.stringify(artifact, null, 2);
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${json}\n`);
    console.info(`wrote ${total} flows to ${outputPath}`);
  } else {
    console.info(json);
  }

  if (total > 0 && succeeded < total) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
