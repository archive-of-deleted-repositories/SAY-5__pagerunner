import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

type Status = 'queued' | 'running' | 'succeeded' | 'failed' | 'dlq' | 'cancelled';
const STATUSES: Array<[Status, number]> = [
  ['succeeded', 0.78],
  ['failed', 0.1],
  ['dlq', 0.04],
  ['cancelled', 0.03],
  ['running', 0.03],
  ['queued', 0.02],
];

function pickStatus(rand: number): Status {
  let acc = 0;
  for (const [s, p] of STATUSES) {
    acc += p;
    if (rand < acc) return s;
  }
  return 'succeeded';
}

const FLOWS = [
  {
    id: 'flow_login_scrape',
    name: 'login then scrape',
    domain: 'mock-login.local',
    dag: {
      nodes: [
        { id: 'navigate', tool: 'navigate', next: 'fill_user' },
        { id: 'fill_user', tool: 'type', next: 'fill_pw' },
        { id: 'fill_pw', tool: 'type', next: 'submit' },
        { id: 'submit', tool: 'click', next: 'extract' },
        { id: 'extract', tool: 'extract', next: 'finish' },
        { id: 'finish', tool: 'finish' },
      ],
    },
  },
  {
    id: 'flow_multi_form',
    name: 'multi-page form',
    domain: 'mock-form.local',
    dag: {
      nodes: [
        { id: 'navigate', tool: 'navigate', next: 'page1' },
        { id: 'page1', tool: 'type', next: 'next1' },
        { id: 'next1', tool: 'click', next: 'page2' },
        { id: 'page2', tool: 'type', next: 'submit' },
        { id: 'submit', tool: 'click', next: 'finish' },
        { id: 'finish', tool: 'finish' },
      ],
    },
  },
  {
    id: 'flow_checkout',
    name: 'checkout simulation',
    domain: 'mock-shop.local',
    dag: {
      nodes: [
        { id: 'navigate', tool: 'navigate', next: 'add_to_cart' },
        { id: 'add_to_cart', tool: 'click', next: 'go_cart' },
        { id: 'go_cart', tool: 'click', next: 'checkout' },
        { id: 'checkout', tool: 'click', next: 'finish' },
        { id: 'finish', tool: 'finish' },
      ],
    },
  },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  const sql = postgres(url, { max: 1 });
  try {
    await sql`INSERT INTO tenants (id, name) VALUES ('tn_demo', 'demo')
      ON CONFLICT (id) DO NOTHING`;
    for (const f of FLOWS) {
      await sql`INSERT INTO flows (id, tenant_id, name, version, dag)
        VALUES (${f.id}, 'tn_demo', ${f.name}, 1, ${JSON.stringify(f.dag)})
        ON CONFLICT DO NOTHING`;
    }

    // 500 fake runs with realistic distribution.
    const now = Date.now();
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 500; i++) {
      const flow = FLOWS[i % FLOWS.length]!;
      const status = pickStatus(Math.random());
      const startedOffset = Math.floor(Math.random() * 7 * 24 * 3600 * 1000);
      const startedAt = new Date(now - startedOffset);
      const latency = 5_000 + Math.floor(Math.random() * 90_000);
      const finishedAt = ['succeeded', 'failed', 'dlq', 'cancelled'].includes(status)
        ? new Date(startedAt.getTime() + latency)
        : null;
      rows.push({
        id: `run_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        tenant_id: 'tn_demo',
        flow_id: flow.id,
        flow_version: 1,
        status,
        target_domain: flow.domain,
        started_at: startedAt,
        finished_at: finishedAt,
        cost_usd: (Math.random() * 0.07).toFixed(6),
        created_at: startedAt,
      });
    }
    for (const r of rows) {
      await sql`INSERT INTO runs ${sql(r as Record<string, unknown>)}`;
    }
    console.info(`seeded ${rows.length} runs`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
