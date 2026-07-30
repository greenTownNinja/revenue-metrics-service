/**
 * Migration runner. Applies every `NNN_*.sql` in `migrations/` in order and
 * records what ran, so re-running is a no-op.
 */

// First import, so `npm run migrate` picks up DATABASE_URL from .env. Harmless
// when this module is imported by server.ts, which loads dotenv itself.
import 'dotenv/config';

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Executor } from './Executor.js';
import { logger } from '../logger.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function runMigrations(db: Executor, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  const { rows } = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    // Each file is a single statement batch; PGlite and pg both accept multiple
    // statements in one query when there are no bind parameters.
    await db.query(sql);
    await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    logger.info({ migration: file }, 'migration applied');
    ran.push(file);
  }

  if (ran.length === 0) logger.info('schema up to date');
  return ran;
}

// Allow `npm run migrate` to run this standalone, from source or from dist.
if (process.argv[1] && /migrate\.[tj]s$/.test(process.argv[1])) {
  const { createExecutor, closePool } = await import('./pool.js');
  try {
    await runMigrations(createExecutor());
  } finally {
    await closePool();
  }
}
