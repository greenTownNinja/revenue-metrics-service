/**
 * MAPPING SNAPSHOT — pins every provider status to its canonical meaning.
 *
 * Changing a mapping requires editing this file, which turns "revenue moved" from
 * an accident into a reviewed decision. It also asserts the property that makes
 * the whole design safe: no adapter may map an unrecognised status to COLLECTED.
 */

import { describe, expect, it } from 'vitest';
import { CanonicalStatus, COLLECTED_STATUSES, isCollected } from '../src/revenue/canonical.js';
import { STRIPE_VOCABULARY, normalizeCharge } from '../src/sources/stripe/StripeAdapter.js';
import { LEDGER_VOCABULARY } from '../src/sources/ledgerCsv/LedgerCsvAdapter.js';
import { PAYPAL_VOCABULARY } from '../src/sources/paypal/PayPalAdapter.js';
import type Stripe from 'stripe';

/** Every registered vocabulary. Add a source here and the invariants below cover it. */
const ALL_VOCABULARIES = [STRIPE_VOCABULARY, LEDGER_VOCABULARY, PAYPAL_VOCABULARY];

describe('provider vocabularies', () => {
  it('pins the Stripe charge vocabulary', () => {
    expect(STRIPE_VOCABULARY).toEqual({
      succeeded: CanonicalStatus.COLLECTED,
      pending: CanonicalStatus.PENDING,
      failed: CanonicalStatus.FAILED,
      refunded: CanonicalStatus.REFUNDED,
    });
  });

  it('pins the ledger CSV vocabulary', () => {
    expect(LEDGER_VOCABULARY).toEqual({
      paid: CanonicalStatus.COLLECTED,
      completed: CanonicalStatus.COLLECTED,
      captured: CanonicalStatus.COLLECTED,
      processing: CanonicalStatus.PENDING,
      awaiting_payment: CanonicalStatus.PENDING,
      voided: CanonicalStatus.VOIDED,
      failed: CanonicalStatus.FAILED,
      refunded: CanonicalStatus.REFUNDED,
    });
  });

  it('uses genuinely different spellings for "collected" across all sources', () => {
    // 'succeeded' vs 'paid'/'completed' vs 'S'. If any two sources happened to
    // agree, this suite would not be testing normalization at all.
    const collectedIn = (v: Record<string, CanonicalStatus>) =>
      new Set(Object.entries(v).filter(([, s]) => isCollected(s)).map(([k]) => k));

    const vocabs = [
      ['stripe', collectedIn({ ...STRIPE_VOCABULARY })],
      ['ledger', collectedIn({ ...LEDGER_VOCABULARY })],
      ['paypal', collectedIn({ ...PAYPAL_VOCABULARY })],
    ] as const;

    for (const [name, set] of vocabs) {
      expect(set.size, `${name} has no collected status`).toBeGreaterThan(0);
    }

    // Pairwise disjoint: no spelling of "collected" is shared by two providers.
    for (let i = 0; i < vocabs.length; i += 1) {
      for (let j = i + 1; j < vocabs.length; j += 1) {
        const [nameA, a] = vocabs[i]!;
        const [nameB, b] = vocabs[j]!;
        const shared = [...a].filter((s) => b.has(s));
        expect(shared, `${nameA} and ${nameB} share ${shared.join(', ')}`).toEqual([]);
      }
    }
  });

  it('never maps a status to a canonical value outside the enum', () => {
    const valid = new Set<string>(Object.values(CanonicalStatus));
    for (const vocab of ALL_VOCABULARIES) {
      for (const status of Object.values(vocab)) {
        expect(valid.has(status)).toBe(true);
      }
    }
  });

  it('keeps UNKNOWN out of every vocabulary, so it can only arise from a miss', () => {
    for (const vocab of ALL_VOCABULARIES) {
      expect(Object.values(vocab)).not.toContain(CanonicalStatus.UNKNOWN);
    }
    expect(COLLECTED_STATUSES).not.toContain(CanonicalStatus.UNKNOWN);
  });
});

/** Minimal charge fixture; only the fields normalizeCharge reads. */
function charge(overrides: Partial<Stripe.Charge>): Stripe.Charge {
  return {
    id: 'ch_test',
    amount: 5000,
    amount_refunded: 0,
    currency: 'usd',
    status: 'succeeded',
    created: Math.floor(Date.UTC(2026, 6, 1, 12) / 1000),
    refunded: false,
    ...overrides,
  } as Stripe.Charge;
}

describe('Stripe charge normalization', () => {
  it('keeps amounts as integer minor units, untouched', () => {
    const result = normalizeCharge(charge({ amount: 123456 }));
    expect(result).not.toHaveProperty('reason');
    if ('reason' in result) throw new Error('unexpected quarantine');
    expect(result.amountMinor).toBe(123456n);
    expect(result.currency).toBe('usd');
    expect(result.occurredAt.toISOString()).toBe('2026-07-01T12:00:00.000Z');
  });

  it('treats a fully refunded charge as REFUNDED despite status "succeeded"', () => {
    // Stripe leaves a refunded charge's status as `succeeded`. Taking that at
    // face value would count money we handed back.
    const result = normalizeCharge(
      charge({ amount: 5000, amount_refunded: 5000, refunded: true }),
    );
    if ('reason' in result) throw new Error('unexpected quarantine');
    expect(result.canonicalStatus).toBe(CanonicalStatus.REFUNDED);
    expect(isCollected(result.canonicalStatus)).toBe(false);
    // The provider's literal status is still recoverable from the row.
    expect(result.rawStatus).toContain('stripe:succeeded');
  });

  it('counts a partially refunded charge in full, and records the refund', () => {
    // Documented v1 limitation: refunds are not netted. The data makes it visible.
    const result = normalizeCharge(
      charge({ amount: 5000, amount_refunded: 1500, refunded: false }),
    );
    if ('reason' in result) throw new Error('unexpected quarantine');
    expect(result.canonicalStatus).toBe(CanonicalStatus.COLLECTED);
    expect(result.amountMinor).toBe(5000n);
    expect(result.amountRefundedMinor).toBe(1500n);
  });

  it('maps an unseen Stripe status to UNKNOWN', () => {
    const result = normalizeCharge(charge({ status: 'disputed' as Stripe.Charge.Status }));
    if ('reason' in result) throw new Error('unexpected quarantine');
    expect(result.canonicalStatus).toBe(CanonicalStatus.UNKNOWN);
  });

  it('quarantines malformed charges instead of throwing', () => {
    const cases: [Partial<Stripe.Charge>, RegExp][] = [
      [{ id: '' }, /missing charge id/],
      [{ amount: 12.5 }, /not a non-negative integer/],
      [{ amount: -100 }, /not a non-negative integer/],
      [{ currency: 'dollars' }, /not ISO 4217/],
      [{ created: 0 }, /created timestamp is invalid/],
      [{ amount: 100, amount_refunded: 500 }, /outside \[0, 100\]/],
    ];

    for (const [overrides, expected] of cases) {
      const result = normalizeCharge(charge(overrides));
      expect('reason' in result, JSON.stringify(overrides)).toBe(true);
      if ('reason' in result) expect(result.reason).toMatch(expected);
    }
  });

  it('lowercases the currency so grouping is stable', () => {
    const result = normalizeCharge(charge({ currency: 'EUR' }));
    if ('reason' in result) throw new Error('unexpected quarantine');
    expect(result.currency).toBe('eur');
  });
});
