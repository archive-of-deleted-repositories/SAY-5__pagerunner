import { Injectable } from '@nestjs/common';
import { MemoryFlowStore, type StoredFlow } from '@pagerunner/db';
import { validateDag } from './dag-validator.js';

export type { StoredFlow };

/**
 * Adapter around the package-level MemoryFlowStore that adds the
 * NestJS-specific DAG validation hook. Production deployments swap this
 * with PgFlowStore via a different module import.
 */
@Injectable()
export class FlowStore {
  private readonly inner = new MemoryFlowStore();

  create(input: { name: string; dag: StoredFlow['dag'] }): StoredFlow {
    validateDag(input.dag);
    return this.inner.create(input);
  }

  get(id: string): StoredFlow | undefined {
    return this.inner.get(id);
  }

  count(): number {
    return this.inner.count();
  }
}
