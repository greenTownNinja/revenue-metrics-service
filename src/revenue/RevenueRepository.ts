/**
 * The ONLY place in the codebase that aggregates money.
 *
 * Both the summary and the daily breakdown are built from `collectedQuery()`:
 * same FROM, same WHERE, same bind parameters, same allow-list. The two views
 * differ by exactly one thing — whether a `date_trunc` grouping key is present.
 * That is what makes `sum(daily) === summary` true by construction rather than
 * by convention.
 *
 * Summation happens in Postgres over BIGINT, so the total is exact integer
 * arithmetic regardless of magnitude. Values cross into JS as strings and are
 * converted to BigInt deliberately.
 */

import type { Executor } from '../db/Executor.js';
import { collectedPredicate } from './canonical.js';
import type { Range } from './DateRange.js';

export interface CurrencyTotal {
  currency: string;
  amountMinor: bigint;
  transactionCount: number;
}

export interface DayTotal {
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  currency: string;
  amountMinor: bigint;
  transactionCount: number;
}

export interface UnmappedStatus {
  source: string;
  rawStatus: string;
  currency: string;
  occurrences: number;
  excludedAmountMinor: bigint;
}

/**
 * Shared clause factory for every collected-revenue query.
 *
 * Returns the FROM/WHERE text plus its bind parameters. Callers may only append
 * a GROUP BY / ORDER BY — they must not add predicates, because a predicate
 * added on one side and not the other is precisely how two views drift apart.
 *
 * Range is half-open: occurred_at >= from AND occurred_at < to.
 */
function collectedQuery(range: Range): { fromWhere: string; params: unknown[] } {
  // $1 = allow-list, $2 = from (inclusive), $3 = to (exclusive)
  const predicate = collectedPredicate(1);
  return {
    fromWhere: `
      FROM transactions
      WHERE ${predicate.sql}
        AND occurred_at >= $2
        AND occurred_at <  $3`,
    params: [...predicate.params, range.from, range.to],
  };
}

export class RevenueRepository {
  constructor(private readonly db: Executor) {}

  /** Collected revenue per currency for the range. */
  async sumByCurrency(range: Range): Promise<CurrencyTotal[]> {
    const { fromWhere, params } = collectedQuery(range);

    const { rows } = await this.db.query<{
      currency: string;
      amount_minor: string;
      transaction_count: string;
    }>(
      `SELECT currency,
              COALESCE(SUM(amount_minor), 0)::TEXT AS amount_minor,
              COUNT(*)::TEXT                       AS transaction_count
       ${fromWhere}
       GROUP BY currency
       ORDER BY currency`,
      params,
    );

    return rows.map((r) => ({
      currency: r.currency,
      amountMinor: BigInt(r.amount_minor),
      transactionCount: Number(r.transaction_count),
    }));
  }

  /**
   * Collected revenue per UTC day per currency for the range.
   *
   * `occurred_at AT TIME ZONE 'UTC'` converts the timestamptz to a UTC wall
   * clock before truncating, so bucketing does not depend on the session
   * timezone of whichever pooler connection served the request.
   *
   * Days with no collected revenue are absent rather than zero-filled; summing
   * the result per currency still equals sumByCurrency().
   */
  async sumByDayAndCurrency(range: Range): Promise<DayTotal[]> {
    const { fromWhere, params } = collectedQuery(range);

    const { rows } = await this.db.query<{
      day: string;
      currency: string;
      amount_minor: string;
      transaction_count: string;
    }>(
      `SELECT TO_CHAR(DATE_TRUNC('day', occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
              currency,
              COALESCE(SUM(amount_minor), 0)::TEXT AS amount_minor,
              COUNT(*)::TEXT                       AS transaction_count
       ${fromWhere}
       GROUP BY day, currency
       ORDER BY day, currency`,
      params,
    );

    return rows.map((r) => ({
      date: r.day,
      currency: r.currency,
      amountMinor: BigInt(r.amount_minor),
      transactionCount: Number(r.transaction_count),
    }));
  }

  /**
   * Statuses seen in the range that no adapter could map, with the amount they
   * kept out of revenue.
   *
   * This is the operational half of the allow-list: excluding an unrecognised
   * status is only safe if somebody finds out it appeared.
   */
  async findUnmappedStatuses(range: Range): Promise<UnmappedStatus[]> {
    const { rows } = await this.db.query<{
      source: string;
      raw_status: string;
      currency: string;
      occurrences: string;
      excluded_amount_minor: string;
    }>(
      `SELECT source,
              raw_status,
              currency,
              COUNT(*)::TEXT                       AS occurrences,
              COALESCE(SUM(amount_minor), 0)::TEXT AS excluded_amount_minor
       FROM transactions
       WHERE canonical_status = $1
         AND occurred_at >= $2
         AND occurred_at <  $3
       GROUP BY source, raw_status, currency
       ORDER BY occurrences DESC, raw_status`,
      ['UNKNOWN', range.from, range.to],
    );

    return rows.map((r) => ({
      source: r.source,
      rawStatus: r.raw_status,
      currency: r.currency,
      occurrences: Number(r.occurrences),
      excludedAmountMinor: BigInt(r.excluded_amount_minor),
    }));
  }

  /** Sources that have contributed at least one row. Used by /revenue/summary. */
  async listSources(range: Range): Promise<string[]> {
    const { rows } = await this.db.query<{ source: string }>(
      `SELECT DISTINCT source
       FROM transactions
       WHERE occurred_at >= $1 AND occurred_at < $2
       ORDER BY source`,
      [range.from, range.to],
    );
    return rows.map((r) => r.source);
  }
}
