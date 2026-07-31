/**
 * PayPal normalization — vocabulary mapping and, mostly, money.
 *
 * PayPal is the source that reports amounts as decimal strings, so it is where a
 * float would sneak into a service that has none anywhere else.
 */

import { describe, expect, it } from 'vitest';
import {
  PAYPAL_VOCABULARY,
  PayPalAdapter,
  normalizePayPalTransaction,
} from '../src/sources/paypal/PayPalAdapter.js';
import { parseDecimalToMinor, currencyExponent, DecimalParseError } from '../src/sources/decimal.js';
import { CanonicalStatus, isCollected } from '../src/revenue/canonical.js';
import type { PayPalClient, PayPalTransaction } from '../src/sources/paypal/PayPalClient.js';

function tx(info: Record<string, unknown>): PayPalTransaction {
  return {
    transaction_info: {
      transaction_id: 'TXN123',
      transaction_status: 'S',
      transaction_amount: { currency_code: 'USD', value: '45.00' },
      transaction_initiation_date: '2026-07-04T10:00:00+0000',
      ...info,
    },
  } as PayPalTransaction;
}

describe('decimal string → minor units', () => {
  it('converts without ever touching a float', () => {
    expect(parseDecimalToMinor('45.00', 'usd')).toBe(4500n);
    expect(parseDecimalToMinor('0.01', 'usd')).toBe(1n);
    expect(parseDecimalToMinor('1234.5', 'usd')).toBe(123450n);
    expect(parseDecimalToMinor('1000', 'usd')).toBe(100000n);
    expect(parseDecimalToMinor('-88.00', 'usd')).toBe(-8800n);
  });

  it('gets right the values that float arithmetic gets wrong', () => {
    // 19.99 * 100 is 1998.9999999999998 in IEEE-754. This is the bug class the
    // whole service is built to avoid, arriving through the one provider that
    // reports money as text.
    expect(parseDecimalToMinor('19.99', 'usd')).toBe(1999n);
    expect(parseDecimalToMinor('0.29', 'usd')).toBe(29n);
    // Guard the guard: the naive conversion really is wrong here. Math.round()
    // rescues this particular value, which is exactly why the bug survives code
    // review — it fails on some inputs and not others.
    expect(19.99 * 100).not.toBe(1999);
    expect(19.99 * 100).toBeCloseTo(1999);
  });

  it('stays exact far beyond Number.MAX_SAFE_INTEGER', () => {
    expect(parseDecimalToMinor('90071992547409.93', 'usd')).toBe(9007199254740993n);
  });

  it('honours zero-decimal currencies', () => {
    expect(currencyExponent('jpy')).toBe(0);
    expect(currencyExponent('usd')).toBe(2);
    // 1500 JPY is 1500 yen, not 15.00 — treating it as 2-decimal would be a
    // 100x error in the total.
    expect(parseDecimalToMinor('1500', 'jpy')).toBe(1500n);
    expect(parseDecimalToMinor('1500', 'huf')).toBe(1500n);
  });

  it('refuses precision the currency cannot represent, rather than rounding', () => {
    // Silently rounding would invent or destroy half a cent.
    expect(() => parseDecimalToMinor('10.005', 'usd')).toThrow(DecimalParseError);
    expect(() => parseDecimalToMinor('1500.5', 'jpy')).toThrow(DecimalParseError);
    // Trailing zeros are unambiguous, so they are fine.
    expect(parseDecimalToMinor('10.5000', 'usd')).toBe(1050n);
  });

  it('rejects anything that is not a plain decimal', () => {
    for (const bad of ['', '  ', 'abc', '1,234.00', '1e3', 'NaN', 'Infinity', '4.5.6', '$45']) {
      expect(() => parseDecimalToMinor(bad, 'usd'), bad).toThrow(DecimalParseError);
    }
  });
});

describe('PayPal vocabulary', () => {
  it('pins the single-letter status codes', () => {
    expect(PAYPAL_VOCABULARY).toEqual({
      s: CanonicalStatus.COLLECTED,
      p: CanonicalStatus.PENDING,
      v: CanonicalStatus.REFUNDED,
      d: CanonicalStatus.FAILED,
    });
  });

  it('shares no collected spelling with any other source', () => {
    // 'S' vs 'succeeded' vs 'paid' — three sources agreeing on nothing except the
    // canonical enum is what makes the normalization layer worth having.
    const collected = Object.entries(PAYPAL_VOCABULARY)
      .filter(([, s]) => isCollected(s))
      .map(([k]) => k);
    expect(collected).toEqual(['s']);
  });
});

