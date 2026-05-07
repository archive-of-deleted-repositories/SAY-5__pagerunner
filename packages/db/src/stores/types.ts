/**
 * Store interfaces shared by the in-memory and Drizzle-backed implementations.
 * Same surface area so the control-plane and runner can swap them
 * transparently in tests vs. production.
 */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'dlq'
  | 'cancelled';

export interface StoredRun {
  id: string;
  tenantId: string;
  flowId: string;
  flowVersion: number;
  status: RunStatus;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown> | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  costUsd: string;
  targetDomain?: string | null;
  idempotencyKey?: string | null;
  errorCode?: string | null;
  createdAt: string;
}

export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface StoredStep {
  runId: string;
  idx: number;
  tool: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown> | null;
  status: StepStatus;
  latencyMs?: number | null;
  retryCount: number;
  errorCode?: string | null;
}

export interface CreateRunInput {
  tenantId?: string;
  flowId: string;
  flowVersion: number;
  inputs: Record<string, unknown>;
  idempotencyKey?: string;
  targetDomain?: string;
}

export interface ListRunsOpts {
  tenantId?: string;
  status?: RunStatus;
  cursor?: string;
  limit?: number;
}

export interface ListRunsResult {
  runs: StoredRun[];
  nextCursor?: string;
}

export interface RunStoreLike {
  create(input: CreateRunInput): Promise<StoredRun> | StoredRun;
  get(id: string): Promise<StoredRun | undefined> | StoredRun | undefined;
  list(opts: ListRunsOpts): Promise<ListRunsResult> | ListRunsResult;
  cancel(id: string): Promise<boolean> | boolean;
  appendStep(step: StoredStep): Promise<void> | void;
  getSteps(runId: string): Promise<StoredStep[]> | StoredStep[];
  setStatus(
    id: string,
    status: RunStatus,
    opts?: { errorCode?: string; outputs?: Record<string, unknown>; costUsd?: string },
  ): Promise<void> | void;
  recordArtifact?(
    runId: string,
    stepIdx: number,
    kind: 'screenshot' | 'dom' | 'trace' | 'console',
    s3Key: string,
    bytes: number,
  ): Promise<void> | void;
  recordFailure?(
    runId: string,
    payload: { tenantId: string; flowId: string; errorCode: string; errorMessage: string },
  ): Promise<void> | void;
}

export interface StoredFlow {
  id: string;
  tenantId: string;
  name: string;
  version: number;
  dag: {
    nodes: Array<{
      id: string;
      tool: string;
      next?: string;
      branches?: Record<string, string>;
    }>;
  };
  targetDomain?: string | null;
  createdAt: string;
}

export interface FlowStoreLike {
  create(input: {
    name: string;
    dag: StoredFlow['dag'];
    tenantId?: string;
    targetDomain?: string;
  }): Promise<StoredFlow> | StoredFlow;
  get(id: string): Promise<StoredFlow | undefined> | StoredFlow | undefined;
  count(): Promise<number> | number;
}

const CURSOR_PREFIX = 'pr_';

export const encodeCursor = (createdAtIso: string, runId: string): string =>
  CURSOR_PREFIX + Buffer.from(`${createdAtIso}|${runId}`, 'utf8').toString('base64url');

export const decodeCursor = (cursor: string): { createdAt: string; runId: string } | null => {
  try {
    const stripped = cursor.startsWith(CURSOR_PREFIX) ? cursor.slice(CURSOR_PREFIX.length) : cursor;
    const decoded = Buffer.from(stripped, 'base64url').toString('utf8');
    const [createdAt, runId] = decoded.split('|');
    if (!createdAt || !runId) return null;
    return { createdAt, runId };
  } catch {
    return null;
  }
};
