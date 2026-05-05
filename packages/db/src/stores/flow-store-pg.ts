import { desc, eq } from 'drizzle-orm';
import { newFlowId } from '@pagerunner/shared';
import type { DB } from '../client.js';
import { flows } from '../schema.js';
import type { FlowStoreLike, StoredFlow } from './types.js';

const DEFAULT_TENANT = 'public';

export class PgFlowStore implements FlowStoreLike {
  constructor(private readonly db: DB) {}

  async create(input: {
    name: string;
    dag: StoredFlow['dag'];
    tenantId?: string;
    targetDomain?: string;
  }): Promise<StoredFlow> {
    const id = newFlowId();
    const tenantId = input.tenantId ?? DEFAULT_TENANT;
    const now = new Date();
    const [row] = await this.db
      .insert(flows)
      .values({
        id,
        tenantId,
        name: input.name,
        version: 1,
        dag: input.dag,
        createdAt: now,
      })
      .returning();
    if (!row) throw new Error('flow insert returned no row');
    return rowToStoredFlow(row, input.targetDomain);
  }

  async get(id: string): Promise<StoredFlow | undefined> {
    const rows = await this.db
      .select()
      .from(flows)
      .where(eq(flows.id, id))
      .orderBy(desc(flows.version))
      .limit(1);
    const first = rows[0];
    return first ? rowToStoredFlow(first) : undefined;
  }

  async count(): Promise<number> {
    const rows = await this.db.selectDistinct({ id: flows.id }).from(flows);
    return rows.length;
  }
}

const rowToStoredFlow = (row: typeof flows.$inferSelect, targetDomain?: string): StoredFlow => ({
  id: row.id,
  tenantId: row.tenantId,
  name: row.name,
  version: row.version,
  dag: row.dag as StoredFlow['dag'],
  targetDomain: targetDomain ?? null,
  createdAt: row.createdAt.toISOString(),
});
