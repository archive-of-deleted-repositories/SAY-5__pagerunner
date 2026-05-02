/**
 * BullMQ worker shell. Production wiring depends on Redis at boot which is
 * unavailable during unit tests, so the actual consumer construction is
 * deferred. Keeping this isolated lets `apps/runner/src/main.ts` import it
 * without dragging Redis into Jest.
 */
export async function startWorker(): Promise<void> {
  const { Worker } = await import('bullmq');
  const { Redis } = await import('ioredis');
  const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  const worker = new Worker(
    'runs',
    async (job) => {
      // Job payload is `{ runId, flowId, tenantId, traceId }`. The actual
      // execution lives in agent/loop.ts and is invoked by the dispatcher
      // wired in production startup. The dispatcher import is kept dynamic
      // so importing this file does not pull Playwright into test runs.
      const { dispatch } = await import('./agent/dispatch.js');
      return dispatch(job.data as Record<string, unknown>);
    },
    { connection, concurrency: 4 },
  );
  return new Promise((resolve) => {
    worker.on('ready', () => resolve());
  });
}
