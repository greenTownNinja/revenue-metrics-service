/**
 * Second source system: a CSV invoice ledger with a deliberately DIFFERENT
 * status vocabulary from Stripe.
 *
 * Where Stripe says `succeeded`, this source says `paid` or `completed`; where
 * Stripe says `canceled`, this says `voided`. That divergence is the whole point
 * — it exercises the normalization layer, and it demonstrates that adding a
 * source cannot change what counts as revenue.
 *
 * The fixture is intentionally hostile: mixed casing, padded whitespace, a
 * multi-currency mix, a boundary pair straddling UTC midnight, an amount beyond
 * Number.MAX_SAFE_INTEGER, an unmappable `disputed` status, and one row with a
 * non-numeric amount that must be quarantined rather than crash the sync.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
import { logger } from '../../logger.js';

export const LEDGER_SOURCE = 'ledger-csv';

/** A vocabulary that shares no collected-status spelling with Stripe. */
export const LEDGER_VOCABULARY: Readonly<Record<string, CanonicalStatus>> = Object.freeze({
  paid: CanonicalStatus.COLLECTED,
  completed: CanonicalStatus.COLLECTED,
  captured: CanonicalStatus.COLLECTED,
  processing: CanonicalStatus.PENDING,
  awaiting_payment: CanonicalStatus.PENDING,
  voided: CanonicalStatus.VOIDED,
  failed: CanonicalStatus.FAILED,
  refunded: CanonicalStatus.REFUNDED,
});

const mapStatus = buildStatusMapper(LEDGER_VOCABULARY);

const DEFAULT_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'ledger.csv',
);

interface LedgerRow {
  invoice_id: string;
  status: string;
  amount_cents: string;
  refunded_cents: string;
  currency: string;
  settled_at: string;
}

const REQUIRED_COLUMNS = [
  'invoice_id',
  'status',
  'amount_cents',
  'refunded_cents',
  'currency',
  'settled_at',
] as const;

export class LedgerCsvAdapter implements SourceAdapter {
  readonly name = LEDGER_SOURCE;
  readonly vocabulary = LEDGER_VOCABULARY;

  constructor(private readonly fixturePath: string = DEFAULT_FIXTURE) {}

  /**
   * A file-backed source has nothing to paginate, so the cursor is unused and
   * `nextCursor` stays null. Sync is still idempotent via the upsert.
   */
  async fetch(_options: FetchOptions): Promise<FetchResult> {
    const csv = await readFile(this.fixturePath, 'utf8');
    return parseLedgerCsv(csv);
  }
}

export function parseLedgerCsv(csv: string): FetchResult {
  const normalized: NormalizedTransaction[] = [];
  const quarantined: QuarantinedRecord[] = [];

  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) {
    return { normalized, quarantined, nextCursor: null, fetched: 0 };
  }

  const header = splitCsvLine(lines[0]!).map((h) => h.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    // A malformed header is a source-level problem, not a row-level one: every
    // row would quarantine for the same reason, so fail loudly instead.
    throw new Error(`ledger CSV is missing required columns: ${missing.join(', ')}`);
  }

  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const row = Object.fromEntries(
      header.map((col, i) => [col, cells[i] ?? '']),
    ) as unknown as LedgerRow;

    const result = normalizeLedgerRow(row);
    if ('reason' in result) {
      quarantined.push(result);
    } else {
      normalized.push(result);
    }
  }

  return { normalized, quarantined, nextCursor: null, fetched: lines.length - 1 };
}

export function normalizeLedgerRow(row: LedgerRow): NormalizedTransaction | QuarantinedRecord {
  const externalId = (row.invoice_id ?? '').trim();
  const quarantine = (reason: string): QuarantinedRecord => ({
    source: LEDGER_SOURCE,
    externalId: externalId === '' ? null : externalId,
    payload: row,
    reason,
  });

  if (externalId === '') return quarantine('missing invoice_id');

  // BigInt() throws on anything non-integral, which is exactly the validation we
  // want — no silent Number() coercion of 'not_a_number' to NaN.
  let amountMinor: bigint;
  try {
    amountMinor = BigInt((row.amount_cents ?? '').trim());
  } catch {
    return quarantine(`amount_cents is not an integer: '${row.amount_cents}'`);
  }
  if (amountMinor < 0n) return quarantine(`amount_cents is negative: ${amountMinor}`);

  let refundedMinor: bigint;
  try {
    const raw = (row.refunded_cents ?? '').trim();
    refundedMinor = raw === '' ? 0n : BigInt(raw);
  } catch {
    return quarantine(`refunded_cents is not an integer: '${row.refunded_cents}'`);
  }
  if (refundedMinor < 0n || refundedMinor > amountMinor) {
    return quarantine(`refunded_cents ${refundedMinor} outside [0, ${amountMinor}]`);
  }

  const currency = (row.currency ?? '').trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) {
    return quarantine(`currency is not ISO 4217: '${row.currency}'`);
  }

  const occurredAt = new Date((row.settled_at ?? '').trim());
  if (Number.isNaN(occurredAt.getTime())) {
    return quarantine(`settled_at is not a valid timestamp: '${row.settled_at}'`);
  }

  const rawStatus = row.status ?? '';
  if (rawStatus.trim() === '') return quarantine('missing status');

  const canonicalStatus = mapStatus(normalizeRawStatus(rawStatus));
  if (canonicalStatus === CanonicalStatus.UNKNOWN) {
    logger.warn(
      { source: LEDGER_SOURCE, rawStatus: rawStatus.trim(), externalId },
      'unmapped provider status — excluded from revenue',
    );
  }

  return {
    source: LEDGER_SOURCE,
    externalId,
    amountMinor,
    amountRefundedMinor: refundedMinor,
    currency,
    // Preserved verbatim, including original casing and padding.
    rawStatus,
    canonicalStatus,
    occurredAt,
  };
}

/** Minimal CSV field splitter with double-quote support. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}
