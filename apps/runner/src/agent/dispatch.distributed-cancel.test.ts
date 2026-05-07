import { Queue } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { Dispatcher } from './dispatch';
import { ScriptedExecutor } from './scripted-executor';
import { MemoryFlowStore, MemoryRunStore } from '@pagerunner/db';
import { CancelPublisher } from '../../../control-plane/src/cancel-publisher';

/**
 * Two-pod distributed cancellation test. Two Dispatcher instances point at
 * the same Redis. Pod A claims a long-running job (its FakeLLM step blocks
 * forever until the abort signal fires). Pod B publishes a cancel message
 * — either directly via redis.publish, or via the control-plane's
 * CancelPublisher — and the test asserts:
 *
 *   1. Pod A's local AbortController fires within 2s of the publish.
 *   2. The run transitions to `cancelled` in the shared run store.
 *   3. Pod B does not have an inflight handle for that run, so its
 *      pmessage handler is a clean no-op.
 *
 * The store is a MemoryRunStore shared between both dispatchers. In
 * production each pod hits its own Postgres connection pool and the
 * status update is read by both pods through Postgres. This test only
 * exercises the pub/sub plumbing — the store sharing is incidental.
 */

const REDIS_URL = process.env['REDIS_URL'];
const HAS_REDIS = Boolean(REDIS_URL);

const maybe = HAS_REDIS ? describe : describe.skip;

maybe('distributed cancellation across two pods', () => {
  jest.setTimeout(60_000);

  let redisA: Redis;
  let redisB: Redis;
  let runStore: MemoryRunStore;
  let flowStore: MemoryFlowStore;
  let podA: Dispatcher;
  let podB: Dispatcher;
  let queue: Queue;
  let queueName: string;
  let cancelPublisher: CancelPublisher;

  beforeAll(async () => {
    redisA = new IORedis(REDIS_URL!, { maxRetriesPerRequest: null });
    redisB = new IORedis(REDIS_URL!, { maxRetriesPerRequest: null });
    await redisA.flushall();
  });

  afterAll(async () => {
    await redisA.quit();
    await redisB.quit();
  });

  beforeEach(() => {
    runStore = new MemoryRunStore();
    flowStore = new MemoryFlowStore();
    queueName = `dist_cancel_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    queue = new Queue(queueName, { connection: redisA });
  });

  afterEach(async () => {
    await podA?.stop(5_000).catch(() => undefined);
    await podB?.stop(5_000).catch(() => undefined);
    await cancelPublisher?.dispose().catch(() => undefined);
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
  });

  it('pod A aborts within 2s of pod B publishing the cancel', async () => {
    const flow = flowStore.create({
      name: 'distributed-cancel',
      dag: { nodes: [{ id: 'f', tool: 'finish' }] },
      targetDomain: 'd.test',
    });
    const run = runStore.create({
      flowId: flow.id,
      flowVersion: flow.version,
      inputs: {},
      tenantId: 'public',
      targetDomain: 'd.test',
    });

    // Pod A is the only worker in this queue; bullmq distributes by
    // first-come-first-served across workers anyway, so a one-pod queue
    // guarantees pod A claims the job.
    podA = new Dispatcher({
      redis: redisA,
      runStore,
      flowStore,
      workerConcurrency: 1,
      llmFactory: () => ({
        model: 'fake',
        // Block until aborted so the cancel has something to interrupt.
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

    // Pod B has no worker queue — it only listens on the cancel channel,
    // mirroring the production posture where some pods are dispatchers
    // and some are admin/control nodes that can also publish cancels.
    // We start pod B with a different queue name so it never claims the
    // job.
    podB = new Dispatcher({
      redis: redisB,
      runStore,
      flowStore,
      workerConcurrency: 1,
      llmFactory: () => ({ model: 'fake', step: async () => ({}) as never }),
      executorFactory: () => new ScriptedExecutor(),
    });
    await podA.start(queueName);
    await podB.start(`${queueName}_b_only`);

    await queue.add('run', { runId: run.id, flowId: flow.id, tenantId: 'public' });

    // Wait for pod A to actually pick up the job and flip status to running.
    await waitFor(() => runStore.get(run.id)?.status === 'running', 10_000);
    expect(podA['inflight'].has(run.id)).toBe(true);
    expect(podB['inflight'].has(run.id)).toBe(false);

    // Pod B publishes via the CancelPublisher, the same code path the
    // control-plane uses. Recipients == 2 because both pods psubscribe.
    cancelPublisher = new CancelPublisher(redisB);
    const publishedAt = Date.now();
    const recipients = await cancelPublisher.publish(run.id, 'two-pod-test');
    expect(recipients).toBeGreaterThanOrEqual(2);

    await waitFor(() => runStore.get(run.id)?.status === 'cancelled', 5_000);
    const elapsed = Date.now() - publishedAt;
    expect(elapsed).toBeLessThan(2_000);

    // Pod B's pmessage handler should have run but not aborted anything,
    // since it had no inflight entry. Sanity check the inflight map drained.
    expect(podA['inflight'].has(run.id)).toBe(false);
    expect(podB['inflight'].has(run.id)).toBe(false);
  });

  it('publishing for an unknown run is a clean no-op on every pod', async () => {
    podA = new Dispatcher({
      redis: redisA,
      runStore,
      flowStore,
      workerConcurrency: 1,
      llmFactory: () => ({ model: 'fake', step: async () => ({}) as never }),
      executorFactory: () => new ScriptedExecutor(),
    });
    podB = new Dispatcher({
      redis: redisB,
      runStore,
      flowStore,
      workerConcurrency: 1,
      llmFactory: () => ({ model: 'fake', step: async () => ({}) as never }),
      executorFactory: () => new ScriptedExecutor(),
    });
    await podA.start(queueName);
    await podB.start(`${queueName}_b_only`);

    cancelPublisher = new CancelPublisher(redisB);
    const recipients = await cancelPublisher.publish('run_does_not_exist', 'noop-test');
    // Both pods were psubscribe'd, so the message was delivered; neither
    // had an inflight handle so nothing aborts. No error thrown — the
    // pmessage handler short-circuits on the missing inflight entry.
    expect(recipients).toBeGreaterThanOrEqual(2);
  });
});

const waitFor = async (cond: () => boolean, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
};
