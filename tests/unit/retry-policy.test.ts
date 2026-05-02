import { InfraError, PageRunnerError, SelectorNotFoundError } from '../../packages/shared/src';
import { decide, STEP_BACKOFFS } from '../../apps/runner/src/agent/retry-policy';

describe('decide', () => {
  it('retries selector errors with backoff', () => {
    const d1 = decide(new SelectorNotFoundError('#foo'), { stepRetryCount: 0, jobRetryCount: 0 });
    const d2 = decide(new SelectorNotFoundError('#foo'), { stepRetryCount: 1, jobRetryCount: 0 });
    expect(d1).toEqual({ action: 'retry', delayMs: STEP_BACKOFFS[0] });
    expect(d2).toEqual({ action: 'retry', delayMs: STEP_BACKOFFS[1] });
  });

  it('fails selector errors after backoffs exhausted', () => {
    const d = decide(new SelectorNotFoundError('#foo'), {
      stepRetryCount: STEP_BACKOFFS.length,
      jobRetryCount: 0,
    });
    expect(d.action).toBe('fail');
  });

  it('retries infra errors at the job level', () => {
    const d0 = decide(new InfraError('redis down'), { stepRetryCount: 0, jobRetryCount: 0 });
    const d2 = decide(new InfraError('redis down'), { stepRetryCount: 0, jobRetryCount: 2 });
    expect(d0.action).toBe('retry');
    expect(d2.action).toBe('fail');
  });

  it('non-domain errors trigger job retry then DLQ', () => {
    const d0 = decide(new Error('boom'), { stepRetryCount: 0, jobRetryCount: 0 });
    const d2 = decide(new Error('boom'), { stepRetryCount: 0, jobRetryCount: 2 });
    expect(d0.action).toBe('retry');
    expect(d2.action).toBe('dlq');
  });

  it('non-retryable domain errors fail immediately', () => {
    const err = new PageRunnerError('budget', 'STEP_BUDGET_EXCEEDED', false);
    const d = decide(err, { stepRetryCount: 0, jobRetryCount: 0 });
    expect(d.action).toBe('fail');
  });
});
