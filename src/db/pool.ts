/**
 * Postgres connection pool.
 *
 * One data path, deliberately. Adding the Supabase JS client alongside raw SQL
 * would create a second place revenue could be queried from, which is the drift
 * this service exists to prevent.
 */

import pg from 'pg';
import type { Executor, QueryResult, TransactionalExecutor } from './Executor.js';
import { ConfigError, DatabaseError } from '../errors.js';
import { logger } from '../logger.js';

/**
 * BIGINT (oid 20) arrives as a string by default because it can exceed
 * Number.MAX_SAFE_INTEGER. We keep it a string here and convert deliberately at
 * the repository boundary — never with `+`, which would concatenate.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new ConfigError(
      'DATABASE_URL is not set. Use the Supabase connection POOLER string ' +
        '(aws-0-<region>.pooler.supabase.com), not the direct db.<ref>.supabase.co host.',
    );
  }

  pool = new pg.Pool({
    connectionString,
    // Supabase's pooler plus a Render free instance will not tolerate a large
    // pool; 3 is comfortable and leaves headroom for the migration runner.
    max: Number(process.env.PG_POOL_MAX ?? 3),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Supabase terminates TLS with its own CA; verification is not available on
    // the pooled connection string.
    ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
  });

  // An idle-client error must not take the process down.
  pool.on('error', (err) => {
    logger.error({ err }, 'idle postgres client error');
  });

  return pool;
}

/**
 * Runs one query against a pg client or pool.
 *
 * Two node-postgres behaviours have to be handled here, both of which only show
 * up against a real server:
 *
 *  - Passing a values array (even an empty one) selects the extended query
 *    protocol, which rejects multiple statements in one command. The migration
 *    files are multi-statement batches, so parameterless SQL must be sent with no
 *    values argument at all, using the simple protocol.
 *  - A simple-protocol batch returns an ARRAY of results, one per statement, so
 *    `res.rows` is undefined. Take the last result, which is what callers want.
 */
async function runQuery<T>(
  client: Pick<pg.Pool, 'query'> | pg.PoolClient,
  sql: string,
  params: readonly unknown[],
): Promise<QueryResult<T>> {
  try {
    const res = params.length
      ? await client.query(sql, params as unknown[])
      : await client.query(sql);

    const last = Array.isArray(res) ? res[res.length - 1] : res;
    const rows = (last?.rows ?? []) as T[];
    return { rows, rowCount: last?.rowCount ?? rows.length };
  } catch (cause) {
    throw new DatabaseError(firstLine(sql), cause);
  }
}

export function createExecutor(p: pg.Pool = getPool()): TransactionalExecutor {
  const exec = <T>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> =>
    runQuery<T>(p, sql, params);

  return {
    query: exec,
    async transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
      const client = await p.connect().catch((cause) => {
        throw new DatabaseError('acquire connection', cause);
      });
      try {
        await client.query('BEGIN');
        const tx: Executor = {
          query: <R>(sql: string, params: readonly unknown[] = []) =>
            runQuery<R>(client, sql, params),
        };
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

function firstLine(sql: string): string {
  return sql.trim().split('\n')[0]!.slice(0, 120);
}
