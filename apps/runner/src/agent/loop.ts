import {
  CostBudgetExceededError,
  PageRunnerError,
  StepBudgetExceededError,
  WallClockExceededError,
  withSpan,
} from '@pagerunner/shared';
import type { ToolCall } from '@pagerunner/agent-tools';
import { validateToolCall } from '@pagerunner/agent-tools';
import {
  DEFAULT_BUDGET,
  type AgentBudget,
  type AgentObservation,
  type AgentRunResult,
  type LLMProvider,
  type ToolExecutor,
} from './types.js';
import { decide } from './retry-policy.js';

const DOM_CAP = 8_000;

const truncate = (s: string): string =>
  s.length <= DOM_CAP ? s : `${s.slice(0, DOM_CAP)}…[truncated ${s.length - DOM_CAP} chars]`;

export interface RunAgentOptions {
  llm: LLMProvider;
  executor: ToolExecutor;
  budget?: Partial<AgentBudget>;
  initialObservation?: AgentObservation;
  clock?: () => number;
  /** Test hook: replace the retry sleep. Production wires this to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentRunResult> {
  const budget: AgentBudget = { ...DEFAULT_BUDGET, ...opts.budget };
  const clock = opts.clock ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const startedAt = clock();
  const history: ToolCall[] = [];
  const steps: AgentRunResult['steps'] = [];
  let observation: AgentObservation = opts.initialObservation ?? { domExcerpt: '' };
  let totalCostUsd = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let stepIdx = 0;

  while (true) {
    if (clock() - startedAt > budget.maxWallClockMs) {
      throw new WallClockExceededError(budget.maxWallClockMs);
    }
    if (stepIdx >= budget.maxSteps) {
      throw new StepBudgetExceededError(budget.maxSteps);
    }

    const llmResponse = await withSpan('agent.llm', { stepIdx, model: opts.llm.model }, () =>
      opts.llm.step({ ...observation, domExcerpt: truncate(observation.domExcerpt) }, history),
    );
    totalCostUsd += llmResponse.costUsd;
    totalTokensIn += llmResponse.tokensIn;
    totalTokensOut += llmResponse.tokensOut;

    if (totalCostUsd > budget.maxCostUsd) {
      throw new CostBudgetExceededError(budget.maxCostUsd);
    }
    if (llmResponse.tokensOut > budget.maxTokensPerStep) {
      throw new PageRunnerError(
        `step ${stepIdx} produced ${llmResponse.tokensOut} tokens > ${budget.maxTokensPerStep}`,
        'TOKEN_BUDGET_EXCEEDED',
        false,
      );
    }

    const validated = validateToolCall(llmResponse.toolCall);
    history.push(llmResponse.toolCall);

    let stepRetries = 0;
    let executed: { output: Record<string, unknown>; domAfter: string } | null = null;
    let lastError: PageRunnerError | undefined;
    const stepStarted = clock();

    while (true) {
      try {
        executed = await withSpan(
          'agent.tool',
          { stepIdx, tool: validated.tool, retry: stepRetries },
          () => opts.executor.execute({ tool: validated.tool, input: validated.input as never }),
        );
        break;
      } catch (err) {
        const decision = decide(err, { stepRetryCount: stepRetries, jobRetryCount: 0 });
        if (decision.action !== 'retry') {
          lastError =
            err instanceof PageRunnerError
              ? err
              : new PageRunnerError(String(err), 'UNKNOWN', false);
          break;
        }
        stepRetries += 1;
        await sleep(decision.delayMs);
      }
    }

    const latency = clock() - stepStarted;

    if (executed) {
      const stepRecord: AgentRunResult['steps'][number] = {
        idx: stepIdx,
        tool: validated.tool,
        input: validated.input as Record<string, unknown>,
        output: executed.output,
        latencyMs: latency,
        retryCount: stepRetries,
      };
      steps.push(stepRecord);
      observation = { domExcerpt: executed.domAfter, lastError: undefined as unknown as string };
      if (validated.tool === 'finish') {
        const result = executed.output['result'] as Record<string, unknown> | undefined;
        return {
          status: 'succeeded',
          steps,
          totalCostUsd,
          totalTokensIn,
          totalTokensOut,
          ...(result ? { finalResult: result } : {}),
        };
      }
      stepIdx += 1;
      continue;
    }

    // Fall-through means we exhausted retries and bailed.
    const failed: AgentRunResult['steps'][number] = {
      idx: stepIdx,
      tool: validated.tool,
      input: validated.input as Record<string, unknown>,
      latencyMs: latency,
      retryCount: stepRetries,
      errorCode: lastError?.code ?? 'UNKNOWN',
    };
    steps.push(failed);
    return {
      status: 'failed',
      steps,
      totalCostUsd,
      totalTokensIn,
      totalTokensOut,
      errorCode: lastError?.code ?? 'UNKNOWN',
    };
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0) return resolve();
    setTimeout(() => resolve(), ms);
  });
