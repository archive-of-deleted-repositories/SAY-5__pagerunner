import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  AbortError,
  AuthError,
  CostBudgetExceededError,
  PageRunnerError,
  StepBudgetExceededError,
  WallClockExceededError,
  childLogger,
  logger,
} from '@pagerunner/shared';
import type { FlowStoreLike, RunStoreLike, StoredFlow, StoredRun } from '@pagerunner/db';
import { runAgent, type RunAgentOptions } from './loop.js';
import { AnthropicProvider } from './providers/anthropic-provider.js';
import { PlaywrightExecutor } from './executors/playwright-executor.js';
import type { LLMProvider, ToolExecutor } from './types.js';
import { TokenBucket } from './token-bucket.js';
import { RedisSemaphore } from './semaphore.js';
import type { ArtifactUploader } from './artifacts/uploader.js';

export interface RunJobPayload {
  runId: string;
  flowId: string;
  tenantId: string;
  traceId?: string;
  /** Optional model override for the agent loop. */
  model?: string;
  /** Optional budget overrides for the agent loop. */
  budget?: RunAgentOptions['budget'];
}

export interface DispatcherOptions {
  redis: Redis;
  runStore: RunStoreLike;
  flowStore: FlowStoreLike;
  /** Factory hooks: dispatcher constructs new instances per run. */
  llmFactory?: (model: string | undefined, signal: AbortSignal) => LLMProvider;
  executorFactory?: () => ToolExecutor;
  artifactUploader?: ArtifactUploader;
  /** Per-tenant concurrency cap. Falls back to 4. */
  concurrencyCap?: (tenantId: string) => number;
  /** Per-domain refill rate per second. Falls back to 10. */
  ratePerSec?: (domain: string) => number;
  /** Worker concurrency (BullMQ). */
  workerConcurrency?: number;
  /** Anthropic API key. Optional so tests can drive with FakeLLMProvider. */
  anthropicApiKey?: string;
}

const DEFAULT_BUCKET_CAPACITY = 10;

const isInfraError = (err: unknown): boolean => {
  if (err instanceof PageRunnerError) {
    if (
      err instanceof StepBudgetExceededError ||
      err instanceof CostBudgetExceededError ||
      err instanceof WallClockExceededError ||
      err instanceof AuthError
    ) {
      return false;
    }
    if (err.code === 'INFRA_ERROR' || err.code === 'UPSTREAM_ERROR') return true;
    return false;
  }
  // Unknown errors are treated as infra so the queue retries before DLQ.
  return true;
};

/**
 * BullMQ dispatcher. One worker process drains the `runs` queue, applies
 * per-tenant concurrency caps and per-domain token-bucket rate limiting,
 * then runs the existing agent loop with a real Anthropic provider and a
 * real Chromium browser. Cancellation and graceful shutdown both flow
 * through a per-run AbortController.
 */
export class Dispatcher {
  private readonly redis: Redis;
  private readonly runStore: RunStoreLike;
  private readonly flowStore: FlowStoreLike;
  private readonly llmFactory: NonNullable<DispatcherOptions['llmFactory']>;
  private readonly executorFactory: NonNullable<DispatcherOptions['executorFactory']>;
  private readonly artifactUploader: ArtifactUploader | undefined;
  private readonly semaphore: RedisSemaphore;
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly bucketRate: (domain: string) => number;
  private readonly inflight = new Map<string, AbortController>();
  private worker: Worker | null = null;
  private subscriber: Redis | null = null;
  private shuttingDown = false;

