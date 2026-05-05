import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { newRunId } from '@pagerunner/shared';
import type { DB } from '../client.js';
import { artifacts, failedRuns, runs, steps } from '../schema.js';
import {
  decodeCursor,
  encodeCursor,
  type CreateRunInput,
  type ListRunsOpts,
  type ListRunsResult,
  type RunStatus,
  type RunStoreLike,
  type StoredRun,
  type StoredStep,
} from './types.js';

const DEFAULT_TENANT = 'public';

const monthKey = (d: Date): string => {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}_${mm}`;
};

const monthRange = (d: Date): { from: string; to: string } => {
  const yyyy = d.getUTCFullYear();
  const mm = d.getUTCMonth();
  const from = new Date(Date.UTC(yyyy, mm, 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(yyyy, mm + 1, 1)).toISOString().slice(0, 10);
  return { from, to };
};

/** Drizzle-backed RunStore. Lazily creates monthly partitions on first insert. */
export class PgRunStore implements RunStoreLike {
  private readonly partitionsEnsured = new Set<string>();

  constructor(private readonly db: DB) {}

  private async ensurePartition(d: Date): Promise<void> {
    const key = monthKey(d);
    if (this.partitionsEnsured.has(key)) return;
    const { from, to } = monthRange(d);
    const tableName = `runs_${key}`;
    // CREATE TABLE IF NOT EXISTS is the idempotent path; the FOR VALUES clause
    // is fixed by month so racing creators all converge to the same DDL.
    await this.db.execute(
      sql.raw(
        `CREATE TABLE IF NOT EXISTS ${tableName} PARTITION OF runs FOR VALUES FROM ('${from}') TO ('${to}')`,
      ),
    );
    this.partitionsEnsured.add(key);
  }

  async create(input: CreateRunInput): Promise<StoredRun> {
    const tenantId = input.tenantId ?? DEFAULT_TENANT;
    const now = new Date();
    await this.ensurePartition(now);

    const id = newRunId();
    const row = {
      id,
      tenantId,
      flowId: input.flowId,
      flowVersion: input.flowVersion,
      status: 'queued' as const,
      inputs: input.inputs,
      idempotencyKey: input.idempotencyKey ?? null,
      targetDomain: input.targetDomain ?? null,
      createdAt: now,
    };

    try {
      const [inserted] = await this.db.insert(runs).values(row).returning();
      if (!inserted) throw new Error('insert returned no row');
      return rowToStoredRun(inserted);
    } catch (err) {
      // Postgres unique violation when (tenant_id, idempotency_key) collides.
      const code = (err as { code?: string }).code;
      if (code === '23505' && input.idempotencyKey) {
        const existing = await this.db
          .select()
          .from(runs)
          .where(and(eq(runs.tenantId, tenantId), eq(runs.idempotencyKey, input.idempotencyKey)))
          .limit(1);
        const first = existing[0];
        if (first) return rowToStoredRun(first);
      }
      throw err;
    }
  }

  async get(id: string): Promise<StoredRun | undefined> {
    const rows = await this.db.select().from(runs).where(eq(runs.id, id)).limit(1);
    const row = rows[0];
    return row ? rowToStoredRun(row) : undefined;
  }

  async list(opts: ListRunsOpts): Promise<ListRunsResult> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const conds = [] as Array<ReturnType<typeof eq>>;
    if (opts.tenantId) conds.push(eq(runs.tenantId, opts.tenantId));
    if (opts.status) conds.push(eq(runs.status, opts.status));
    if (opts.cursor) {
      const decoded = decodeCursor(opts.cursor);
      if (decoded) {
        const cutoff = new Date(decoded.createdAt);
        // Strict (created_at, id) keyset pagination.
        conds.push(
          or(
            lt(runs.createdAt, cutoff),
            and(eq(runs.createdAt, cutoff), lt(runs.id, decoded.runId)),
          ) as ReturnType<typeof eq>,
        );
      }
    }
    const where = conds.length > 0 ? and(...conds) : undefined;
    const rows = await this.db
      .select()
      .from(runs)
      .where(where)
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(limit + 1);
    const slice = rows.slice(0, limit).map(rowToStoredRun);
    const hasMore = rows.length > limit;
    const last = slice[slice.length - 1];
    return hasMore && last
      ? { runs: slice, nextCursor: encodeCursor(last.createdAt, last.id) }
      : { runs: slice };
  }

  async cancel(id: string): Promise<boolean> {
    const updated = await this.db
      .update(runs)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(runs.id, id), or(eq(runs.status, 'queued'), eq(runs.status, 'running'))))
      .returning({ id: runs.id });
    return updated.length > 0;
  }

  async appendStep(step: StoredStep): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(steps).values({
        runId: step.runId,
        idx: step.idx,
        tool: step.tool,
        input: step.input,
        output: step.output ?? null,
        status: step.status,
        latencyMs: step.latencyMs ?? null,
        retryCount: step.retryCount,
        errorCode: step.errorCode ?? null,
        startedAt: new Date(),
      });
    });
  }

  async getSteps(runId: string): Promise<StoredStep[]> {
    const rows = await this.db.select().from(steps).where(eq(steps.runId, runId));
    return rows
      .sort((a, b) => a.idx - b.idx)
      .map(
        (r): StoredStep => ({
          runId: r.runId,
          idx: r.idx,
          tool: r.tool,
          input: (r.input ?? {}) as Record<string, unknown>,
          output: (r.output ?? null) as Record<string, unknown> | null,
          status: r.status as StoredStep['status'],
          latencyMs: r.latencyMs,
          retryCount: r.retryCount,
          errorCode: r.errorCode,
        }),
      );
  }

  async setStatus(
    id: string,
    status: RunStatus,
    opts?: { errorCode?: string; outputs?: Record<string, unknown>; costUsd?: string },
  ): Promise<void> {
    const patch: Record<string, unknown> = { status };
    if (status === 'running') patch['startedAt'] = new Date();
    if (['succeeded', 'failed', 'dlq', 'cancelled'].includes(status)) {
      patch['finishedAt'] = new Date();
    }
    if (opts?.errorCode) patch['errorCode'] = opts.errorCode;
    if (opts?.outputs) patch['outputs'] = opts.outputs;
    if (opts?.costUsd !== undefined) patch['costUsd'] = opts.costUsd;
    await this.db.update(runs).set(patch).where(eq(runs.id, id));
  }

  async recordArtifact(
    runId: string,
    stepIdx: number,
    kind: 'screenshot' | 'dom' | 'trace' | 'console',
    s3Key: string,
    bytes: number,
  ): Promise<void> {
    await this.db
      .insert(artifacts)
      .values({ runId, stepIdx, kind, s3Key, bytes })
      .onConflictDoUpdate({
        target: [artifacts.runId, artifacts.stepIdx, artifacts.kind],
        set: { s3Key, bytes },
      });
  }

  async recordFailure(
    runId: string,
    payload: { tenantId: string; flowId: string; errorCode: string; errorMessage: string },
  ): Promise<void> {
    await this.db
      .insert(failedRuns)
      .values({
        runId,
        tenantId: payload.tenantId,
        flowId: payload.flowId,
        errorCode: payload.errorCode,
        errorMessage: payload.errorMessage,
      })
      .onConflictDoNothing();
  }
}

const rowToStoredRun = (row: typeof runs.$inferSelect): StoredRun => ({
  id: row.id,
  tenantId: row.tenantId,
  flowId: row.flowId,
  flowVersion: row.flowVersion,
  status: row.status as RunStatus,
  inputs: (row.inputs ?? {}) as Record<string, unknown>,
  outputs: (row.outputs ?? null) as Record<string, unknown> | null,
  startedAt: row.startedAt ? row.startedAt.toISOString() : null,
  finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  costUsd: row.costUsd,
  idempotencyKey: row.idempotencyKey,
  targetDomain: row.targetDomain,
  errorCode: row.errorCode,
  createdAt: row.createdAt.toISOString(),
});
