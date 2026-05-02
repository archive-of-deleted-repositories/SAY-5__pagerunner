-- PageRunner initial schema. Generated to match packages/db/src/schema.ts.
-- runs is partitioned by month on created_at; default partition catches stragglers.

CREATE TYPE run_status AS ENUM ('queued','running','succeeded','failed','dlq','cancelled');
CREATE TYPE step_status AS ENUM ('pending','running','succeeded','failed','skipped');
CREATE TYPE artifact_kind AS ENUM ('screenshot','dom','trace','console');

CREATE TABLE tenants (
  id text PRIMARY KEY,
  name text NOT NULL,
  concurrency_cap integer NOT NULL DEFAULT 4,
  rate_per_sec integer NOT NULL DEFAULT 10,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE flows (
  id text NOT NULL,
  tenant_id text NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  version integer NOT NULL,
  dag jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);
CREATE INDEX flows_tenant_idx ON flows (tenant_id, created_at);

CREATE TABLE runs (
  id text NOT NULL,
  tenant_id text NOT NULL REFERENCES tenants(id),
  flow_id text NOT NULL,
  flow_version integer NOT NULL,
  status run_status NOT NULL DEFAULT 'queued',
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  outputs jsonb,
  target_domain text,
  started_at timestamptz,
  finished_at timestamptz,
  cost_usd numeric(10,6) NOT NULL DEFAULT 0,
  idempotency_key text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE runs_default PARTITION OF runs DEFAULT;
CREATE TABLE runs_2026_05 PARTITION OF runs FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE runs_2026_06 PARTITION OF runs FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE runs_2026_07 PARTITION OF runs FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE INDEX runs_tenant_status_idx ON runs (tenant_id, status, created_at DESC);
CREATE UNIQUE INDEX runs_idempotency_key_uniq ON runs (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE steps (
  run_id text NOT NULL,
  idx integer NOT NULL,
  tool text NOT NULL,
  input jsonb NOT NULL,
  output jsonb,
  status step_status NOT NULL DEFAULT 'pending',
  latency_ms integer,
  retry_count integer NOT NULL DEFAULT 0,
  error_code text,
  started_at timestamptz,
  PRIMARY KEY (run_id, idx)
);

CREATE TABLE artifacts (
  run_id text NOT NULL,
  step_idx integer NOT NULL,
  kind artifact_kind NOT NULL,
  s3_key text NOT NULL,
  bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, step_idx, kind)
);

CREATE TABLE failed_runs (
  run_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  flow_id text NOT NULL,
  error_code text NOT NULL,
  error_message text NOT NULL,
  trace_path text,
  failed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE eval_results (
  suite text NOT NULL,
  flow_id text NOT NULL,
  run_at timestamptz NOT NULL DEFAULT now(),
  success integer NOT NULL,
  steps integer NOT NULL,
  cost_usd numeric(10,6) NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL,
  model text NOT NULL,
  PRIMARY KEY (suite, flow_id, run_at)
);