  constructor(private readonly opts: DispatcherOptions) {
    this.redis = opts.redis;
    this.runStore = opts.runStore;
    this.flowStore = opts.flowStore;
    this.artifactUploader = opts.artifactUploader;
    this.semaphore = new RedisSemaphore(opts.redis, opts.concurrencyCap ?? (() => 4));
    this.bucketRate = opts.ratePerSec ?? (() => DEFAULT_BUCKET_CAPACITY);
    const apiKey = opts.anthropicApiKey;
    this.llmFactory =
      opts.llmFactory ??
      ((model, _signal): LLMProvider => {
        if (!apiKey) {
          throw new AuthError('ANTHROPIC_API_KEY required for production dispatch');
        }
        const providerOpts: ConstructorParameters<typeof AnthropicProvider>[0] = { apiKey };
        if (model) providerOpts.model = model;
        return new AnthropicProvider(providerOpts);
      });
    this.executorFactory = opts.executorFactory ?? (() => new PlaywrightExecutor());
  }

  private bucketFor(domain: string): TokenBucket {
    const existing = this.buckets.get(domain);
    if (existing) return existing;
    const bucket = new TokenBucket(DEFAULT_BUCKET_CAPACITY, this.bucketRate(domain));
    this.buckets.set(domain, bucket);
    return bucket;
  }

