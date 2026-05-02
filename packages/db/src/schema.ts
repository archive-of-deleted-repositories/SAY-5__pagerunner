import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  numeric,
  pgEnum,
  uniqueIndex,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';

export const runStatus = pgEnum('run_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'dlq',
  'cancelled',
]);

export const stepStatus = pgEnum('step_status', [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
]);

export const artifactKind = pgEnum('artifact_kind', ['screenshot', 'dom', 'trace', 'console']);

export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  concurrencyCap: integer('concurrency_cap').notNull().default(4),
  ratePerSec: integer('rate_per_sec').notNull().default(10),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const flows = pgTable(
  'flows',
  {
    id: text('id').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    version: integer('version').notNull(),
    dag: jsonb('dag').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.version] }),
    byTenant: index('flows_tenant_idx').on(t.tenantId, t.createdAt),
  }),
);

export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    flowId: text('flow_id').notNull(),
    flowVersion: integer('flow_version').notNull(),
    status: runStatus('status').notNull().default('queued'),
    inputs: jsonb('inputs').notNull().default({}),
    outputs: jsonb('outputs'),
    targetDomain: text('target_domain'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),
    idempotencyKey: text('idempotency_key'),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTenantStatus: index('runs_tenant_status_idx').on(t.tenantId, t.status, t.createdAt),
    uniqIdem: uniqueIndex('runs_idempotency_key_uniq').on(t.tenantId, t.idempotencyKey),
  }),
);

export const steps = pgTable(
  'steps',
  {
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    tool: text('tool').notNull(),
    input: jsonb('input').notNull(),
    output: jsonb('output'),
    status: stepStatus('status').notNull().default('pending'),
    latencyMs: integer('latency_ms'),
    retryCount: integer('retry_count').notNull().default(0),
    errorCode: text('error_code'),
    startedAt: timestamp('started_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.idx] }),
  }),
);

export const artifacts = pgTable(
  'artifacts',
  {
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepIdx: integer('step_idx').notNull(),
    kind: artifactKind('kind').notNull(),
    s3Key: text('s3_key').notNull(),
    bytes: integer('bytes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.stepIdx, t.kind] }),
  }),
);

export const failedRuns = pgTable('failed_runs', {
  runId: text('run_id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  flowId: text('flow_id').notNull(),
  errorCode: text('error_code').notNull(),
  errorMessage: text('error_message').notNull(),
  tracePath: text('trace_path'),
  failedAt: timestamp('failed_at', { withTimezone: true }).notNull().defaultNow(),
});

export const evalResults = pgTable(
  'eval_results',
  {
    suite: text('suite').notNull(),
    flowId: text('flow_id').notNull(),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    success: integer('success').notNull(),
    steps: integer('steps').notNull(),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),
    latencyMs: integer('latency_ms').notNull(),
    model: text('model').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.suite, t.flowId, t.runAt] }),
  }),
);

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type Step = typeof steps.$inferSelect;
export type NewStep = typeof steps.$inferInsert;
export type Flow = typeof flows.$inferSelect;
export type NewFlow = typeof flows.$inferInsert;
