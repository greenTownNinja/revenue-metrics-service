/**
 * Range and day-boundary semantics — where two views most plausibly disagree.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, tx, type TestDb } from './helpers/testDb.js';
import { TransactionStore } from '../src/sync/TransactionStore.js';
import { RevenueService } from '../src/revenue/RevenueService.js';
import { parseRange, rangeDays, MAX_RANGE_DAYS } from '../src/revenue/DateRange.js';
import { ValidationError } from '../src/errors.js';

describe('date range parsing', () => {
  it('treats from as inclusive and to as exclusive', () => {
    const r = parseRange({ from: '2026-07-01', to: '2026-08-01' });
    expect(r.from.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(rangeDays(r)).toBe(31);
  });

  it('rejects missing bounds', () => {
    expect(() => parseRange({ to: '2026-08-01' })).toThrow(ValidationError);
    expect(() => parseRange({ from: '2026-07-01' })).toThrow(ValidationError);
    expect(() => parseRange({ from: '', to: '2026-08-01' })).toThrow(ValidationError);
  });

  it('rejects malformed and non-existent dates', () => {
    for (const bad of ['07-01-2026', '2026/07/01', '2026-7-1', 'yesterday', '2026-07-01T00:00:00Z']) {
      expect(() => parseRange({ from: bad, to: '2026-08-01' }), bad).toThrow(ValidationError);
    }
    // Date() would roll this forward to 2026-03-02 rather than failing.
    expect(() => parseRange({ from: '2026-02-30', to: '2026-08-01' })).toThrow(ValidationError);
  });

  it('rejects an inverted or empty range instead of silently swapping', () => {
    expect(() => parseRange({ from: '2026-08-01', to: '2026-07-01' })).toThrow(ValidationError);
    expect(() => parseRange({ from: '2026-07-01', to: '2026-07-01' })).toThrow(ValidationError);
  });

  it('rejects a range beyond the maximum span', () => {
    expect(() => parseRange({ from: '2020-01-01', to: '2026-01-01' })).toThrow(/Range too large/);
    // Exactly at the limit is allowed.
    const ok = parseRange({ from: '2026-01-01', to: '2027-01-02' });
    expect(rangeDays(ok)).toBe(MAX_RANGE_DAYS);
  });
});

describe('UTC day boundaries', () => {
  let db: TestDb;
  let store: TransactionStore;
  let service: RevenueService;

  beforeEach(async () => {
    db = await createTestDb();
    store = new TransactionStore(db);
    service = new RevenueService(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('assigns transactions either side of UTC midnight to the correct day', async () => {
    await store.upsertMany([
      tx({ externalId: 'late', amountMinor: 100n, occurredAt: new Date('2026-07-01T23:59:59.999Z') }),
      tx({ externalId: 'early', amountMinor: 200n, occurredAt: new Date('2026-07-02T00:00:00.000Z') }),
    ]);

    const { days } = await service.getDailyBreakdown({ from: '2026-07-01', to: '2026-07-03' });
    expect(days).toEqual([
      { date: '2026-07-01', currency: 'usd', amountMinor: 100n, transactionCount: 1 },
      { date: '2026-07-02', currency: 'usd', amountMinor: 200n, transactionCount: 1 },
    ]);
  });

  it('excludes a transaction at exactly the exclusive upper bound', async () => {
    await store.upsertMany([
      tx({ externalId: 'inside', amountMinor: 100n, occurredAt: new Date('2026-07-31T23:59:59.999Z') }),
      tx({ externalId: 'at-bound', amountMinor: 999n, occurredAt: new Date('2026-08-01T00:00:00.000Z') }),
    ]);

    const { totals } = await service.getSummary({ from: '2026-07-01', to: '2026-08-01' });
    expect(totals).toEqual([{ currency: 'usd', amountMinor: 100n, transactionCount: 1 }]);
  });

  it('includes a transaction at exactly the inclusive lower bound', async () => {
    await store.upsertMany([
      tx({ externalId: 'at-start', amountMinor: 50n, occurredAt: new Date('2026-07-01T00:00:00.000Z') }),
    ]);
    const { totals } = await service.getSummary({ from: '2026-07-01', to: '2026-07-02' });
    expect(totals).toEqual([{ currency: 'usd', amountMinor: 50n, transactionCount: 1 }]);
  });

  it('buckets by UTC even when the stored offset is not UTC', async () => {
    // 2026-07-02T01:30+05:30 is 2026-07-01T20:00Z — it belongs to July 1st UTC.
    await store.upsertMany([
      tx({ externalId: 'offset', amountMinor: 300n, occurredAt: new Date('2026-07-02T01:30:00+05:30') }),
    ]);
    const { days } = await service.getDailyBreakdown({ from: '2026-07-01', to: '2026-07-03' });
    expect(days).toEqual([
      { date: '2026-07-01', currency: 'usd', amountMinor: 300n, transactionCount: 1 },
    ]);
  });

  it('does not double-count across adjacent half-open ranges', async () => {
    await store.upsertMany([
      tx({ externalId: 'x', amountMinor: 100n, occurredAt: new Date('2026-07-31T12:00:00Z') }),
      tx({ externalId: 'y', amountMinor: 200n, occurredAt: new Date('2026-08-01T12:00:00Z') }),
    ]);

    const july = await service.getSummary({ from: '2026-07-01', to: '2026-08-01' });
    const august = await service.getSummary({ from: '2026-08-01', to: '2026-09-01' });
    const both = await service.getSummary({ from: '2026-07-01', to: '2026-09-01' });

    const usd = (t: { currency: string; amountMinor: bigint }[]) =>
      t.find((x) => x.currency === 'usd')?.amountMinor ?? 0n;

    // Adjacent ranges partition the data exactly — no overlap, no gap.
    expect(usd(july.totals) + usd(august.totals)).toBe(usd(both.totals));
  });
});

describe('multi-currency', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it('reports currencies separately and never sums across them', async () => {
    await new TransactionStore(db).upsertMany([
      tx({ externalId: 'u1', amountMinor: 1000n, currency: 'usd' }),
      tx({ externalId: 'e1', amountMinor: 2000n, currency: 'eur' }),
      tx({ externalId: 'g1', amountMinor: 3000n, currency: 'gbp' }),
    ]);

    const service = new RevenueService(db);
    const { totals } = await service.getSummary({ from: '2026-07-01', to: '2026-07-02' });

    expect(totals).toEqual([
      { currency: 'eur', amountMinor: 2000n, transactionCount: 1 },
      { currency: 'gbp', amountMinor: 3000n, transactionCount: 1 },
      { currency: 'usd', amountMinor: 1000n, transactionCount: 1 },
    ]);
    // Notably absent: any single blended figure.
    expect(totals).toHaveLength(3);
  });
});
