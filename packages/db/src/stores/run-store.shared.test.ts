import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryRunStore } from './run-store-memory';
import { PgRunStore } from './run-store-pg';
import type { RunStoreLike } from './types';
import * as schema from '../schema';

interface Backend {
  name: string;
  build: () => Promise<{ store: RunStoreLike; cleanup: () => Promise<void> }>;
}

const memBackend: Backend = {
  name: 'memory',
  build: async () => ({ store: new MemoryRunStore(), cleanup: async () => undefined }),
};

const buildPgBackend = (databaseUrl: string): Backend => ({
  name: 'pg',
  build: async () => {
    const sql = postgres(databaseUrl, { max: 1, prepare: false });
    const db = drizzle(sql, { schema });
    // Reset schema each time so suites don't see stale rows.
    await sql.unsafe(`DROP TABLE IF EXISTS artifacts, steps, failed_runs, runs, flows CASCADE`);
    await sql.unsafe(`DROP TABLE IF EXISTS tenants, eval_results CASCADE`);
    await sql.unsafe(`DROP TYPE IF EXISTS run_status, step_status, artifact_kind CASCADE`);
    const ddl = readFileSync(join(__dirname, '..', '..', 'migrations', '0001_init.sql'), 'utf8');
    await sql.unsafe(ddl);
    await sql.unsafe(
      `INSERT INTO tenants(id, name) VALUES('public', 'public') ON CONFLICT DO NOTHING`,
    );
    return {
      store: new PgRunStore(db),
      cleanup: async () => {
        await sql.end({ timeout: 5 });
      },
    };
  },
});

const PG_URL = process.env.DATABASE_URL;
const backends: Backend[] = PG_URL ? [memBackend, buildPgBackend(PG_URL)] : [memBackend];

describe.each(backends)('RunStore [$name]', ({ build }) => {
  let store: RunStoreLike;
  let cleanup: () => Promise<void> = async () => undefined;

  beforeEach(async () => {
    const handle = await build();
    store = handle.store;
    cleanup = handle.cleanup;
  });

  afterEach(async () => {
    await cleanup();
    cleanup = async () => undefined;
  });

  it('creates and gets a run', async () => {
    const r = await store.create({ flowId: 'flow_a', flowVersion: 1, inputs: { a: 1 } });
    expect(r.status).toBe('queued');
    const fetched = await store.get(r.id);
    expect(fetched?.id).toBe(r.id);
    expect(fetched?.inputs).toEqual({ a: 1 });
  });

  it('returns existing run on idempotency replay', async () => {
    const a = await store.create({
      flowId: 'flow_a',
      flowVersion: 1,
      inputs: {},
      idempotencyKey: 'k1',
    });
    const b = await store.create({
      flowId: 'flow_a',
      flowVersion: 1,
      inputs: {},
      idempotencyKey: 'k1',
    });
    expect(b.id).toBe(a.id);
  });

  it('lists runs newest-first', async () => {
    const a = await store.create({ flowId: 'f', flowVersion: 1, inputs: {} });
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create({ flowId: 'f', flowVersion: 1, inputs: {} });
    const list = await store.list({});
    expect(list.runs[0]?.id).toBe(b.id);
    expect(list.runs[1]?.id).toBe(a.id);
  });

  it('paginates with opaque cursor', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await store.create({ flowId: 'f', flowVersion: 1, inputs: { i } });
      ids.push(r.id);
      await new Promise((res) => setTimeout(res, 2));
    }
    const page1 = await store.list({ limit: 2 });
    expect(page1.runs).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await store.list({ limit: 2, cursor: page1.nextCursor });
    expect(page2.runs).toHaveLength(2);
    expect(page2.runs.map((r) => r.id)).not.toEqual(page1.runs.map((r) => r.id));

    const page3 = await store.list({ limit: 2, cursor: page2.nextCursor });
    expect(page3.runs).toHaveLength(1);
    expect(page3.nextCursor).toBeUndefined();
  });

  it('cancels a queued run and refuses to cancel a finished one', async () => {
    const r = await store.create({ flowId: 'f', flowVersion: 1, inputs: {} });
    expect(await store.cancel(r.id)).toBe(true);
    expect(await store.cancel(r.id)).toBe(false);
  });

  it('appends and reads steps', async () => {
    const r = await store.create({ flowId: 'f', flowVersion: 1, inputs: {} });
    await store.appendStep({
      runId: r.id,
      idx: 0,
      tool: 'navigate',
      input: { url: 'http://x.test/' },
      status: 'succeeded',
      retryCount: 0,
    });
    await store.appendStep({
      runId: r.id,
      idx: 1,
      tool: 'finish',
      input: { result: { ok: true } },
      status: 'succeeded',
      retryCount: 0,
    });
    const steps = await store.getSteps(r.id);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.tool).toBe('navigate');
    expect(steps[1]?.tool).toBe('finish');
  });

  it('updates status with a terminal timestamp', async () => {
    const r = await store.create({ flowId: 'f', flowVersion: 1, inputs: {} });
    await store.setStatus(r.id, 'running');
    await store.setStatus(r.id, 'succeeded', { costUsd: '0.01', outputs: { x: 1 } });
    const fetched = await store.get(r.id);
    expect(fetched?.status).toBe('succeeded');
    expect(fetched?.outputs).toEqual({ x: 1 });
  });
});
