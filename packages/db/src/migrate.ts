import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  const dir = join(process.cwd(), 'packages/db/migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const sql = postgres(url, { max: 1 });
  try {
    for (const file of files) {
      const ddl = readFileSync(join(dir, file), 'utf8');
      // postgres.js disallows multi-statement when prepared; use unsafe.
      // The 0002 migration uses ALTER TYPE ADD VALUE IF NOT EXISTS so
      // re-running migrate against a freshly migrated DB is idempotent.
      await sql.unsafe(ddl);
      console.info(`applied ${file}`);
    }
    console.info('migrations applied');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
