/* eslint-disable no-console */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

function loadSuite(name: string): Suite {
  const dir = FLOWS_DIR;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const flows: FlowSpec[] = [];
  for (const file of files) {
    const data = JSON.parse(readFileSync(join(dir, file), 'utf8')) as FlowSpec & { suite: string };
    if (data.suite === name) flows.push(data);
  }
  if (flows.length === 0) throw new Error(`no flows for suite ${name}`);
  return { name, flows };
}

async function runFlow(flow: FlowSpec): Promise<{
  flowId: string;
  status: string;
  latencyMs: number;
  steps: number;
  costUsd: number;
}> {
  const llm = new FakeLLMProvider(flow.script);
  const executor = new ScriptedExecutor();
  if (flow.setup?.extract) {
    for (const [k, v] of Object.entries(flow.setup.extract)) executor.setExtract(k, v);
  }
  if (flow.setup?.failFirst) {
    for (const sel of flow.setup.failFirst) executor.failNextOn(sel);
  }
  const start = Date.now();
  const result = await runAgent({ llm, executor, sleep: async () => undefined });
  return {
    flowId: flow.id,
    status: result.status,
    latencyMs: Date.now() - start,
    steps: result.steps.length,
    costUsd: result.totalCostUsd,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd !== 'run') {
    console.error('usage: pnpm eval run --suite <name> [--model <name>] [--limit <n>]');
    process.exit(1);
  }
  const suiteIdx = args.indexOf('--suite');
  const limitIdx = args.indexOf('--limit');
  const suiteName = suiteIdx >= 0 ? (args[suiteIdx + 1] ?? 'golden_v1') : 'golden_v1';
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;

  const suite = loadSuite(suiteName);
  const target = suite.flows.slice(0, limit);

  const results = [];
  for (const flow of target) {
    results.push(await runFlow(flow));
  }
  const succeeded = results.filter((r) => r.status === 'succeeded').length;
  const total = results.length;
  const summary = {
    suite: suiteName,
    total,
    succeeded,
    successRate: total === 0 ? 0 : succeeded / total,
    avgSteps: total === 0 ? 0 : results.reduce((a, r) => a + r.steps, 0) / total,
    p95LatencyMs: percentile(
      results.map((r) => r.latencyMs),
      0.95,
    ),
    avgCostUsd: total === 0 ? 0 : results.reduce((a, r) => a + r.costUsd, 0) / total,
    flows: results,
  };
  console.info(JSON.stringify(summary, null, 2));
  if (total > 0 && succeeded < total) {
    process.exit(1);
  }
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx] ?? 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
