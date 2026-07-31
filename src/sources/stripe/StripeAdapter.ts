/**
 * Stripe test-mode source.
 *
 * Uses Charges rather than PaymentIntents: charges expose the richer vocabulary
 * (`succeeded` / `pending` / `failed`, plus refund state via `refunded` and
 * `amount_refunded`), and `amount` is already an integer in minor units, so no
 * conversion or rounding happens anywhere in this file.
 */

import Stripe from 'stripe';
import {
  CanonicalStatus,
  buildStatusMapper,
  normalizeRawStatus,
} from '../../revenue/canonical.js';
import type {
  FetchOptions,
  FetchResult,
  NormalizedTransaction,
  QuarantinedRecord,
  SourceAdapter,
} from '../SourceAdapter.js';
import { UpstreamConfigError, UpstreamUnavailableError } from '../../errors.js';
import { logger } from '../../logger.js';

export const STRIPE_SOURCE = 'stripe';

/**
 * Stripe charge vocabulary → canonical.
 *
 * A charge that has been fully refunded still reports status `succeeded` with
 * `refunded: true`; that case is handled in normalization below, which is why
 * `refunded` appears here as well (it is the synthetic status we record for it).
 */
export const STRIPE_VOCABULARY: Readonly<Record<string, CanonicalStatus>> = Object.freeze({
  succeeded: CanonicalStatus.COLLECTED,
  pending: CanonicalStatus.PENDING,
  failed: CanonicalStatus.FAILED,
  refunded: CanonicalStatus.REFUNDED,
});

const mapStatus = buildStatusMapper(STRIPE_VOCABULARY);

const PAGE_SIZE = 100;

/**
 * Builds a Stripe client from the environment, refusing anything that is not a
 * test-mode key.
 *
 * Exported because the demo-charge endpoint needs the same client under the same
 * refusal. Sharing it means the "test mode only" rule cannot be enforced in one
 * place and forgotten in the other — there is exactly one construction path.
 */
export function stripeClientFromEnv(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new UpstreamConfigError(STRIPE_SOURCE, 'STRIPE_SECRET_KEY is not set');
  }
  if (!key.startsWith('sk_test_') && !key.startsWith('rk_test_')) {
    throw new UpstreamConfigError(
      STRIPE_SOURCE,
      'STRIPE_SECRET_KEY must be a test-mode key (sk_test_… or rk_test_…)',
    );
  }
  return new Stripe(key, { maxNetworkRetries: 3, timeout: 20_000 });
}

export class StripeAdapter implements SourceAdapter {
  readonly name = STRIPE_SOURCE;
  readonly vocabulary = STRIPE_VOCABULARY;

  constructor(private readonly stripe: Stripe) {}

  static fromEnv(): StripeAdapter {
    return new StripeAdapter(stripeClientFromEnv());
  }

  /**
   * Fetches charges created since the watermark.
   *
   * The watermark is a `created` TIMESTAMP, not a charge id. Stripe lists
   * newest-first and `starting_after` pages toward OLDER records, so an id-based
   * cursor walks backwards through history and never sees anything new. Filtering
   * on `created[gte]` and paging newest→oldest within the run is what actually
   * picks up new charges.
   *
   * OVERLAP_SECONDS of deliberate re-fetch covers charges that were created just
   * before the previous run's boundary but committed just after it. Re-fetching is
   * free because the upsert is idempotent; missing a charge is not.
   */
  async fetch(options: FetchOptions): Promise<FetchResult> {
    const normalized: NormalizedTransaction[] = [];
    const quarantined: QuarantinedRecord[] = [];
    let fetched = 0;
    let pages = 0;
    let startingAfter: string | undefined;

    const since = parseWatermark(options.cursor);
    const createdFilter = since === null ? undefined : { gte: since - OVERLAP_SECONDS };

    // Highest `created` seen this run becomes the next watermark. Seeded with the
    // previous one so an empty run does not rewind the watermark to zero.
    let maxCreated = since ?? 0;

    while (pages < options.maxPages) {
      let page: Stripe.ApiList<Stripe.Charge>;
      try {
        page = await this.stripe.charges.list({
          limit: PAGE_SIZE,
          ...(createdFilter ? { created: createdFilter } : {}),
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        });
      } catch (err) {
        throw translateStripeError(err);
      }

      pages += 1;
      fetched += page.data.length;

      for (const charge of page.data) {
        if (Number.isFinite(charge.created) && charge.created > maxCreated) {
          maxCreated = charge.created;
        }
        const result = normalizeCharge(charge);
        if ('reason' in result) {
          quarantined.push(result);
        } else {
          normalized.push(result);
        }
      }

      if (!page.has_more || page.data.length === 0) {
        return { normalized, quarantined, nextCursor: serializeWatermark(maxCreated), fetched };
      }
      startingAfter = page.data[page.data.length - 1]!.id;
    }

    // Page cap hit mid-backfill. Advancing the watermark now would skip the older
    // charges we have not reached yet, so leave it where it was and let the next
    // run continue from the same point.
    logger.info(
      { source: STRIPE_SOURCE, pages, maxPages: options.maxPages },
      'page cap reached; watermark held so the remaining history is not skipped',
    );
    return { normalized, quarantined, nextCursor: options.cursor, fetched };
  }
}

