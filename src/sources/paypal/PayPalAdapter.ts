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
const MS_PER_HOUR = 3_600_000;

/**
 * How far BEFORE the watermark each sync starts reading, in hours.
 *
 * A watermark alone is not enough. A provider can surface a transaction after the
 * watermark has already moved past its timestamp — PayPal's reporting lag is
 * exactly that, and a backdated or late-settled record does it too. Re-reading a
 * window on every run is what closes that hole, and it is free: every adapter
 * upserts on (source, external_id), so re-reading rewrites identical rows.
 *
 * The default of 1 hour is enough for ordinary late arrivals. Raising it to 24
 * makes every sync re-ingest a full day, which is both a stronger correctness
 * guarantee and what makes a live demo show real `fetched`/`upserted` counts
 * while the revenue totals stay bit-identical.
 *
 * Cost is linear: a bigger overlap means more pages read per sync, nothing else.
 */
const DEFAULT_OVERLAP_HOURS = 1;

function overlapMsFromEnv(): number {
  const raw = Number(process.env.PAYPAL_OVERLAP_HOURS ?? DEFAULT_OVERLAP_HOURS);
  const hours = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_OVERLAP_HOURS;
  return hours * MS_PER_HOUR;
}

/**
 * How far behind real time PayPal's reporting is, and therefore the newest
 * instant this adapter will query or advance its watermark to.
 *
 * PayPal documents "a maximum of three hours for executed transactions to appear
 * in the list transactions call". Measured against the sandbox on 2026-07-31, the
 * API does not merely return an empty page for a too-recent window — it answers
 * 404 INVALID_REQUEST "Data for the given start date is not available." for any
 * start_date newer than roughly now-2h.
 *
 * This constant does two jobs, and the second one matters more:
 *
 *  1. It keeps every request behind the horizon, so an ordinary sync stops
 *     turning into a 503.
 *  2. It stops the watermark advancing into the lag window. Advancing to `now`
 *     is silent data loss: transactions in the last three hours are not visible
 *     yet, so a watermark past them means they are never fetched — the next sync
 *     starts after them and they are skipped permanently. Holding the watermark
 *     at the horizon means the unsettled window is re-queried until it settles,
 *     and the upsert makes that repetition free.
 */
const REPORTING_LAG_MS = 3 * 60 * 60 * 1000;

export class PayPalAdapter implements SourceAdapter {
  readonly name = PAYPAL_SOURCE;
  readonly vocabulary = PAYPAL_VOCABULARY;

  constructor(
    private readonly client: PayPalClient,
    /** How far back to look on a first sync, with no watermark yet. */
    private readonly lookbackDays: number = Number(process.env.PAYPAL_LOOKBACK_DAYS ?? 31),
    /** How far back BEFORE the watermark to re-read on every sync. */
    private readonly overlapMs: number = overlapMsFromEnv(),
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
   *
   * Nothing newer than REPORTING_LAG_MS is queried, and the watermark never moves
   * past it, so transactions still inside PayPal's reporting lag are re-checked
   * rather than skipped.
   */
  async fetch(options: FetchOptions): Promise<FetchResult> {
    const normalized: NormalizedTransaction[] = [];
    const quarantined: QuarantinedRecord[] = [];
    let fetched = 0;
    let pagesUsed = 0;

    const now = new Date();
    // The newest instant PayPal will answer for. Everything below works against
    // this rather than `now`.
    const horizon = new Date(now.getTime() - REPORTING_LAG_MS);
    const start = this.resolveStart(options.cursor, now);

    if (start >= horizon) {
      // Caught up to the reporting horizon. Not an error and not worth an HTTP
      // call — anything newer is not visible to Transaction Search yet, and the
      // unchanged watermark means the next run picks it up once it settles.
      logger.info(
        { source: PAYPAL_SOURCE, start: start.toISOString(), horizon: horizon.toISOString() },
        'caught up to PayPal reporting horizon; nothing settled to fetch yet',
      );
      return { normalized, quarantined, nextCursor: options.cursor, fetched: 0 };
    }

    let windowStart = start;
    let completedThrough: Date | null = null;

    while (windowStart < horizon && pagesUsed < options.maxPages) {
      const windowEnd = new Date(
        Math.min(windowStart.getTime() + MAX_WINDOW_DAYS * MS_PER_DAY, horizon.getTime()),
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

    if (pagesUsed >= options.maxPages && windowStart < horizon) {
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
        // The watermark is where we got to; the overlap is how far back we
        // re-read anyway. Never trust the watermark as an exact resume point.
        return new Date(parsed.getTime() - this.overlapMs);
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
