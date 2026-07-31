/**
 * A small, FIXED set of Stripe test charges used to demonstrate that new money
 * flows through to the metric.
 *
 * Lives in src/ rather than in scripts/ because both the CLI demo
 * (`npm run demo:charge`) and the HTTP endpoint (`POST /demo/stripe-charge`)
 * create the same charges. Two copies of "the demo data" would drift, and the
 * whole point of this project is that duplicated definitions drift.
 *
 * WHY FIXED AMOUNTS. seedStripe.ts generates a random weighted mix, which is
 * right for bulk seeding and useless for a demo: you cannot state in advance what
 * the total will become. Every amount here is a round number, so the expected
 * movement can be read out before the charge is created and checked after.
 *
 * WHY SOME OF THEM MUST NOT COUNT. A demo where every new charge is collected
 * proves the sum works. It does not prove the allow-list does anything. The
 * declined and refunded entries are real Stripe charges that the metric must
 * ignore.
 *
 * This module creates charges. It never reads or aggregates them — the number is
 * only ever obtained by syncing and asking RevenueService.
 */

import type Stripe from 'stripe';

export interface DemoChargeSpec {
  label: string;
  currency: string;
  /** Minor units, matching how the rest of the system carries money. */
  amountMinor: number;
  /** Stripe test token producing this outcome deterministically. */
  token: string;
  refund?: 'full';
  /** Whether this charge should end up inside the revenue number. */
  countsTowardRevenue: boolean;
  /** Why it does or does not count. Returned to the caller so the demo explains itself. */
  note: string;
}

export const DEMO_CHARGE_PLAN: readonly DemoChargeSpec[] = Object.freeze([
  {
    label: 'collected usd',
    currency: 'usd',
    amountMinor: 25_000,
    token: 'tok_visa',
    countsTowardRevenue: true,
    note: 'stripe:succeeded → COLLECTED (on the allow-list)',
  },
  {
    label: 'collected usd',
    currency: 'usd',
    amountMinor: 9_950,
    token: 'tok_visa',
    countsTowardRevenue: true,
    note: 'stripe:succeeded → COLLECTED (on the allow-list)',
  },
  {
    label: 'collected eur',
    currency: 'eur',
    amountMinor: 12_000,
    token: 'tok_visa',
    countsTowardRevenue: true,
    note: 'stripe:succeeded → COLLECTED, and EUR totals stay separate',
  },
  {
    label: 'declined usd',
    currency: 'usd',
    amountMinor: 7_500,
    token: 'tok_chargeDeclined',
    countsTowardRevenue: false,
    note: 'card declined → FAILED (not on the allow-list)',
  },
  {
    label: 'refunded usd',
    currency: 'usd',
    amountMinor: 20_000,
    token: 'tok_visa',
    refund: 'full',
    countsTowardRevenue: false,
    note: 'fully refunded → REFUNDED, even though Stripe still reports "succeeded"',
  },
]);

export const MAX_DEMO_CHARGES = DEMO_CHARGE_PLAN.length;

export interface CreatedDemoCharge {
  /** Stripe charge id, or null when the card was declined before one was returned. */
  id: string | null;
  label: string;
  currency: string;
  amountMinor: number;
  countsTowardRevenue: boolean;
  note: string;
}

/**
 * Creates the first `count` charges of the plan.
 *
 * Sequential rather than parallel: this is at most five charges, and a demo that
 * trips Stripe's rate limiter to save two seconds is a bad trade.
 */
export async function createDemoCharges(
  stripe: Stripe,
  count: number = MAX_DEMO_CHARGES,
): Promise<CreatedDemoCharge[]> {
  const plan = DEMO_CHARGE_PLAN.slice(0, Math.max(1, Math.min(MAX_DEMO_CHARGES, count)));
  const created: CreatedDemoCharge[] = [];

  for (const spec of plan) {
    const base = {
      label: spec.label,
      currency: spec.currency,
      amountMinor: spec.amountMinor,
      countsTowardRevenue: spec.countsTowardRevenue,
      note: spec.note,
    };

    try {
      const charge = await stripe.charges.create({
        amount: spec.amountMinor,
        currency: spec.currency,
        source: spec.token,
        description: `revenue-metrics live demo: ${spec.label}`,
        metadata: { seed: 'revenue-metrics', demo: 'live', label: spec.label },
      });
      if (spec.refund === 'full') {
        await stripe.refunds.create({ charge: charge.id });
      }
      created.push({ ...base, id: charge.id });
    } catch (err) {
      // A declined test card raises rather than returning a failed charge. Stripe
      // still records the failed charge object, which is exactly what we want the
      // sync to pick up and the allow-list to exclude — so this is the intended
      // path for that entry, not an error.
      if (spec.token === 'tok_chargeDeclined') {
        created.push({ ...base, id: null });
        continue;
      }
      throw err;
    }
  }

  return created;
}
