/**
 * Minimal query interface shared by production (`pg.Pool` against Supabase) and
 * tests (PGlite — real Postgres compiled to WASM).
 *
 * The point is that the repository's SQL is never rewritten for tests: the exact
 * query text that runs in production is the query text under test, including
 * `date_trunc`, `::text[]` casts and BIGINT arithmetic.
 */

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Executor {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
}

/** An executor that can also run a transaction. */
export interface TransactionalExecutor extends Executor {
  transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T>;
}
