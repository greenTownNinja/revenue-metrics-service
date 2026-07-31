/**
 * POST /demo/stripe-charge, against a fake Stripe and a real Postgres (PGlite).
 *
 * The fake records what was created and then serves those same charges back from
 * charges.list, so the full loop is exercised: create → sync → read the metric.
 * Only the network is faked; StripeAdapter, SyncService, RevenueService and the
 * real SQL all run.
 *
 * What this pins down is the endpoint's actual claim — that the number moves by
 * the collected charges and NOT by the declined or refunded ones.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type Stripe from 'stripe';
import { createApp } from '../src/app.js';
import { createTestDb, type TestDb } from './helpers/testDb.js';
import { SyncService } from '../src/sync/SyncService.js';
import { StripeAdapter } from '../src/sources/stripe/StripeAdapter.js';
import { DEMO_CHARGE_PLAN } from '../src/sources/stripe/StripeDemoCharges.js';

/** Charges the fake has "created", newest first — the order Stripe returns. */
const ledger: Stripe.Charge[] = [];
let nextId = 1;

const fakeStripe = {
  charges: {
    create: async (params: Stripe.ChargeCreateParams) => {
      if (params.source === 'tok_chargeDeclined') {
        // Stripe raises for a declined card but still records a failed charge.
        ledger.unshift(charge(params, 'failed'));
        throw new Error('Your card was declined.');
      }
      const c = charge(params, 'succeeded');
      ledger.unshift(c);
      return c;
    },
    list: async () => ({ data: [...ledger], has_more: false }),
  },
  refunds: {
    create: async ({ charge: id }: { charge: string }) => {
      const c = ledger.find((x) => x.id === id);
      if (c) {
        c.refunded = true;
        c.amount_refunded = c.amount;
      }
      return { id: 're_test' };
    },
  },
} as unknown as Stripe;

function charge(params: Stripe.ChargeCreateParams, status: string): Stripe.Charge {
  return {
    id: `ch_fake_${nextId++}`,
    amount: Number(params.amount),
    amount_refunded: 0,
    refunded: false,
    currency: String(params.currency),
    status,
    created: Math.floor(Date.now() / 1000),
  } as Stripe.Charge;
}

let db: TestDb;
let server: Server;
let base: string;

beforeAll(async () => {
  db = await createTestDb();
  const app = createApp({
    db,
    syncService: new SyncService(db, [new StripeAdapter(fakeStripe)]),
    stripe: fakeStripe,
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
});

async function demoCharge(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/demo/stripe-charge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('POST /demo/stripe-charge', () => {
  it('creates the charges without moving the metric, then syncing moves it by the collected ones', async () => {
    const { status, body } = await demoCharge({});
    expect(status).toBe(201);

    // Every charge in the plan really exists in Stripe now.
    expect(body.created).toHaveLength(DEMO_CHARGE_PLAN.length);
    expect(ledger).toHaveLength(DEMO_CHARGE_PLAN.length);

    // …and none of it is revenue yet, because nothing has ingested it. This is
    // the property the endpoint exists to demonstrate: creating money upstream
    // does not change the number.
    expect(body.metricBeforeSync.totals).toEqual([]);
    expect(body).not.toHaveProperty('sync');

    const totalFor = (totals: { currency: string; amountMinor: string }[], currency: string) => {
      const row = totals.find((t) => t.currency === currency);
      return row ? BigInt(row.amountMinor) : 0n;
    };

    // The explicit second step a caller has to take.
    const syncRes = await fetch(`${base}/sync?source=stripe`, { method: 'POST' });
    expect(syncRes.status).toBe(200);
    expect(((await syncRes.json()) as any).upserted).toBe(DEMO_CHARGE_PLAN.length);

    const after = (await fetch(
      `${base}/revenue/summary?from=${body.range.from}&to=${body.range.to}`,
    ).then((r) => r.json())) as any;

    const collected = DEMO_CHARGE_PLAN.filter((c) => c.countsTowardRevenue);
    const excluded = DEMO_CHARGE_PLAN.filter((c) => !c.countsTowardRevenue);
    expect(excluded.length).toBeGreaterThan(0); // the demo must exclude something

    for (const currency of new Set(DEMO_CHARGE_PLAN.map((c) => c.currency))) {
      let want = 0n;
      for (const c of collected.filter((c) => c.currency === currency)) {
        want += BigInt(c.amountMinor);
      }
      // Baseline was empty, so the after-total IS the delta. The declined and
      // fully-refunded charges are in Stripe and in Postgres, but not in here.
      expect(totalFor(after.totals, currency)).toBe(want);
    }
  });

  it('rate-limits a second immediate request', async () => {
    // The cooldown is process-wide, so the previous test's run starts it.
    const { status, body } = await demoCharge({ count: 1 });
    expect(status).toBe(429);
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('rejects a count outside the fixed plan', async () => {
    const { status, body } = await demoCharge({ count: DEMO_CHARGE_PLAN.length + 1 });
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    // Rejected on shape, before the cooldown is consumed or anything is charged.
    expect(body.error.details.field).toBe('count');
  });
});