describe('PayPal transaction normalization', () => {
  it('normalizes a successful transaction', () => {
    const result = normalizePayPalTransaction(tx({}));
    if ('reason' in result) throw new Error(`unexpected quarantine: ${result.reason}`);

    expect(result).toMatchObject({
      source: 'paypal',
      externalId: 'TXN123',
      amountMinor: 4500n,
      currency: 'usd',
      rawStatus: 'S',
      canonicalStatus: CanonicalStatus.COLLECTED,
    });
    expect(result.occurredAt.toISOString()).toBe('2026-07-04T10:00:00.000Z');
  });

  it('maps each status code to its canonical meaning', () => {
    const cases: [string, CanonicalStatus][] = [
      ['S', CanonicalStatus.COLLECTED],
      ['P', CanonicalStatus.PENDING],
      ['V', CanonicalStatus.REFUNDED],
      ['D', CanonicalStatus.FAILED],
      ['s', CanonicalStatus.COLLECTED],
      ['T', CanonicalStatus.UNKNOWN],
      ['SUCCESS', CanonicalStatus.UNKNOWN],
    ];
    for (const [code, expected] of cases) {
      const result = normalizePayPalTransaction(tx({ transaction_status: code }));
      if ('reason' in result) throw new Error('unexpected quarantine');
      expect(result.canonicalStatus, code).toBe(expected);
    }
  });

  it('treats a negative amount as a reversal, not as negative revenue', () => {
    // PayPal reports refunds and payouts as negative values. Storing a negative
    // amount would violate the CHECK constraint and, worse, would let an outflow
    // silently reduce a collected total instead of being excluded outright.
    const result = normalizePayPalTransaction(
      tx({ transaction_amount: { currency_code: 'USD', value: '-88.00' }, transaction_status: 'S' }),
    );
    if ('reason' in result) throw new Error('unexpected quarantine');
    expect(result.amountMinor).toBe(8800n);
    expect(result.canonicalStatus).toBe(CanonicalStatus.REFUNDED);
    expect(isCollected(result.canonicalStatus)).toBe(false);
  });

  it('preserves the raw status verbatim', () => {
    const result = normalizePayPalTransaction(tx({ transaction_status: ' s ' }));
    if ('reason' in result) throw new Error('unexpected quarantine');
    expect(result.rawStatus).toBe(' s ');
    expect(result.canonicalStatus).toBe(CanonicalStatus.COLLECTED);
  });

  it('falls back to transaction_updated_date when initiation date is absent', () => {
    const result = normalizePayPalTransaction(
      tx({
        transaction_initiation_date: undefined,
        transaction_updated_date: '2026-07-05T08:30:00+0000',
      }),
    );
    if ('reason' in result) throw new Error('unexpected quarantine');
    expect(result.occurredAt.toISOString()).toBe('2026-07-05T08:30:00.000Z');
  });

  it('quarantines malformed transactions instead of throwing', () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ transaction_id: '' }, /missing transaction_id/],
      [{ transaction_amount: { currency_code: 'DOLLARS', value: '1.00' } }, /not ISO 4217/],
      [{ transaction_amount: { currency_code: 'USD' } }, /value is missing/],
      [{ transaction_amount: { currency_code: 'USD', value: 'abc' } }, /not a decimal number/],
      [{ transaction_amount: { currency_code: 'USD', value: '10.005' } }, /more precision/],
      [{ transaction_initiation_date: 'not-a-date', transaction_updated_date: undefined }, /not a valid timestamp/],
      [{ transaction_initiation_date: undefined, transaction_updated_date: undefined }, /is missing/],
      [{ transaction_status: '' }, /missing transaction_status/],
    ];

    for (const [overrides, expected] of cases) {
      const result = normalizePayPalTransaction(tx(overrides));
      expect('reason' in result, JSON.stringify(overrides)).toBe(true);
      if ('reason' in result) expect(result.reason).toMatch(expected);
    }
  });

  it('survives a completely empty payload', () => {
    const result = normalizePayPalTransaction({} as PayPalTransaction);
    expect('reason' in result).toBe(true);
  });
});

/**
 * The reporting-lag horizon.
 *
 * PayPal's Transaction Search does not show transactions for up to three hours,
 * and answers 404 rather than an empty page when asked for a window that recent.
 * Both facts are load-bearing, and the second one caused a live 503.
 */
describe('PayPal reporting horizon', () => {
  const HOUR = 3_600_000;

  /** Records the windows requested, and returns nothing. */
  function spyClient(): { client: PayPalClient; windows: { start: Date; end: Date }[] } {
    const windows: { start: Date; end: Date }[] = [];
    const client = {
      listTransactions: async (p: { startDate: Date; endDate: Date; page: number }) => {
        windows.push({ start: p.startDate, end: p.endDate });
        return { transaction_details: [], page: p.page, total_pages: 1 };
      },
    } as unknown as PayPalClient;
    return { client, windows };
  }

  it('never requests a window reaching into the last three hours', async () => {
    const { client, windows } = spyClient();
    const adapter = new PayPalAdapter(client);
    const cursor = new Date(Date.now() - 10 * HOUR).toISOString();

    await adapter.fetch({ cursor, maxPages: 10 });

    expect(windows.length).toBeGreaterThan(0);
    const newest = Math.max(...windows.map((w) => w.end.getTime()));
    // Allow a second of slack for the clock moving during the call.
    expect(newest).toBeLessThanOrEqual(Date.now() - 3 * HOUR + 1000);
  });

  it('does not advance the watermark into the unsettled window', async () => {
    const { client } = spyClient();
    const adapter = new PayPalAdapter(client);
    const cursor = new Date(Date.now() - 10 * HOUR).toISOString();

    const result = await adapter.fetch({ cursor, maxPages: 10 });

    // Advancing to `now` would permanently skip transactions that only become
    // visible later — they would fall behind the watermark before being fetched.
    expect(result.nextCursor).not.toBeNull();
    expect(new Date(result.nextCursor!).getTime()).toBeLessThanOrEqual(
      Date.now() - 3 * HOUR + 1000,
    );
  });

  it('makes no request at all once caught up, and holds the watermark', async () => {
    const { client, windows } = spyClient();
    const adapter = new PayPalAdapter(client);
    // Watermark inside the lag window: everything newer is invisible to PayPal.
    const cursor = new Date(Date.now() - 30 * 60_000).toISOString();

    const result = await adapter.fetch({ cursor, maxPages: 10 });

    // A request here is what produced the 404 → 503 in production.
    expect(windows).toHaveLength(0);
    expect(result.fetched).toBe(0);
    expect(result.nextCursor).toBe(cursor);
  });
});
