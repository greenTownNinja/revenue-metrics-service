/**
 * Sync behaviour: idempotency, quarantine, unknown-status reporting, and
 * multi-source normalization.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/testDb.js';
import { SyncService } from '../src/sync/SyncService.js';
import { RevenueService } from '../src/revenue/RevenueService.js';
import { LedgerCsvAdapter, parseLedgerCsv } from '../src/sources/ledgerCsv/LedgerCsvAdapter.js';
import { CanonicalStatus } from '../src/revenue/canonical.js';
import { UnknownSourceError } from '../src/errors.js';
import type { FetchResult, SourceAdapter } from '../src/sources/SourceAdapter.js';

/** In-memory adapter with a third vocabulary, to prove sources are pluggable. */
class FakeAdapter implements SourceAdapter {
  readonly name = 'fake-provider';
  readonly vocabulary = { settled: CanonicalStatus.COLLECTED };
  calls = 0;
  lastCursor: string | null | undefined;

  constructor(private readonly result: FetchResult) {}

  async fetch({ cursor }: { cursor: string | null }): Promise<FetchResult> {
    this.calls += 1;
    this.lastCursor = cursor;
    return this.result;
  }
}

const FULL_RANGE = { from: '2026-07-01', to: '2026-08-01' };

describe('sync', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it('is idempotent: re-running changes neither row count nor totals', async () => {
    const sync = new SyncService(db, [new LedgerCsvAdapter()]);
    const revenue = new RevenueService(db);

    const first = await sync.syncSource('ledger-csv');
    const totalsAfterFirst = await revenue.getSummary(FULL_RANGE);
    const { rows: countAfterFirst } = await db.query<{ n: string }>(
      'SELECT COUNT(*)::TEXT AS n FROM transactions',
    );

    const second = await sync.syncSource('ledger-csv');
    const totalsAfterSecond = await revenue.getSummary(FULL_RANGE);
    const { rows: countAfterSecond } = await db.query<{ n: string }>(
      'SELECT COUNT(*)::TEXT AS n FROM transactions',
    );

    expect(second.fetched).toBe(first.fetched);
    expect(countAfterSecond[0]!.n).toBe(countAfterFirst[0]!.n);
    expect(totalsAfterSecond.totals).toEqual(totalsAfterFirst.totals);
  });

  it('quarantines an unparseable record and still completes', async () => {
    const sync = new SyncService(db, [new LedgerCsvAdapter()]);
    const report = await sync.syncSource('ledger-csv');

    // inv_1015 has amount_cents='not_a_number'.
    expect(report.quarantined).toBe(1);
    expect(report.upserted).toBe(report.fetched - report.quarantined);

    const { rows } = await db.query<{ external_id: string; reason: string }>(
      'SELECT external_id, reason FROM quarantined_transactions',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.external_id).toBe('inv_1015');
    expect(rows[0]!.reason).toMatch(/amount_cents is not an integer/);
  });

  it('does not duplicate quarantine rows across repeated syncs', async () => {
    const sync = new SyncService(db, [new LedgerCsvAdapter()]);

    await sync.syncSource('ledger-csv');
    await sync.syncSource('ledger-csv');
    await sync.syncSource('ledger-csv');

    const { rows } = await db.query<{ external_id: string; seen_count: number }>(
      'SELECT external_id, seen_count FROM quarantined_transactions',
    );

    // One row, with the repeat encounters counted rather than appended.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.external_id).toBe('inv_1015');
    expect(Number(rows[0]!.seen_count)).toBe(3);
  });

  it('reports unknown statuses rather than dropping them silently', async () => {
    const sync = new SyncService(db, [new LedgerCsvAdapter()]);
    const report = await sync.syncSource('ledger-csv');

    // inv_1012 is 'disputed', which no vocabulary maps.
    expect(report.unknownStatuses).toEqual([{ rawStatus: 'disputed', count: 1 }]);

    const { unmapped } = await new RevenueService(db).getUnmappedStatuses(FULL_RANGE);
    expect(unmapped.map((u) => u.rawStatus)).toEqual(['disputed']);
    expect(unmapped[0]!.excludedAmountMinor).toBe(77000n);
  });

  it('combines sources with different vocabularies into one correct total', async () => {
    const fake = new FakeAdapter({
      normalized: [
        {
          source: 'fake-provider',
          externalId: 'f1',
          amountMinor: 1234n,
          amountRefundedMinor: 0n,
          currency: 'usd',
          rawStatus: 'settled',
          canonicalStatus: CanonicalStatus.COLLECTED,
          occurredAt: new Date('2026-07-04T10:00:00Z'),
        },
        {
          source: 'fake-provider',
          externalId: 'f2',
          amountMinor: 9999n,
          amountRefundedMinor: 0n,
          currency: 'usd',
          rawStatus: 'on_hold',
          canonicalStatus: CanonicalStatus.UNKNOWN,
          occurredAt: new Date('2026-07-04T11:00:00Z'),
        },
      ],
      quarantined: [],
      nextCursor: null,
      fetched: 2,
    });

    const sync = new SyncService(db, [new LedgerCsvAdapter(), fake]);
    const { reports, failures } = await sync.syncAll();

    expect(failures).toEqual([]);
    expect(reports.map((r) => r.source).sort()).toEqual(['fake-provider', 'ledger-csv']);

    const revenue = new RevenueService(db);
    const summary = await revenue.getSummary(FULL_RANGE);
    expect(summary.sources.sort()).toEqual(['fake-provider', 'ledger-csv']);

    // The new source's collected row counts; its unknown status does not.
    const breakdown = await revenue.getDailyBreakdown(FULL_RANGE);
    expect(RevenueService.foldBreakdown(breakdown.days)).toEqual(summary.totals);

    const jul4 = breakdown.days.filter((d) => d.date === '2026-07-04' && d.currency === 'usd');
    expect(jul4).toEqual([
      { date: '2026-07-04', currency: 'usd', amountMinor: 1234n, transactionCount: 1 },
    ]);
  });

  it('lets one failing source not stop the others', async () => {
    const broken: SourceAdapter = {
      name: 'broken',
      vocabulary: {},
      async fetch() {
        throw new Error('upstream exploded');
      },
    };

    const sync = new SyncService(db, [new LedgerCsvAdapter(), broken]);
    const { reports, failures } = await sync.syncAll();

    expect(reports.map((r) => r.source)).toEqual(['ledger-csv']);
    expect(failures).toEqual([{ source: 'broken', error: 'upstream exploded' }]);

    // The healthy source's data is still queryable.
    const { totals } = await new RevenueService(db).getSummary(FULL_RANGE);
    expect(totals.length).toBeGreaterThan(0);
  });

  it('rejects an unregistered source with a 400-mapped error', async () => {
    const sync = new SyncService(db, [new LedgerCsvAdapter()]);
    await expect(sync.syncSource('paypal')).rejects.toThrow(UnknownSourceError);
    await expect(sync.syncSource('paypal')).rejects.toMatchObject({ status: 400 });
  });

  it('does not advance the watermark when the write fails', async () => {
    const fake = new FakeAdapter({
      normalized: [
        {
          source: 'fake-provider',
          externalId: 'f1',
          // Violates transactions_refund_within_amount, so the transaction aborts.
          amountMinor: 100n,
          amountRefundedMinor: 500n,
          currency: 'usd',
          rawStatus: 'settled',
          canonicalStatus: CanonicalStatus.COLLECTED,
          occurredAt: new Date('2026-07-04T10:00:00Z'),
        },
      ],
      quarantined: [],
      nextCursor: 'cursor-99',
      fetched: 1,
    });

    const sync = new SyncService(db, [fake]);
    await expect(sync.syncSource('fake-provider')).rejects.toThrow();

    const { rows } = await db.query<{ n: string }>('SELECT COUNT(*)::TEXT AS n FROM sync_state');
    expect(rows[0]!.n).toBe('0');
  });

  it('passes the stored cursor back to the adapter on the next run', async () => {
    const fake = new FakeAdapter({
      normalized: [],
      quarantined: [],
      nextCursor: 'ch_abc123',
      fetched: 0,
    });
    const sync = new SyncService(db, [fake]);

    await sync.syncSource('fake-provider');
    expect(fake.lastCursor).toBeNull();

    await sync.syncSource('fake-provider');
    expect(fake.lastCursor).toBe('ch_abc123');
  });
});

