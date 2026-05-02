import { runAgent } from '../../apps/runner/src/agent/loop';
import { FakeLLMProvider } from '../../apps/runner/src/agent/fake-llm';
import { ScriptedExecutor } from '../../apps/runner/src/agent/scripted-executor';
import type { ToolCall } from '../../packages/agent-tools/src';

describe('runAgent', () => {
  const happyScript: ToolCall[] = [
    { tool: 'navigate', input: { url: 'http://x.test/' } },
    { tool: 'click', input: { selector: '#go' } },
    { tool: 'extract', input: { selector: '#title' } },
    { tool: 'finish', input: { result: { ok: true } } },
  ];

  it('runs the happy path to finish', async () => {
    const result = await runAgent({
      llm: new FakeLLMProvider(happyScript),
      executor: new ScriptedExecutor(),
    });
    expect(result.status).toBe('succeeded');
    expect(result.steps).toHaveLength(4);
    expect(result.finalResult).toEqual({ ok: true });
  });

  it('enforces the step budget', async () => {
    const longScript: ToolCall[] = Array.from({ length: 10 }, () => ({
      tool: 'click',
      input: { selector: '#go' },
    }));
    await expect(
      runAgent({
        llm: new FakeLLMProvider(longScript),
        executor: new ScriptedExecutor(),
        budget: { maxSteps: 3 },
      }),
    ).rejects.toMatchObject({ code: 'STEP_BUDGET_EXCEEDED' });
  });

  it('enforces the cost budget', async () => {
    await expect(
      runAgent({
        llm: new FakeLLMProvider(happyScript, 1.0),
        executor: new ScriptedExecutor(),
        budget: { maxCostUsd: 0.5 },
      }),
    ).rejects.toMatchObject({ code: 'COST_BUDGET_EXCEEDED' });
  });

  it('retries on flaky selector and still finishes', async () => {
    const exec = new ScriptedExecutor();
    exec.failNextOn('#go');
    const result = await runAgent({
      llm: new FakeLLMProvider(happyScript),
      executor: exec,
      sleep: async () => undefined, // fast-forward backoffs
    });
    expect(result.status).toBe('succeeded');
    const clickStep = result.steps.find((s) => s.tool === 'click');
    expect(clickStep?.retryCount).toBe(1);
  });

  it('fails when retries exhausted on missing selector', async () => {
    const script: ToolCall[] = [
      { tool: 'navigate', input: { url: 'http://x.test/' } },
      { tool: 'click', input: { selector: 'MISSING:#never' } },
      { tool: 'finish', input: { result: { ok: false } } },
    ];
    const result = await runAgent({
      llm: new FakeLLMProvider(script),
      executor: new ScriptedExecutor(),
      sleep: async () => undefined,
    });
    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('SELECTOR_NOT_FOUND');
  });
});
