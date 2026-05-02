export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dlq' | 'cancelled';

export interface FlowDag {
  nodes: Array<{
    id: string;
    tool: 'navigate' | 'click' | 'type' | 'extract' | 'wait' | 'finish';
    next?: string;
    branches?: Record<string, string>;
  }>;
}

export interface Flow {
  id: string;
  version: number;
  name: string;
  dag: FlowDag;
}

export interface CreateFlowRequest {
  name: string;
  dag: FlowDag;
}

export interface CreateRunRequest {
  flowId: string;
  inputs?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface Run {
  id: string;
  flowId: string;
  flowVersion: number;
  status: RunStatus;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown> | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  costUsd: string;
  errorCode?: string | null;
}

export interface Step {
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

export interface RunDetail extends Run {
  steps: Step[];
}

export interface RunList {
  runs: Run[];
  nextCursor?: string;
}

export interface RunEvent {
  id: string;
  type: 'step.started' | 'step.succeeded' | 'step.failed' | 'run.completed' | 'run.failed';
  data: Record<string, unknown>;
}