describe('ledger CSV normalization', () => {
  it('maps its own vocabulary onto canonical statuses', () => {
    const { normalized } = parseLedgerCsv(
      [
        'invoice_id,status,amount_cents,refunded_cents,currency,settled_at',
        'a,paid,100,0,USD,2026-07-01T00:00:00Z',
        'b,completed,100,0,USD,2026-07-01T00:00:00Z',
        'c,voided,100,0,USD,2026-07-01T00:00:00Z',
        'd,processing,100,0,USD,2026-07-01T00:00:00Z',
        'e,refunded,100,100,USD,2026-07-01T00:00:00Z',
        'f,disputed,100,0,USD,2026-07-01T00:00:00Z',
      ].join('\n'),
    );

    expect(normalized.map((n) => [n.externalId, n.canonicalStatus])).toEqual([
      ['a', CanonicalStatus.COLLECTED],
      ['b', CanonicalStatus.COLLECTED],
      ['c', CanonicalStatus.VOIDED],
      ['d', CanonicalStatus.PENDING],
      ['e', CanonicalStatus.REFUNDED],
      ['f', CanonicalStatus.UNKNOWN],
    ]);
  });

  it('preserves the raw status verbatim while matching case-insensitively', () => {
    const { normalized } = parseLedgerCsv(
      [
        'invoice_id,status,amount_cents,refunded_cents,currency,settled_at',
        'a,  Paid  ,100,0,USD,2026-07-01T00:00:00Z',
      ].join('\n'),
    );
    expect(normalized[0]!.canonicalStatus).toBe(CanonicalStatus.COLLECTED);
    expect(normalized[0]!.rawStatus).toBe('  Paid  ');
  });

  it('parses amounts beyond Number.MAX_SAFE_INTEGER without loss', () => {
    const { normalized } = parseLedgerCsv(
      [
        'invoice_id,status,amount_cents,refunded_cents,currency,settled_at',
        'a,paid,9007199254740993,0,USD,2026-07-01T00:00:00Z',
      ].join('\n'),
    );
    expect(normalized[0]!.amountMinor).toBe(9007199254740993n);
  });

  it('quarantines bad rows individually', () => {
    const { normalized, quarantined } = parseLedgerCsv(
      [
        'invoice_id,status,amount_cents,refunded_cents,currency,settled_at',
        'good,paid,100,0,USD,2026-07-01T00:00:00Z',
        ',paid,100,0,USD,2026-07-01T00:00:00Z',
        'bad-amount,paid,abc,0,USD,2026-07-01T00:00:00Z',
        'bad-currency,paid,100,0,DOLLARS,2026-07-01T00:00:00Z',
        'bad-date,paid,100,0,USD,not-a-date',
        'bad-refund,paid,100,500,USD,2026-07-01T00:00:00Z',
        'no-status,,100,0,USD,2026-07-01T00:00:00Z',
      ].join('\n'),
    );

    expect(normalized.map((n) => n.externalId)).toEqual(['good']);
    expect(quarantined.map((q) => q.reason)).toEqual([
      'missing invoice_id',
      "amount_cents is not an integer: 'abc'",
      "currency is not ISO 4217: 'DOLLARS'",
      "settled_at is not a valid timestamp: 'not-a-date'",
      'refunded_cents 500 outside [0, 100]',
      'missing status',
    ]);
  });

  it('fails loudly on a malformed header rather than quarantining every row', () => {
    expect(() => parseLedgerCsv('id,state,amount\n1,paid,100')).toThrow(
      /missing required columns/,
    );
  });
});
