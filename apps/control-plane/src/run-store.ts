import { Injectable } from '@nestjs/common';
import { IdempotencyConflictError, newRunId } from '@pagerunner/shared';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dlq' | 'cancelled';

export interface StoredRun {
  id: string;
  flowId: string;
  flowVersion: number;
  status: RunStatus;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown> | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  costUsd: string;
  idempotencyKey?: string | null;
  errorCode?: string | null;
  createdAt: string;
}

export interface StoredStep {
  runId: string;
  idx: number;
  tool: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown> | null;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  latencyMs?: number | null;
  retryCount: number;
  errorCode?: string | null;
}

@Injectable()
export class RunStore {
  private readonly runs = new Map<string, StoredRun>();
  private readonly idemKeys = new Map<string, string>();
  private readonly steps = new Map<string, StoredStep[]>();

  create(input: {
    flowId: string;
    flowVersion: number;
    inputs: Record<string, unknown>;
    idempotencyKey?: string;
  }): StoredRun {
    if (input.idempotencyKey) {
      const existing = this.idemKeys.get(input.idempotencyKey);
      if (existing) {
        const stored = this.runs.get(existing);
        if (stored) return stored;
        throw new IdempotencyConflictError(input.idempotencyKey);
      }
    }
    const run: StoredRun = {
      id: newRunId(),
      flowId: input.flowId,
      flowVersion: input.flowVersion,
      status: 'queued',
      inputs: input.inputs,
      costUsd: '0',
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: new Date().toISOString(),
    };
    this.runs.set(run.id, run);
    if (input.idempotencyKey) this.idemKeys.set(input.idempotencyKey, run.id);
    this.steps.set(run.id, []);
    return run;
  }

  get(id: string): StoredRun | undefined {
    return this.runs.get(id);
  }

  list(opts: { status?: RunStatus; cursor?: string; limit?: number }): {
    runs: StoredRun[];
    nextCursor?: string;
  } {
    const limit = Math.min(opts.limit ?? 50, 200);
    let all = Array.from(this.runs.values()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (opts.status) all = all.filter((r) => r.status === opts.status);
    let start = 0;
    if (opts.cursor) {
      start = all.findIndex((r) => r.id === opts.cursor);
      if (start < 0) start = 0;
      else start += 1;
    }
    const page = all.slice(start, start + limit);
    const nextCursor = start + limit < all.length ? page[page.length - 1]?.id : undefined;
    return nextCursor !== undefined ? { runs: page, nextCursor } : { runs: page };
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
    const list = this.steps.get(step.runId);
    if (!list) return;
    list.push(step);
  }

  getSteps(runId: string): StoredStep[] {
    return this.steps.get(runId) ?? [];
  }

  setStatus(id: string, status: RunStatus, opts?: { errorCode?: string }): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.status = status;
    if (status === 'running' && !run.startedAt) run.startedAt = new Date().toISOString();
    if (['succeeded', 'failed', 'dlq', 'cancelled'].includes(status)) {
      run.finishedAt = new Date().toISOString();
    }
    if (opts?.errorCode) run.errorCode = opts.errorCode;
  }
}