  async start(queueName = 'runs'): Promise<void> {
    if (this.worker) return;
    this.worker = new Worker(queueName, (job) => this.handleJob(job as Job<RunJobPayload>), {
      connection: this.redis,
      concurrency: this.opts.workerConcurrency ?? 4,
    });
    this.worker.on('error', (err) => {
      logger.error({ err }, 'dispatcher worker error');
    });

    this.subscriber = this.redis.duplicate();
    await this.subscriber.psubscribe('runs:cancel:*');
    this.subscriber.on('pmessage', (_pattern, channel) => {
      const runId = channel.split(':').pop();
      if (!runId) return;
      const ac = this.inflight.get(runId);
      if (ac) ac.abort();
    });

    // BullMQ workers may be already-ready by the time the listener attaches;
    // resolve on next tick to avoid hangs.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async stop(timeoutMs = 60_000): Promise<void> {
    this.shuttingDown = true;
    const worker = this.worker;
    if (!worker) return;
    await worker.pause(true);
    const deadline = Date.now() + timeoutMs;
    while (this.inflight.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await worker.close();
    if (this.subscriber) await this.subscriber.quit().catch(() => undefined);
    this.worker = null;
    this.subscriber = null;
  }

  private async handleJob(job: Job<RunJobPayload>): Promise<void> {
    const log = childLogger({ runId: job.data.runId, tenantId: job.data.tenantId });
    if (this.shuttingDown) {
      throw new Error('dispatcher shutting down');
    }
    const run = await this.runStore.get(job.data.runId);
    if (!run) {
      log.warn('run not found; ignoring job');
      return;
    }
    const flow = await this.flowStore.get(job.data.flowId);
    if (!flow) {
      log.warn({ flowId: job.data.flowId }, 'flow not found; marking failed');
      await this.runStore.setStatus(run.id, 'failed', { errorCode: 'FLOW_NOT_FOUND' });
      return;
    }

    const lease = await this.semaphore.acquire(job.data.tenantId);
    if (!lease) {
      log.info('per-tenant capacity exhausted; requeueing');
      throw new Error('tenant_capacity_exhausted');
    }

    const ac = new AbortController();
    this.inflight.set(run.id, ac);
    try {
      const domain = run.targetDomain ?? flow.targetDomain ?? 'default';
      const bucket = this.bucketFor(domain);
      while (!bucket.tryConsume(1)) {
        if (ac.signal.aborted) throw new AbortError();
        const delay = bucket.delayFor(1);
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      }

      await this.runStore.setStatus(run.id, 'running');
      await this.runOnce(run, flow, job.data, ac.signal);
    } finally {
      this.inflight.delete(run.id);
      await lease.release();
    }
  }

  private async runOnce(
    run: StoredRun,
    flow: StoredFlow,
    payload: RunJobPayload,
    signal: AbortSignal,
  ): Promise<void> {
    const log = childLogger({ runId: run.id, tenantId: run.tenantId });
    const llm = this.llmFactory(payload.model, signal);
    const executor = this.executorFactory();
    const uploadPromises: Promise<void>[] = [];

    try {
      const result = await runAgent({
        llm,
        executor,
        ...(payload.budget ? { budget: payload.budget } : {}),
        signal,
        onStep: (step, captured) => {
          void this.runStore.appendStep({
            runId: run.id,
            idx: step.idx,
            tool: step.tool,
            input: step.input,
            output: step.output ?? null,
            status: step.errorCode ? 'failed' : 'succeeded',
            latencyMs: step.latencyMs,
            retryCount: step.retryCount,
            errorCode: step.errorCode ?? null,
          });
          if (this.artifactUploader) {
            const uploader = this.artifactUploader;
            const upload = (async (): Promise<void> => {
              try {
                if (captured.domAfter) {
                  const key = await uploader.upload(
                    run.tenantId,
                    run.id,
                    step.idx,
                    'dom',
                    Buffer.from(captured.domAfter, 'utf8'),
                  );
                  await this.runStore.recordArtifact?.(
                    run.id,
                    step.idx,
                    'dom',
                    key,
                    Buffer.byteLength(captured.domAfter, 'utf8'),
                  );
                }
                if (captured.artifacts?.screenshot) {
                  const key = await uploader.upload(
                    run.tenantId,
                    run.id,
                    step.idx,
                    'screenshot',
                    captured.artifacts.screenshot,
                  );
                  await this.runStore.recordArtifact?.(
                    run.id,
                    step.idx,
                    'screenshot',
                    key,
                    captured.artifacts.screenshot.byteLength,
                  );
                }
                if (captured.artifacts?.consoleMessages?.length) {
                  const data = Buffer.from(
                    captured.artifacts.consoleMessages.map((m) => JSON.stringify({ m })).join('\n'),
                    'utf8',
                  );
                  const key = await uploader.upload(
                    run.tenantId,
                    run.id,
                    step.idx,
                    'console',
                    data,
                  );
                  await this.runStore.recordArtifact?.(
                    run.id,
                    step.idx,
                    'console',
                    key,
                    data.byteLength,
                  );
                }
              } catch (err) {
                log.warn({ err, stepIdx: step.idx }, 'artifact upload failed');
              }
            })();
            uploadPromises.push(upload);
          }
        },
      });

      await Promise.all(uploadPromises);

      if (result.status === 'succeeded') {
        const setOpts: { costUsd: string; outputs?: Record<string, unknown> } = {
          costUsd: result.totalCostUsd.toFixed(6),
        };
        if (result.finalResult) setOpts.outputs = result.finalResult;
        await this.runStore.setStatus(run.id, 'succeeded', setOpts);
      } else {
        const setOpts: { costUsd: string; errorCode?: string } = {
          costUsd: result.totalCostUsd.toFixed(6),
        };
        if (result.errorCode) setOpts.errorCode = result.errorCode;
        await this.runStore.setStatus(run.id, 'failed', setOpts);
      }
    } catch (err) {
      await Promise.allSettled(uploadPromises);
      if (err instanceof AbortError || signal.aborted) {
        await this.runStore.setStatus(run.id, 'cancelled');
        return;
      }
      if (isInfraError(err)) {
        const code = err instanceof PageRunnerError ? err.code : 'INFRA';
        await this.runStore.setStatus(run.id, 'dlq', { errorCode: code });
        await this.runStore.recordFailure?.(run.id, {
          tenantId: run.tenantId,
          flowId: flow.id,
          errorCode: code,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        // Re-throw so BullMQ counts the retry attempt.
        throw err;
      }
      const code = err instanceof PageRunnerError ? err.code : 'UNKNOWN';
      await this.runStore.setStatus(run.id, 'failed', { errorCode: code });
    } finally {
      if (executor.dispose) await executor.dispose();
    }
  }
}

/**
 * Legacy single-shot entrypoint kept for the worker shell. New deployments
 * should call `Dispatcher#start` from the runner main bootstrap.
 */
export async function dispatch(payload: Record<string, unknown>): Promise<void> {
  logger.info({ payload }, 'dispatch single-job invoked; prefer Dispatcher#start');
}
