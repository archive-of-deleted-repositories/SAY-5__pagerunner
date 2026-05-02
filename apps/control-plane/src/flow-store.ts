import { Injectable } from '@nestjs/common';
import { newFlowId } from '@pagerunner/shared';
import { validateDag } from './dag-validator.js';

export interface StoredFlow {
  id: string;
  version: number;
  name: string;
  dag: {
    nodes: Array<{ id: string; tool: string; next?: string; branches?: Record<string, string> }>;
  };
  createdAt: string;
}

/**
 * In-memory flow store. The Postgres-backed implementation lives in the
 * runner once Drizzle migrations have been applied; this keeps the API
 * runnable in CI and unit tests without a database.
 */
@Injectable()
export class FlowStore {
  private readonly flows = new Map<string, StoredFlow[]>();

  create(input: { name: string; dag: StoredFlow['dag'] }): StoredFlow {
    validateDag(input.dag);
    const id = newFlowId();
    const flow: StoredFlow = {
      id,
      version: 1,
      name: input.name,
      dag: input.dag,
      createdAt: new Date().toISOString(),
    };
    this.flows.set(id, [flow]);
    return flow;
  }

  get(id: string): StoredFlow | undefined {
    const versions = this.flows.get(id);
    if (!versions || versions.length === 0) return undefined;
    return versions[versions.length - 1];
  }

  count(): number {
    return this.flows.size;
  }
}
