/**
 * Test database: PGlite — real Postgres compiled to WASM, in-process.
 *
 * This matters for correctness, not convenience: the repository's SQL runs
 * unmodified, so `date_trunc(... AT TIME ZONE 'UTC')`, `ANY($1::text[])`, BIGINT
 * arithmetic and the CHECK constraints are all genuinely exercised. A hand-rolled
 * in-memory fake would test our reimplementation of Postgres instead of the
 * query that ships.
 */

import { PGlite } from '@electric-sql/pglite';
import type { Executor, QueryResult, TransactionalExecutor } from '../../src/db/Executor.js';
import { runMigrations } from '../../src/db/migrate.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CanonicalStatus } from '../../src/revenue/canonical.js';
import type { NormalizedTransaction } from '../../src/sources/SourceAdapter.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'db',
  'migrations',
);

export interface TestDb extends TransactionalExecutor {
  close(): Promise<void>;
  truncate(): Promise<void>;
}

/** The subset of PGlite that both the top-level instance and a tx expose. */
interface PgliteLike {
  query(sql: string, params?: unknown[]): Promise<{ rows?: unknown[]; affectedRows?: number }>;
  exec(sql: string): Promise<{ rows?: unknown[]; affectedRows?: number }[]>;
}

export async function createTestDb(): Promise<TestDb> {
  const pg = new PGlite();
  await pg.waitReady;

  const wrap = (client: PgliteLike): Executor => ({
    async query<T>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
      // `exec` is used for parameterless SQL because migrations arrive as a
      // multi-statement batch, which `query` will not accept.
      const res = params.length
        ? await client.query(sql, params as unknown[])
        : await client.exec(sql).then((results) => results[results.length - 1] ?? {});
      const rows = (res.rows ?? []) as T[];
      return { rows, rowCount: res.affectedRows ?? rows.length };
    },
  });

  const base = wrap(pg as unknown as PgliteLike);

  const db: TestDb = {
    query: base.query,
    async transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
      return pg.transaction(async (tx) => fn(wrap(tx as unknown as PgliteLike)));
    },
    async close() {
      await pg.close();
    },
    async truncate() {
      await pg.exec(
        'TRUNCATE transactions, quarantined_transactions, sync_state RESTART IDENTITY',
      );
    },
  };

  await runMigrations(db, MIGRATIONS_DIR);
  return db;
}

/** Convenience factory for a normalized transaction in tests. */
export function tx(overrides: Partial<NormalizedTransaction> & { externalId: string }): NormalizedTransaction {
  return {
    source: 'test',
    amountMinor: 1000n,
    amountRefundedMinor: 0n,
    currency: 'usd',
    rawStatus: 'succeeded',
    canonicalStatus: CanonicalStatus.COLLECTED,
    occurredAt: new Date('2026-07-01T12:00:00.000Z'),
    ...overrides,
  };
}
