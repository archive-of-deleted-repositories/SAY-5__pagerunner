import { Queue } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { Dispatcher } from './dispatch';
import { FakeLLMProvider } from './fake-llm';
import { ScriptedExecutor } from './scripted-executor';
import { MemoryFlowStore, MemoryRunStore } from '@pagerunner/db';
import type { ToolCall } from '@pagerunner/agent-tools';

const REDIS_URL = process.env.REDIS_URL;
const HAS_REDIS = Boolean(REDIS_URL);

const maybe = HAS_REDIS ? describe : describe.skip;

maybe('Dispatcher', () => {
  jest.setTimeout(60_000);

  let redis: Redis;
  let runStore: MemoryRunStore;
  let flowStore: MemoryFlowStore;
  let queue: Queue;
  let dispatcher: Dispatcher;
  let queueName: string;

  const happyScript: ToolCall[] = [
    { tool: 'navigate', input: { url: 'http://x.test/' } },
    { tool: 'finish', input: { result: { ok: true } } },
  ];

  beforeAll(async () => {
    if (!HAS_REDIS) return;
    redis = new IORedis(REDIS_URL!, { maxRetriesPerRequest: null });
    await redis.flushall();
  });

  afterAll(async () => {
    if (!HAS_REDIS) return;
    await redis.quit();
  });

  beforeEach(async () => {
    runStore = new MemoryRunStore();
    flowStore = new MemoryFlowStore();
    queueName = `test_runs_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    queue = new Queue(queueName, { connection: redis });
  });

  afterEach(async () => {
    await dispatcher?.stop(5_000).catch(() => undefined);
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
  });

  it('drains a queued run end-to-end with a fake provider', async () => {
    const flow = flowStore.create({
      name: 'demo',
      dag: {
        nodes: [
          { id: 'n', tool: 'navigate', next: 'f' },
          { id: 'f', tool: 'finish' },
        ],
      },
      targetDomain: 'x.test',
    });
    const run = runStore.create({
      flowId: flow.id,
      flowVersion: flow.version,
      inputs: {},
      tenantId: 'public',
      targetDomain: 'x.test',
    });

    dispatcher = new Dispatcher({
      redis,
      runStore,
      flowStore,
      llmFactory: () => new FakeLLMProvider(happyScript),
      executorFactory: () => new ScriptedExecutor(),
      workerConcurrency: 2,
    });
    await dispatcher.start(queueName);

    await queue.add('run', { runId: run.id, flowId: flow.id, tenantId: 'public' });

    await waitFor(() => runStore.get(run.id)?.status === 'succeeded', 15_000);
    expect(runStore.getSteps(run.id)).toHaveLength(2);
  });

  it('records DLQ status when an infra error fires', async () => {
    const flow = flowStore.create({
      name: 'broken',
      dag: { nodes: [{ id: 'f', tool: 'finish' }] },
      targetDomain: 'broken.test',
    });
    const run = runStore.create({
      flowId: flow.id,
      flowVersion: flow.version,
      inputs: {},
      tenantId: 'public',
      targetDomain: 'broken.test',
    });

    dispatcher = new Dispatcher({
      redis,
      runStore,
      flowStore,
      llmFactory: () => ({
        model: 'fake',
        // Throw a non-PageRunnerError -> classified as infra -> DLQ.
        step: async () => {
          throw new Error('postgres unreachable');
        },
      }),
      executorFactory: () => new ScriptedExecutor(),
    });
    await dispatcher.start(queueName);
    await queue.add('run', { runId: run.id, flowId: flow.id, tenantId: 'public' }, { attempts: 1 });

    await waitFor(() => runStore.get(run.id)?.status === 'dlq', 15_000);
    const failures = runStore.getFailures();
    expect(failures.length).toBeGreaterThan(0);
  });

  it('cancels an in-flight run via Redis pub/sub', async () => {
    const flow = flowStore.create({
      name: 'long',
      dag: { nodes: [{ id: 'f', tool: 'finish' }] },
      targetDomain: 'long.test',
    });
    const run = runStore.create({
      flowId: flow.id,
      flowVersion: flow.version,
      inputs: {},
      tenantId: 'public',
      targetDomain: 'long.test',
    });

    dispatcher = new Dispatcher({
      redis,
      runStore,
      flowStore,
      llmFactory: () => ({
        model: 'fake',
        step: async (_obs, _hist, signal) =>
          new Promise<never>((_resolve, reject) => {
            const onAbort = (): void => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            };
            signal?.addEventListener('abort', onAbort, { once: true });
          }),
      }),
      executorFactory: () => new ScriptedExecutor(),
    });
    await dispatcher.start(queueName);
    await queue.add('run', { runId: run.id, flowId: flow.id, tenantId: 'public' });

    await waitFor(() => runStore.get(run.id)?.status === 'running', 10_000);
    await redis.publish(`runs:cancel:${run.id}`, 'cancel');
    await waitFor(() => runStore.get(run.id)?.status === 'cancelled', 10_000);
  });

  it('paces 50 enqueued runs against one domain via the token bucket', async () => {
    const flow = flowStore.create({
      name: 'paced',
      dag: { nodes: [{ id: 'f', tool: 'finish' }] },
      targetDomain: 'paced.test',
    });
    const runIds: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const r = runStore.create({
        flowId: flow.id,
        flowVersion: flow.version,
        inputs: { i },
        tenantId: 'public',
        targetDomain: 'paced.test',
      });
      runIds.push(r.id);
    }

    const fastScript: ToolCall[] = [{ tool: 'finish', input: { result: { ok: true } } }];
    dispatcher = new Dispatcher({
      redis,
      runStore,
      flowStore,
      llmFactory: () => new FakeLLMProvider(fastScript),
      executorFactory: () => new ScriptedExecutor(),
      ratePerSec: () => 25,
      workerConcurrency: 8,
    });
    await dispatcher.start(queueName);

    const start = Date.now();
    await Promise.all(
      runIds.map((id) => queue.add('run', { runId: id, flowId: flow.id, tenantId: 'public' })),
    );
    await waitFor(() => runIds.every((id) => runStore.get(id)?.status === 'succeeded'), 30_000);
    const elapsed = Date.now() - start;
    // 50 runs at 25 tokens/sec with bucket capacity 10 should take at least ~1.6s.
    // We assert a soft floor to avoid flakes from CI timing.
    expect(elapsed).toBeGreaterThan(1_000);
  });
});

const waitFor = async (cond: () => boolean, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
};
