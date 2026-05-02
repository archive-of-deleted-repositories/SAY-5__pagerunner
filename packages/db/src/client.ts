import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type DB = PostgresJsDatabase<typeof schema>;

let cached: { db: DB; sql: postgres.Sql } | null = null;

export function getDb(url = process.env.DATABASE_URL): { db: DB; sql: postgres.Sql } {
  if (cached) return cached;
  if (!url) throw new Error('DATABASE_URL not set');
  const sql = postgres(url, { max: 10, prepare: false });
  const db = drizzle(sql, { schema });
  cached = { db, sql };
  return cached;
}

export const closeDb = async (): Promise<void> => {
  if (cached) {
    await cached.sql.end({ timeout: 5 });
    cached = null;
  }
};