/** Seconds of deliberate overlap between runs. See fetch(). */
const OVERLAP_SECONDS = 3600;

/** Watermark is a unix-seconds string. Anything unparseable means "full sync". */
function parseWatermark(cursor: string | null): number | null {
  if (cursor === null || cursor === '') return null;
  const parsed = Number(cursor);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function serializeWatermark(created: number): string | null {
  return created > 0 ? String(created) : null;
}

/**
 * Charge → NormalizedTransaction, or a quarantine record if the payload cannot
 * be trusted. Returning rather than throwing keeps one bad record from aborting
 * an entire sync.
 */
export function normalizeCharge(
  charge: Stripe.Charge,
): NormalizedTransaction | QuarantinedRecord {
  const quarantine = (reason: string): QuarantinedRecord => ({
    source: STRIPE_SOURCE,
    externalId: typeof charge?.id === 'string' ? charge.id : null,
    payload: charge,
    reason,
  });

  if (!charge || typeof charge.id !== 'string' || charge.id === '') {
    return quarantine('missing charge id');
  }
  if (!Number.isInteger(charge.amount) || charge.amount < 0) {
    return quarantine(`amount is not a non-negative integer: ${String(charge.amount)}`);
  }
  if (typeof charge.currency !== 'string' || !/^[A-Za-z]{3}$/.test(charge.currency)) {
    return quarantine(`currency is not ISO 4217: ${String(charge.currency)}`);
  }
  if (!Number.isFinite(charge.created) || charge.created <= 0) {
    return quarantine(`created timestamp is invalid: ${String(charge.created)}`);
  }

  const refunded = Number.isInteger(charge.amount_refunded) ? charge.amount_refunded : 0;
  if (refunded < 0 || refunded > charge.amount) {
    return quarantine(
      `amount_refunded ${String(charge.amount_refunded)} outside [0, ${charge.amount}]`,
    );
  }

  // A fully refunded charge keeps Stripe status `succeeded`. Recording it as
  // `succeeded` would count money we gave back, so we record the effective
  // status — while still preserving what Stripe literally reported.
  const fullyRefunded = charge.refunded === true && refunded >= charge.amount;
  const rawStatus = fullyRefunded ? `refunded (stripe:${charge.status})` : String(charge.status ?? '');
  const canonicalStatus = fullyRefunded
    ? CanonicalStatus.REFUNDED
    : mapStatus(normalizeRawStatus(String(charge.status ?? '')));

  if (canonicalStatus === CanonicalStatus.UNKNOWN) {
    logger.warn(
      { source: STRIPE_SOURCE, rawStatus: charge.status, externalId: charge.id },
      'unmapped provider status — excluded from revenue',
    );
  }

  return {
    source: STRIPE_SOURCE,
    externalId: charge.id,
    amountMinor: BigInt(charge.amount),
    amountRefundedMinor: BigInt(refunded),
    currency: charge.currency.toLowerCase(),
    rawStatus,
    canonicalStatus,
    occurredAt: new Date(charge.created * 1000),
  };
}

/**
 * Maps a Stripe SDK error onto our typed errors, keeping "your key is wrong"
 * (502, retrying will not help) distinct from "Stripe is down" (503, it might).
 */
function translateStripeError(err: unknown): Error {
  if (err && typeof err === 'object' && 'type' in err) {
    const type = String((err as { type: unknown }).type);
    const message = 'message' in err ? String((err as { message: unknown }).message) : type;
    if (
      type === 'StripeAuthenticationError' ||
      type === 'StripePermissionError' ||
      type === 'StripeInvalidRequestError'
    ) {
      return new UpstreamConfigError(STRIPE_SOURCE, message);
    }
  }
  return new UpstreamUnavailableError(STRIPE_SOURCE, err);
}
