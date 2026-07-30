/**
 * Date range parsing and normalization — the single source of truth for what
 * "2026-07-01 to 2026-08-01" means.
 *
 * Two rules, applied identically for every view:
 *   1. Half-open: [from, to). `from` inclusive, `to` exclusive.
 *   2. UTC. Day boundaries never depend on server or session timezone.
 *
 * Both endpoints call parseRange(), so a boundary transaction cannot land in the
 * summary but not the breakdown (or vice versa).
 */

import { ValidationError } from '../errors.js';

/** Guards response size on a free-tier instance. */
export const MAX_RANGE_DAYS = 366;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

export interface Range {
  /** Inclusive lower bound. */
  from: Date;
  /** Exclusive upper bound. */
  to: Date;
}

export interface SerializedRange {
  from: string;
  to: string;
  timezone: 'UTC';
  semantics: '[from, to)';
}

/**
 * Parses a `YYYY-MM-DD` date into midnight UTC on that day.
 * Rejects values that look like dates but are not (e.g. 2026-02-30).
 */
function parseUtcDate(value: string, field: string): Date {
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) {
    throw new ValidationError(`'${field}' must be a date in YYYY-MM-DD format`, field);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(`'${field}' is not a valid date`, field);
  }
  // Date() rolls 2026-02-30 forward to 2026-03-02 rather than failing; compare
  // the round-trip to reject silently-shifted input.
  if (parsed.toISOString().slice(0, 10) !== value) {
    throw new ValidationError(`'${field}' is not a real calendar date`, field);
  }
  return parsed;
}

/**
 * Normalizes user input into a half-open UTC range.
 *
 * `to` is exclusive: `from=2026-07-01&to=2026-08-01` covers all of July and no
 * part of August. This is deliberate — inclusive upper bounds make adjacent
 * ranges overlap by a day, which is exactly how two views start disagreeing.
 */
export function parseRange(input: { from?: unknown; to?: unknown }): Range {
  if (input.from === undefined || input.from === null || input.from === '') {
    throw new ValidationError("'from' is required (YYYY-MM-DD)", 'from');
  }
  if (input.to === undefined || input.to === null || input.to === '') {
    throw new ValidationError("'to' is required (YYYY-MM-DD, exclusive)", 'to');
  }

  const from = parseUtcDate(String(input.from), 'from');
  const to = parseUtcDate(String(input.to), 'to');

  if (from.getTime() >= to.getTime()) {
    throw new ValidationError(
      `'from' must be strictly before 'to' ('to' is exclusive). Got from=${String(input.from)}, to=${String(input.to)}`,
      'from',
    );
  }

  const days = (to.getTime() - from.getTime()) / MS_PER_DAY;
  if (days > MAX_RANGE_DAYS) {
    throw new ValidationError(
      `Range too large: ${days} days requested, maximum is ${MAX_RANGE_DAYS}`,
      'to',
    );
  }

  return { from, to };
}

export function serializeRange(range: Range): SerializedRange {
  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    timezone: 'UTC',
    semantics: '[from, to)',
  };
}

/** Number of whole UTC days spanned by the range. */
export function rangeDays(range: Range): number {
  return Math.round((range.to.getTime() - range.from.getTime()) / MS_PER_DAY);
}

/** `YYYY-MM-DD` for a UTC instant. Used to label daily buckets. */
export function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}
