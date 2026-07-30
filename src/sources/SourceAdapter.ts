/**
 * The contract every source system implements.
 *
 * Adding a source means adding one of these and registering it — it must not
 * mean touching the revenue calculation. Because adapters map onto the closed
 * CanonicalStatus enum and anything unrecognised becomes UNKNOWN, a new source
 * cannot introduce a new revenue-counting status by accident.
 */

import type { CanonicalStatus } from '../revenue/canonical.js';

/** A transaction after normalization. The only shape the store accepts. */
export interface NormalizedTransaction {
  source: string;
  externalId: string;
  /** Integer minor units (cents). */
  amountMinor: bigint;
  /** Integer minor units already refunded. Not netted in v1; see README. */
  amountRefundedMinor: bigint;
  /** ISO 4217, lowercase. */
  currency: string;
  /** Exactly what the provider said, unmodified. */
  rawStatus: string;
  canonicalStatus: CanonicalStatus;
  occurredAt: Date;
}

/** A record that could not be normalized. Quarantined, never dropped. */
export interface QuarantinedRecord {
  source: string;
  externalId: string | null;
  payload: unknown;
  reason: string;
}

export interface FetchResult {
  normalized: NormalizedTransaction[];
  quarantined: QuarantinedRecord[];
  /** Opaque cursor to resume from next sync, or null if fully caught up. */
  nextCursor: string | null;
  /** Total raw records examined, including quarantined ones. */
  fetched: number;
}

export interface FetchOptions {
  /** Resume point from sync_state, if any. */
  cursor: string | null;
  /** Hard cap on pages, so /sync finishes inside Render's request timeout. */
  maxPages: number;
}

export interface SourceAdapter {
  /** Stable identifier, stored in transactions.source. */
  readonly name: string;

  /** The provider vocabulary this adapter understands. Asserted by a snapshot test. */
  readonly vocabulary: Readonly<Record<string, CanonicalStatus>>;

  fetch(options: FetchOptions): Promise<FetchResult>;
}
