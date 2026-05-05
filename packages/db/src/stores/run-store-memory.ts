import { newRunId } from '@pagerunner/shared';
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

/**
 * In-memory RunStore. Keeps the surface area used by the control-plane
 * and unit tests honest without touching Postgres. Cursors are opaque
 * base64 of `(created_at_iso, run_id)` so the contract matches the
 * Drizzle-backed store byte-for-byte.
 */
export class MemoryRunStore implements RunStoreLike {
  private readonly runs = new Map<string, StoredRun>();
  private readonly idemKeys = new Map<string, string>();
  private readonly steps = new Map<string, StoredStep[]>();
  private readonly artifacts: Array<{
    runId: string;
    stepIdx: number;
    kind: string;
    s3Key: string;
    bytes: number;
  }> = [];
  private readonly failures: Array<{
    runId: string;
    tenantId: string;
    flowId: string;
    errorCode: string;
    errorMessage: string;
  }> = [];

  create(input: CreateRunInput): StoredRun {
    const tenantId = input.tenantId ?? DEFAULT_TENANT;
    if (input.idempotencyKey) {
      const key = `${tenantId}:${input.idempotencyKey}`;
      const existingId = this.idemKeys.get(key);
      if (existingId) {
        const existing = this.runs.get(existingId);
        if (existing) return existing;
      }
    }
    const run: StoredRun = {
      id: newRunId(),
      tenantId,
      flowId: input.flowId,
      flowVersion: input.flowVersion,
      status: 'queued',
      inputs: input.inputs,
      costUsd: '0',
      idempotencyKey: input.idempotencyKey ?? null,
      targetDomain: input.targetDomain ?? null,
      createdAt: new Date().toISOString(),
    };
    this.runs.set(run.id, run);
    if (input.idempotencyKey) {
      this.idemKeys.set(`${tenantId}:${input.idempotencyKey}`, run.id);
    }
    this.steps.set(run.id, []);
    return run;
  }

  get(id: string): StoredRun | undefined {
    return this.runs.get(id);
  }

  list(opts: ListRunsOpts): ListRunsResult {
    const limit = Math.min(opts.limit ?? 50, 200);
    let all = Array.from(this.runs.values()).sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1,
    );
    if (opts.tenantId) all = all.filter((r) => r.tenantId === opts.tenantId);
    if (opts.status) all = all.filter((r) => r.status === opts.status);
    let start = 0;
    if (opts.cursor) {
      const decoded = decodeCursor(opts.cursor);
      if (decoded) {
        const idx = all.findIndex(
          (r) => r.createdAt === decoded.createdAt && r.id === decoded.runId,
        );
        start = idx >= 0 ? idx + 1 : 0;
      }
    }
    const page = all.slice(start, start + limit);
    const last = page[page.length - 1];
    if (start + limit < all.length && last) {
      return { runs: page, nextCursor: encodeCursor(last.createdAt, last.id) };
    }
    return { runs: page };
  }

  cancel(id: string): boolean {
    const run = this.runs.get(id);
    if (!run) return false;
    if (run.status === 'queued' || run.status === 'running') {
      run.status = 'cancelled';
      run.finishedAt = new Date().toISOString();
      return true;
    }
    return false;
  }

  appendStep(step: StoredStep): void {
    const list = this.steps.get(step.runId) ?? [];
    list.push(step);
    this.steps.set(step.runId, list);
  }

  getSteps(runId: string): StoredStep[] {
    return [...(this.steps.get(runId) ?? [])];
  }

  setStatus(
    id: string,
    status: RunStatus,
    opts?: { errorCode?: string; outputs?: Record<string, unknown>; costUsd?: string },
  ): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.status = status;
    if (status === 'running' && !run.startedAt) run.startedAt = new Date().toISOString();
    if (['succeeded', 'failed', 'dlq', 'cancelled'].includes(status)) {
      run.finishedAt = new Date().toISOString();
    }
    if (opts?.errorCode) run.errorCode = opts.errorCode;
    if (opts?.outputs) run.outputs = opts.outputs;
    if (opts?.costUsd !== undefined) run.costUsd = opts.costUsd;
  }

  recordArtifact(
    runId: string,
    stepIdx: number,
    kind: 'screenshot' | 'dom' | 'trace' | 'console',
    s3Key: string,
    bytes: number,
  ): void {
    this.artifacts.push({ runId, stepIdx, kind, s3Key, bytes });
  }

  recordFailure(
    runId: string,
    payload: { tenantId: string; flowId: string; errorCode: string; errorMessage: string },
  ): void {
    this.failures.push({ runId, ...payload });
  }

  getArtifacts(
    runId: string,
  ): Array<{ stepIdx: number; kind: string; s3Key: string; bytes: number }> {
    return this.artifacts
      .filter((a) => a.runId === runId)
      .map(({ stepIdx, kind, s3Key, bytes }) => ({ stepIdx, kind, s3Key, bytes }));
  }

  getFailures(): typeof this.failures {
    return [...this.failures];
  }
}
