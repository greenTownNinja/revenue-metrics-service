/**
 * PayPal sandbox source, via the Transaction Search API.
 *
 * PayPal's status vocabulary is single letters — `S`, `P`, `V`, `D` — which shares
 * nothing at all with Stripe's `succeeded` / `pending` / `failed`. That is exactly
 * the point: the two sources agree on nothing except what the canonical enum says
 * they mean, and neither can change what counts as revenue.
 */

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
import { parseDecimalToMinor } from '../decimal.js';
import {
  MAX_WINDOW_DAYS,
  PAYPAL_SOURCE,
  PayPalClient,
  type PayPalTransaction,
} from './PayPalClient.js';
import { logger } from '../../logger.js';

export { PAYPAL_SOURCE };

/**
 * PayPal transaction_status codes.
 *   S — Success        the money is actually collected
 *   P — Pending        in flight, not collected yet
 *   V — Reversed       collected then reversed/refunded
 *   D — Denied         terminal failure
 */
export const PAYPAL_VOCABULARY: Readonly<Record<string, CanonicalStatus>> = Object.freeze({
  s: CanonicalStatus.COLLECTED,
  p: CanonicalStatus.PENDING,
  v: CanonicalStatus.REFUNDED,
  d: CanonicalStatus.FAILED,
});

const mapStatus = buildStatusMapper(PAYPAL_VOCABULARY);

const PAGE_SIZE = 100;
const MS_PER_DAY = 86_400_000;
/** Re-fetch window across runs; the upsert makes overlap free. */
const OVERLAP_MS = 60 * 60 * 1000;

export class PayPalAdapter implements SourceAdapter {
  readonly name = PAYPAL_SOURCE;
  readonly vocabulary = PAYPAL_VOCABULARY;

  constructor(
    private readonly client: PayPalClient,
    /** How far back to look on a first sync, with no watermark yet. */
    private readonly lookbackDays: number = Number(process.env.PAYPAL_LOOKBACK_DAYS ?? 31),
  ) {}

  static fromEnv(): PayPalAdapter {
    return new PayPalAdapter(PayPalClient.fromEnv());
  }

  /**
   * Fetches transactions since the watermark, in ≤31-day windows.
   *
   * The watermark is an ISO timestamp of how far forward we have synced, not a
   * page cursor: Transaction Search is queried by date range, and only a
   * time-based watermark picks up transactions created since the last run.
   *
   * `maxPages` is a budget across every HTTP page in every window, so one sync
   * cannot run long enough to hit Render's request timeout. If the budget runs out
   * mid-backfill the watermark stops at the last *fully* completed window, so
   * nothing is skipped — the next run resumes there.
   */
  async fetch(options: FetchOptions): Promise<FetchResult> {
    const normalized: NormalizedTransaction[] = [];
    const quarantined: QuarantinedRecord[] = [];
    let fetched = 0;
    let pagesUsed = 0;

    const now = new Date();
    const start = this.resolveStart(options.cursor, now);

    if (start >= now) {
      return { normalized, quarantined, nextCursor: options.cursor, fetched: 0 };
    }

    let windowStart = start;
    let completedThrough: Date | null = null;

    while (windowStart < now && pagesUsed < options.maxPages) {
      const windowEnd = new Date(
        Math.min(windowStart.getTime() + MAX_WINDOW_DAYS * MS_PER_DAY, now.getTime()),
      );

      let page = 1;
      let totalPages = 1;
      let windowComplete = false;

      while (page <= totalPages && pagesUsed < options.maxPages) {
        const result = await this.client.listTransactions({
          startDate: windowStart,
          endDate: windowEnd,
          page,
          pageSize: PAGE_SIZE,
        });
        pagesUsed += 1;
        totalPages = result.total_pages;
        fetched += result.transaction_details.length;

        for (const tx of result.transaction_details) {
          const outcome = normalizePayPalTransaction(tx);
          if ('reason' in outcome) quarantined.push(outcome);
          else normalized.push(outcome);
        }

        if (page >= totalPages) windowComplete = true;
        page += 1;
      }

      if (!windowComplete) break;
      completedThrough = windowEnd;
      windowStart = windowEnd;
    }

    if (pagesUsed >= options.maxPages && windowStart < now) {
      logger.info(
        { source: PAYPAL_SOURCE, pagesUsed, maxPages: options.maxPages },
        'page budget exhausted; remaining window resumes next sync',
      );
    }

    return {
      normalized,
      quarantined,
      // Only advance to the end of a fully-drained window. Advancing past a
      // partially-read one would silently skip its remaining pages forever.
      nextCursor: completedThrough ? completedThrough.toISOString() : options.cursor,
      fetched,
    };
  }

