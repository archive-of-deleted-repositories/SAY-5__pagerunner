import { performance } from 'node:perf_hooks';
import {
  AbortError,
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
  type ToolExecutionResult,
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
  /**
   * Wall-clock source used for budget enforcement. Defaults to `Date.now`.
   * Tests inject a fake clock here; per-step latency is sampled separately
   * via `hiResClock` so this can stay integer-millisecond without sacrificing
   * timer resolution.
   */
  clock?: () => number;
  /**
   * High-resolution monotonic clock for per-step latency, in milliseconds with
   * sub-millisecond resolution. Defaults to `performance.now`. Convert to
   * integer microseconds at the call site via `Math.round(ms * 1000)`.
   */
  hiResClock?: () => number;
  /** Test hook: replace the retry sleep. Production wires this to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Abort signal for cooperative cancellation. Propagated to provider/executor. */
  signal?: AbortSignal;
  /** Hook called after each step persists. Used by dispatcher for artifact upload. */
  onStep?: (
    step: AgentRunResult['steps'][number],
    captured: { domAfter: string; artifacts?: ToolExecutionResult['artifacts'] },
  ) => void;
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentRunResult> {
  const budget: AgentBudget = { ...DEFAULT_BUDGET, ...opts.budget };
  const clock = opts.clock ?? (() => Date.now());
  const hiResClock = opts.hiResClock ?? (() => performance.now());
  const sleep = opts.sleep ?? defaultSleep;
  const startedAt = clock();
  const history: ToolCall[] = [];
  const steps: AgentRunResult['steps'] = [];
  let observation: AgentObservation = opts.initialObservation ?? { domExcerpt: '' };
  let totalCostUsd = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let stepIdx = 0;

  const checkAbort = (): void => {
    if (opts.signal?.aborted) throw new AbortError();
  };

  while (true) {
    checkAbort();
    if (clock() - startedAt > budget.maxWallClockMs) {
      throw new WallClockExceededError(budget.maxWallClockMs);
    }
    if (stepIdx >= budget.maxSteps) {
      throw new StepBudgetExceededError(budget.maxSteps);
    }

    const llmResponse = await withSpan('agent.llm', { stepIdx, model: opts.llm.model }, () =>
      opts.llm.step(
        { ...observation, domExcerpt: truncate(observation.domExcerpt) },
        history,
        opts.signal,
      ),
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
    let executed: ToolExecutionResult | null = null;
    let lastError: PageRunnerError | undefined;
    const stepStartedHiRes = hiResClock();

    while (true) {
      checkAbort();
      try {
        executed = await withSpan(
          'agent.tool',
          { stepIdx, tool: validated.tool, retry: stepRetries },
          () =>
            opts.executor.execute(
              { tool: validated.tool, input: validated.input as never },
              opts.signal,
            ),
        );
        break;
      } catch (err) {
        if (err instanceof AbortError || opts.signal?.aborted) throw new AbortError();
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

    const elapsedMs = hiResClock() - stepStartedHiRes;
    const latencyUs = Math.max(0, Math.round(elapsedMs * 1000));
    const latencyMs = Math.floor(elapsedMs);

    if (executed) {
      const stepRecord: AgentRunResult['steps'][number] = {
        idx: stepIdx,
        tool: validated.tool,
        input: validated.input as Record<string, unknown>,
        output: executed.output,
        latencyMs,
        latencyUs,
        retryCount: stepRetries,
      };
      steps.push(stepRecord);
      const captured: { domAfter: string; artifacts?: ToolExecutionResult['artifacts'] } = {
        domAfter: executed.domAfter,
      };
      if (executed.artifacts) captured.artifacts = executed.artifacts;
      opts.onStep?.(stepRecord, captured);
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
      latencyMs,
      latencyUs,
      retryCount: stepRetries,
      errorCode: lastError?.code ?? 'UNKNOWN',
    };
    steps.push(failed);
    opts.onStep?.(failed, { domAfter: observation.domExcerpt });
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
