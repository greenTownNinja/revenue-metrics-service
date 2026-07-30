/**
 * JSON serialization for money.
 *
 * Amounts leave the service as integer minor units in a STRING, plus an explicit
 * currency. No float ever crosses the wire: a JSON number would put the value
 * through an IEEE-754 double in every client that parses it, which is exactly
 * the drift this service is about. `amountMinor` is a decimal string; clients
 * that need arithmetic should use a big-integer type.
 */

import type { CurrencyTotal, DayTotal, UnmappedStatus } from '../revenue/RevenueService.js';

export interface CurrencyTotalJson {
  currency: string;
  amountMinor: string;
  transactionCount: number;
}

export interface DayTotalJson extends CurrencyTotalJson {
  date: string;
}

export function currencyTotalJson(t: CurrencyTotal): CurrencyTotalJson {
  return {
    currency: t.currency,
    amountMinor: t.amountMinor.toString(),
    transactionCount: t.transactionCount,
  };
}

export function dayTotalJson(d: DayTotal): DayTotalJson {
  return {
    date: d.date,
    currency: d.currency,
    amountMinor: d.amountMinor.toString(),
    transactionCount: d.transactionCount,
  };
}

export function unmappedJson(u: UnmappedStatus): {
  source: string;
  rawStatus: string;
  currency: string;
  occurrences: number;
  excludedAmountMinor: string;
} {
  return {
    source: u.source,
    rawStatus: u.rawStatus,
    currency: u.currency,
    occurrences: u.occurrences,
    excludedAmountMinor: u.excludedAmountMinor.toString(),
  };
}
