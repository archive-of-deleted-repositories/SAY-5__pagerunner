import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  const sql = postgres(url, { max: 1 });
  try {
    const ddl = readFileSync(join(process.cwd(), 'packages/db/migrations/0001_init.sql'), 'utf8');
    // postgres.js disallows multi-statement when prepared; use unsafe.
    await sql.unsafe(ddl);
    console.info('migrations applied');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
