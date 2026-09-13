import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { databaseCredentials } from '../config.js';

async function main() {
  const pool = new Pool({ ...databaseCredentials(), max: 1, connectionTimeoutMillis: 5000 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: resolve(process.cwd(), 'drizzle') });
    console.log('Database migrations applied successfully.');
  } finally {
    await pool.end();
  }
}

void main().catch(() => {
  console.error('Migration failed. Check database connectivity, credentials, and migration SQL.');
  process.exitCode = 1;
});
