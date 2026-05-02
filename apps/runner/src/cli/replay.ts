/* eslint-disable no-console */
import { readFileSync } from 'node:fs';
import { runAgent } from '../agent/loop.js';
import { FakeLLMProvider } from '../agent/fake-llm.js';
import { ScriptedExecutor } from '../agent/scripted-executor.js';
import type { ToolCall } from '@pagerunner/agent-tools';

interface Trace {
  flowId: string;
  steps: Array<{ tool: string; input: Record<string, unknown>; output: Record<string, unknown> }>;
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: pnpm replay <trace.json>');
    process.exit(1);
  }
  const trace = JSON.parse(readFileSync(path, 'utf8')) as Trace;
  const script: ToolCall[] = trace.steps.map((s) => ({
    tool: s.tool as ToolCall['tool'],
    input: s.input,
  }));

  const llm = new FakeLLMProvider(script);
  const executor = new ScriptedExecutor();
  const result = await runAgent({ llm, executor });

  let drift = 0;
  for (let i = 0; i < trace.steps.length; i++) {
    const original = trace.steps[i];
    const replayed = result.steps[i];
    if (!replayed || replayed.tool !== original?.tool) drift += 1;
  }

  const determinism = trace.steps.length === 0 ? 1 : 1 - drift / trace.steps.length;
  console.info(
    JSON.stringify(
      { flowId: trace.flowId, status: result.status, determinism, steps: result.steps.length },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