  private resolveStart(cursor: string | null, now: Date): Date {
    if (cursor) {
      const parsed = new Date(cursor);
      if (!Number.isNaN(parsed.getTime())) {
        return new Date(parsed.getTime() - OVERLAP_MS);
      }
      logger.warn({ source: PAYPAL_SOURCE, cursor }, 'unparseable watermark; doing a full lookback');
    }
    const days = Number.isFinite(this.lookbackDays) && this.lookbackDays > 0 ? this.lookbackDays : 31;
    return new Date(now.getTime() - days * MS_PER_DAY);
  }
}

/**
 * PayPal transaction → NormalizedTransaction, or a quarantine record.
 *
 * Amounts arrive as decimal STRINGS (`"45.00"`) and are converted on the string,
 * never through a float.
 */
export function normalizePayPalTransaction(
  tx: PayPalTransaction,
): NormalizedTransaction | QuarantinedRecord {
  const info = tx?.transaction_info ?? {};
  const externalId = (info.transaction_id ?? '').trim();

  const quarantine = (reason: string): QuarantinedRecord => ({
    source: PAYPAL_SOURCE,
    externalId: externalId === '' ? null : externalId,
    payload: tx,
    reason,
  });

  if (externalId === '') return quarantine('missing transaction_id');

  const currencyRaw = (info.transaction_amount?.currency_code ?? '').trim();
  if (!/^[A-Za-z]{3}$/.test(currencyRaw)) {
    return quarantine(`currency_code is not ISO 4217: '${currencyRaw}'`);
  }
  const currency = currencyRaw.toLowerCase();

  const amountRaw = info.transaction_amount?.value;
  if (typeof amountRaw !== 'string' || amountRaw.trim() === '') {
    return quarantine('transaction_amount.value is missing');
  }

  let amountMinor: bigint;
  try {
    amountMinor = parseDecimalToMinor(amountRaw, currency);
  } catch (err) {
    return quarantine(
      `transaction_amount.value ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // PayPal reports outflows (refunds, payouts) as negative amounts. The
  // transactions table stores non-negative amounts with an explicit status, so a
  // negative row is a reversal we record as REFUNDED at its absolute value —
  // it is excluded from revenue either way, but the row stays faithful.
  const isOutflow = amountMinor < 0n;
  if (isOutflow) amountMinor = -amountMinor;

  const dateRaw = info.transaction_initiation_date ?? info.transaction_updated_date;
  if (typeof dateRaw !== 'string' || dateRaw.trim() === '') {
    return quarantine('transaction_initiation_date is missing');
  }
  const occurredAt = new Date(dateRaw);
  if (Number.isNaN(occurredAt.getTime())) {
    return quarantine(`transaction_initiation_date is not a valid timestamp: '${dateRaw}'`);
  }

  const rawStatus = info.transaction_status ?? '';
  if (rawStatus.trim() === '') return quarantine('missing transaction_status');

  const mapped = mapStatus(normalizeRawStatus(rawStatus));
  const canonicalStatus = isOutflow && mapped === CanonicalStatus.COLLECTED
    ? CanonicalStatus.REFUNDED
    : mapped;

  if (canonicalStatus === CanonicalStatus.UNKNOWN) {
    logger.warn(
      { source: PAYPAL_SOURCE, rawStatus: rawStatus.trim(), externalId },
      'unmapped provider status — excluded from revenue',
    );
  }

  return {
    source: PAYPAL_SOURCE,
    externalId,
    amountMinor,
    amountRefundedMinor: 0n,
    currency,
    rawStatus,
    canonicalStatus,
    occurredAt,
  };
}
