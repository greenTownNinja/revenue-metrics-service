/**
 * THE canonical definition of collected revenue.
 *
 * This file is the single place in the codebase that decides what counts as
 * revenue. Nothing outside `src/revenue/` may reference COLLECTED_STATUSES,
 * name a collected status literal, or sum an amount column — the guard test in
 * `tests/guards/no-second-implementation.test.ts` fails the build if it does.
 *
 * If you are here because you need "the revenue number computed slightly
 * differently", add a parameter to RevenueService. Do not add a second query.
 */

/**
 * Closed set of canonical statuses. Every provider vocabulary maps onto this
 * enum; provider status strings never reach the revenue calculation.
 */
export enum CanonicalStatus {
  /** Money is actually collected and settled to us. */
  COLLECTED = 'COLLECTED',
  /** In flight — authorized, processing, awaiting capture. Not collected yet. */
  PENDING = 'PENDING',
  /** Terminal failure. */
  FAILED = 'FAILED',
  /** Cancelled/voided before collection. */
  VOIDED = 'VOIDED',
  /** Collected then given back. Not revenue. */
  REFUNDED = 'REFUNDED',
  /** Provider sent a status we have never seen. Never counts; always surfaced. */
  UNKNOWN = 'UNKNOWN',
}

/**
 * ALLOW-LIST. Statuses that count as collected revenue.
 *
 * Deliberately an allow-list, not an exclusion list. An exclusion list such as
 * `status != 'failed'` silently admits any new provider status — `disputed`,
 * `processing`, `on_hold` — as revenue the day the provider ships it. With an
 * allow-list, an unrecognised status contributes zero and shows up in
 * `/revenue/unmapped`.
 */
export const COLLECTED_STATUSES: readonly CanonicalStatus[] = Object.freeze([
  CanonicalStatus.COLLECTED,
]);

/**
 * Every canonical status must be explicitly classified. `allowlist.test.ts`
 * asserts this map is total over the enum, so adding a member without deciding
 * whether it is revenue fails CI rather than defaulting one way.
 */
export const STATUS_CLASSIFICATION: Readonly<Record<CanonicalStatus, boolean>> = Object.freeze({
  [CanonicalStatus.COLLECTED]: true,
  [CanonicalStatus.PENDING]: false,
  [CanonicalStatus.FAILED]: false,
  [CanonicalStatus.VOIDED]: false,
  [CanonicalStatus.REFUNDED]: false,
  [CanonicalStatus.UNKNOWN]: false,
});

/** Whether refunds are netted out of collected revenue. See README tradeoffs. */
export const REFUNDS_NETTED = false;

export function isCollected(status: CanonicalStatus): boolean {
  return STATUS_CLASSIFICATION[status];
}

/**
 * SQL predicate selecting collected rows, generated from the allow-list above.
 *
 * Both the summary and the daily view build their WHERE clause from this, so the
 * allow-list exists in exactly one place — it is passed to Postgres as a bind
 * parameter rather than written into any query text.
 *
 * @param paramIndex 1-based index of the bind parameter this predicate will use.
 */
export function collectedPredicate(paramIndex: number): {
  sql: string;
  params: [string[]];
} {
  return {
    sql: `canonical_status = ANY($${paramIndex}::text[])`,
    params: [COLLECTED_STATUSES.map(String)],
  };
}

/**
 * Machine-readable description of the definition used for a computation.
 * Echoed in every revenue response so a caller comparing two numbers can verify
 * they were produced under identical rules.
 */
export interface RevenueDefinition {
  collectedStatuses: readonly string[];
  refundsNetted: boolean;
  timezone: 'UTC';
  rangeSemantics: '[from, to)';
}

export function revenueDefinition(): RevenueDefinition {
  return Object.freeze({
    collectedStatuses: COLLECTED_STATUSES.map(String),
    refundsNetted: REFUNDS_NETTED,
    timezone: 'UTC',
    rangeSemantics: '[from, to)',
  });
}

/**
 * Normalizes a raw provider status for lookup: trimmed, lowercased.
 * The original string is always persisted unmodified in `raw_status`.
 */
export function normalizeRawStatus(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Builds a provider status mapper from a vocabulary table. Anything not in the
 * table becomes UNKNOWN — mappers cannot accidentally default to COLLECTED.
 */
export function buildStatusMapper(
  vocabulary: Readonly<Record<string, CanonicalStatus>>,
): (rawStatus: string) => CanonicalStatus {
  const table = new Map<string, CanonicalStatus>(
    Object.entries(vocabulary).map(([k, v]) => [normalizeRawStatus(k), v]),
  );
  return (rawStatus: string) => table.get(normalizeRawStatus(rawStatus)) ?? CanonicalStatus.UNKNOWN;
}
