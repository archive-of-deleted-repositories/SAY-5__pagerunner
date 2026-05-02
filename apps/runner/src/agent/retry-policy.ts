import { PageRunnerError } from '@pagerunner/shared';

export type RetryDecision =
  | { action: 'retry'; delayMs: number }
  | { action: 'fail' }
  | { action: 'dlq' };

const STEP_BACKOFFS_MS = [500, 2_000, 8_000];

export interface RetryContext {
  stepRetryCount: number;
  jobRetryCount: number;
}

export function decide(err: unknown, ctx: RetryContext): RetryDecision {
  if (!(err instanceof PageRunnerError)) {
    // Any non-domain error is treated as infra; one job retry then DLQ.
    if (ctx.jobRetryCount < 2) return { action: 'retry', delayMs: 1_000 * (ctx.jobRetryCount + 1) };
    return { action: 'dlq' };
  }

  if (err.code === 'SELECTOR_NOT_FOUND') {
    if (ctx.stepRetryCount < STEP_BACKOFFS_MS.length) {
      return { action: 'retry', delayMs: STEP_BACKOFFS_MS[ctx.stepRetryCount]! };
    }
    return { action: 'fail' };
  }

  if (err.code === 'INFRA_ERROR') {
    if (ctx.jobRetryCount < 2) {
      return { action: 'retry', delayMs: 1_000 * (ctx.jobRetryCount + 1) };
    }
    return { action: 'fail' };
  }

  if (err.retryable && ctx.stepRetryCount < STEP_BACKOFFS_MS.length) {
    return { action: 'retry', delayMs: STEP_BACKOFFS_MS[ctx.stepRetryCount]! };
  }

  return { action: 'fail' };
}

export const STEP_BACKOFFS = STEP_BACKOFFS_MS;
