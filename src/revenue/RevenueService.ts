/**
 * The single entry point for "what is our collected revenue?".
 *
 * Every caller — both HTTP views, and anything added later — goes through this
 * class. It owns range normalization and delegates aggregation to
 * RevenueRepository. It contains no status literals and no SQL of its own.
 *
 * If a future requirement needs the number computed slightly differently, add a
 * parameter here. Do not add a second implementation elsewhere: the guard test
 * will fail the build.
 */

import type { Executor } from '../db/Executor.js';
import { parseRange, serializeRange, type Range, type SerializedRange } from './DateRange.js';
import { revenueDefinition, type RevenueDefinition } from './canonical.js';
import {
  RevenueRepository,
  type CurrencyTotal,
  type DayTotal,
  type UnmappedStatus,
} from './RevenueRepository.js';

export interface RangeInput {
  from?: unknown;
  to?: unknown;
}

export interface RevenueSummary {
  range: SerializedRange;
  definition: RevenueDefinition;
  totals: CurrencyTotal[];
  sources: string[];
}

export interface RevenueBreakdown {
  range: SerializedRange;
  definition: RevenueDefinition;
  days: DayTotal[];
}

export interface UnmappedReport {
  range: SerializedRange;
  definition: RevenueDefinition;
  unmapped: UnmappedStatus[];
}

export class RevenueService {
  private readonly repo: RevenueRepository;

  constructor(db: Executor) {
    this.repo = new RevenueRepository(db);
  }

  /** Total collected revenue per currency. */
  async getSummary(input: RangeInput): Promise<RevenueSummary> {
    const range = parseRange(input);
    const [totals, sources] = await Promise.all([
      this.repo.sumByCurrency(range),
      this.repo.listSources(range),
    ]);
    return {
      range: serializeRange(range),
      definition: revenueDefinition(),
      totals,
      sources,
    };
  }

  /**
   * The same number, broken out by UTC day.
   *
   * Identical range and identical allow-list as getSummary — summing `days` per
   * currency reproduces `totals` exactly.
   */
  async getDailyBreakdown(input: RangeInput): Promise<RevenueBreakdown> {
    const range = parseRange(input);
    const days = await this.repo.sumByDayAndCurrency(range);
    return {
      range: serializeRange(range),
      definition: revenueDefinition(),
      days,
    };
  }

  /** Statuses in this range that no adapter recognised. */
  async getUnmappedStatuses(input: RangeInput): Promise<UnmappedReport> {
    const range = parseRange(input);
    const unmapped = await this.repo.findUnmappedStatuses(range);
    return {
      range: serializeRange(range),
      definition: revenueDefinition(),
      unmapped,
    };
  }

  /**
   * Folds a breakdown into per-currency totals.
   *
   * Exported so callers (and the agreement test) can verify the two views agree
   * without writing their own aggregation. Kept here, inside the canonical
   * module, for exactly that reason.
   */
  static foldBreakdown(days: readonly DayTotal[]): CurrencyTotal[] {
    const acc = new Map<string, { amountMinor: bigint; transactionCount: number }>();
    for (const day of days) {
      const entry = acc.get(day.currency) ?? { amountMinor: 0n, transactionCount: 0 };
      entry.amountMinor += day.amountMinor;
      entry.transactionCount += day.transactionCount;
      acc.set(day.currency, entry);
    }
    return [...acc.entries()]
      .map(([currency, v]) => ({ currency, ...v }))
      .sort((a, b) => a.currency.localeCompare(b.currency));
  }
}

/** Re-exported so consumers never import the repository directly. */
export type { CurrencyTotal, DayTotal, UnmappedStatus, Range };
