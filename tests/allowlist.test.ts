/**
 * The allow-list, status by status — including the case the problem statement is
 * really about: a status nobody has seen before must contribute zero.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, tx, type TestDb } from './helpers/testDb.js';
import { TransactionStore } from '../src/sync/TransactionStore.js';
import { RevenueService } from '../src/revenue/RevenueService.js';
import {
  CanonicalStatus,
  COLLECTED_STATUSES,
  STATUS_CLASSIFICATION,
  isCollected,
  buildStatusMapper,
} from '../src/revenue/canonical.js';

const RANGE = { from: '2026-07-01', to: '2026-08-01' };

describe('collected-status allow-list', () => {
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

  const usdTotal = async (): Promise<bigint> => {
    const { totals } = await service.getSummary(RANGE);
    return totals.find((t) => t.currency === 'usd')?.amountMinor ?? 0n;
  };

  it('accumulates only collected statuses as revenue', async () => {
    await store.upsertMany([
      tx({ externalId: 'a', amountMinor: 100n, canonicalStatus: CanonicalStatus.COLLECTED }),
    ]);
    expect(await usdTotal()).toBe(100n);

    await store.upsertMany([
      tx({ externalId: 'b', amountMinor: 200n, canonicalStatus: CanonicalStatus.FAILED, rawStatus: 'failed' }),
    ]);
    expect(await usdTotal()).toBe(100n);

    await store.upsertMany([
      tx({ externalId: 'c', amountMinor: 300n, canonicalStatus: CanonicalStatus.PENDING, rawStatus: 'processing' }),
    ]);
    expect(await usdTotal()).toBe(100n);

    await store.upsertMany([
      tx({ externalId: 'd', amountMinor: 700n, canonicalStatus: CanonicalStatus.VOIDED, rawStatus: 'voided' }),
    ]);
    expect(await usdTotal()).toBe(100n);

    await store.upsertMany([
      tx({ externalId: 'e', amountMinor: 800n, canonicalStatus: CanonicalStatus.REFUNDED, rawStatus: 'refunded', amountRefundedMinor: 800n }),
    ]);
    expect(await usdTotal()).toBe(100n);

    // A different source's spelling of "collected" — same canonical status.
    await store.upsertMany([
      tx({ externalId: 'f', amountMinor: 400n, source: 'ledger-csv', rawStatus: 'paid', canonicalStatus: CanonicalStatus.COLLECTED }),
    ]);
    expect(await usdTotal()).toBe(500n);
  });

  it('excludes an unrecognised status and surfaces it in /revenue/unmapped', async () => {
    await store.upsertMany([
      tx({ externalId: 'ok', amountMinor: 100n, canonicalStatus: CanonicalStatus.COLLECTED }),
      // The scenario the allow-list exists for: a provider ships a new status.
      tx({
        externalId: 'new',
        amountMinor: 500n,
        rawStatus: 'disputed',
        canonicalStatus: CanonicalStatus.UNKNOWN,
      }),
    ]);

    expect(await usdTotal()).toBe(100n);

    const { unmapped } = await service.getUnmappedStatuses(RANGE);
    expect(unmapped).toHaveLength(1);
    expect(unmapped[0]).toMatchObject({
      rawStatus: 'disputed',
      occurrences: 1,
      excludedAmountMinor: 500n,
    });
  });

  it('never lets an unmapped provider status default to collected', () => {
    const map = buildStatusMapper({ paid: CanonicalStatus.COLLECTED });
    for (const unseen of ['disputed', 'on_hold', 'chargeback_reversed', '', 'COLLECTED']) {
      expect(map(unseen)).toBe(CanonicalStatus.UNKNOWN);
      expect(isCollected(map(unseen))).toBe(false);
    }
  });

  it('matches provider statuses regardless of case and padding', () => {
    const map = buildStatusMapper({ paid: CanonicalStatus.COLLECTED });
    for (const variant of ['paid', 'PAID', 'Paid', '  paid  ', '\tPaid\n']) {
      expect(map(variant)).toBe(CanonicalStatus.COLLECTED);
    }
  });

  it('classifies every canonical status explicitly', () => {
    // Adding an enum member without a classification fails here rather than
    // silently defaulting one way or the other.
    for (const status of Object.values(CanonicalStatus)) {
      expect(
        Object.prototype.hasOwnProperty.call(STATUS_CLASSIFICATION, status),
        `CanonicalStatus.${status} is not classified in STATUS_CLASSIFICATION`,
      ).toBe(true);
      expect(typeof STATUS_CLASSIFICATION[status]).toBe('boolean');
    }
    expect(Object.keys(STATUS_CLASSIFICATION).sort()).toEqual(
      Object.values(CanonicalStatus).sort(),
    );
  });

  it('keeps the allow-list consistent with the classification map', () => {
    const collectedFromMap = Object.entries(STATUS_CLASSIFICATION)
      .filter(([, counts]) => counts)
      .map(([status]) => status)
      .sort();
    expect([...COLLECTED_STATUSES].map(String).sort()).toEqual(collectedFromMap);
  });

  it('treats UNKNOWN as not collected, by construction', () => {
    expect(isCollected(CanonicalStatus.UNKNOWN)).toBe(false);
    expect(COLLECTED_STATUSES).not.toContain(CanonicalStatus.UNKNOWN);
  });

  it('sums exactly above Number.MAX_SAFE_INTEGER', async () => {
    // Proves the BIGINT path end to end. big + 2n is 2^53 + 1, the smallest
    // integer a JS double cannot represent.
    const big = BigInt(Number.MAX_SAFE_INTEGER); // 2^53 - 1
    await store.upsertMany([
      tx({ externalId: 'big1', amountMinor: big }),
      tx({ externalId: 'big2', amountMinor: 1n }),
      tx({ externalId: 'big3', amountMinor: 1n }),
    ]);

    const total = await usdTotal();
    expect(total).toBe(big + 2n);

    // Guard the guard: had this value passed through a double anywhere in the
    // stack it would have collapsed onto 2^53 and been indistinguishable from
    // big + 1n. The BigInt comparison above is what makes the test meaningful.
    expect(Number(big + 2n)).toBe(Number(big + 1n));
    expect(total).not.toBe(big + 1n);
  });
});
