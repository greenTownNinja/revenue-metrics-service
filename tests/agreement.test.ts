/**
 * AGREEMENT TEST — the summary and the daily breakdown must always produce the
 * same number.
 *
 * Randomized over many ranges rather than a handful of hand-picked ones, because
 * the interesting failures live at boundaries nobody thought to write down.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/testDb.js';
import { TransactionStore } from '../src/sync/TransactionStore.js';
import { RevenueService } from '../src/revenue/RevenueService.js';
import { CanonicalStatus } from '../src/revenue/canonical.js';
import type { NormalizedTransaction } from '../src/sources/SourceAdapter.js';

/** Deterministic PRNG so a failure is reproducible from the seed alone. */
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATUSES = Object.values(CanonicalStatus);
const CURRENCIES = ['usd', 'eur', 'gbp'];
const SOURCES = ['stripe', 'ledger-csv', 'future-provider'];

describe('summary and daily breakdown always agree', () => {
  let db: TestDb;
  let service: RevenueService;

  beforeAll(async () => {
    db = await createTestDb();
    service = new RevenueService(db);

    const rand = mulberry32(20260730);
    const rows: NormalizedTransaction[] = [];

    // Spread across ~120 days, with timestamps deliberately clustered near UTC
    // midnight where day bucketing is most likely to disagree with a range bound.
    for (let i = 0; i < 900; i += 1) {
      const dayOffset = Math.floor(rand() * 120);
      const nearMidnight = rand() < 0.4;
      const msIntoDay = nearMidnight
        ? rand() < 0.5
          ? Math.floor(rand() * 2000) // just after 00:00:00.000Z
          : 86_400_000 - 1 - Math.floor(rand() * 2000) // just before 24:00Z
        : Math.floor(rand() * 86_400_000);

      const occurredAt = new Date(
        Date.UTC(2026, 3, 1) + dayOffset * 86_400_000 + msIntoDay,
      );

      rows.push({
        source: SOURCES[Math.floor(rand() * SOURCES.length)]!,
        externalId: `rand_${i}`,
        amountMinor: BigInt(Math.floor(rand() * 500_000)),
        amountRefundedMinor: 0n,
        currency: CURRENCIES[Math.floor(rand() * CURRENCIES.length)]!,
        rawStatus: 'generated',
        canonicalStatus: STATUSES[Math.floor(rand() * STATUSES.length)]!,
        occurredAt,
      });
    }

    await new TransactionStore(db).upsertMany(rows);
  });

  afterAll(async () => {
    await db.close();
  });

  it('holds for 200 randomized ranges', async () => {
    const rand = mulberry32(777);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    for (let n = 0; n < 200; n += 1) {
      const start = Date.UTC(2026, 2, 15) + Math.floor(rand() * 150) * 86_400_000;
      const span = 1 + Math.floor(rand() * 60);
      const from = iso(new Date(start));
      const to = iso(new Date(start + span * 86_400_000));

      const summary = await service.getSummary({ from, to });
      const breakdown = await service.getDailyBreakdown({ from, to });
      const folded = RevenueService.foldBreakdown(breakdown.days);

      // Compared as BigInt, not as Number: an assertion that goes through a
      // double would hide precisely the precision bug we care about.
      expect(folded, `range ${from}..${to}`).toEqual(summary.totals);
    }
  });

  it('holds for a single-day range', async () => {
    const summary = await service.getSummary({ from: '2026-05-04', to: '2026-05-05' });
    const breakdown = await service.getDailyBreakdown({ from: '2026-05-04', to: '2026-05-05' });
    expect(RevenueService.foldBreakdown(breakdown.days)).toEqual(summary.totals);
    // Sanity: a single-day breakdown can only mention that one day.
    expect(new Set(breakdown.days.map((d) => d.date))).toEqual(new Set(['2026-05-04']));
  });

  it('holds for an empty range, returning zero rather than erroring', async () => {
    const from = '2030-01-01';
    const to = '2030-02-01';
    const summary = await service.getSummary({ from, to });
    const breakdown = await service.getDailyBreakdown({ from, to });

    expect(summary.totals).toEqual([]);
    expect(breakdown.days).toEqual([]);
    expect(RevenueService.foldBreakdown(breakdown.days)).toEqual(summary.totals);
  });

  it('reports the identical definition from both views', async () => {
    const from = '2026-04-01';
    const to = '2026-05-01';
    const summary = await service.getSummary({ from, to });
    const breakdown = await service.getDailyBreakdown({ from, to });

    // A caller comparing two numbers can check they were computed under the same
    // rules, not just that they happen to match today.
    expect(breakdown.definition).toEqual(summary.definition);
    expect(breakdown.range).toEqual(summary.range);
  });
});
