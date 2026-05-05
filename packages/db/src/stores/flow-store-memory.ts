import { newFlowId } from '@pagerunner/shared';
import type { FlowStoreLike, StoredFlow } from './types.js';

const DEFAULT_TENANT = 'public';

export class MemoryFlowStore implements FlowStoreLike {
  private readonly flows = new Map<string, StoredFlow[]>();

  create(input: {
    name: string;
    dag: StoredFlow['dag'];
    tenantId?: string;
    targetDomain?: string;
  }): StoredFlow {
    const id = newFlowId();
    const flow: StoredFlow = {
      id,
      tenantId: input.tenantId ?? DEFAULT_TENANT,
      name: input.name,
      version: 1,
      dag: input.dag,
      targetDomain: input.targetDomain ?? null,
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
