/**
 * Creates sample charges in a Stripe TEST-mode account, so a fresh account has
 * data whose statuses actually exercise the allow-list.
 *
 * `STRIPE_SECRET_KEY=sk_test_... npm run seed:stripe`
 *
 * Uses Stripe's test tokens, which deterministically produce each outcome:
 *   tok_visa               → succeeded
 *   tok_chargeDeclined     → card_declined (the charge attempt fails)
 * Plus a refund, and a non-USD charge, so the data covers the cases that make
 * the metric interesting.
 */

import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('STRIPE_SECRET_KEY is not set');
  process.exit(1);
}
if (!key.startsWith('sk_test_') && !key.startsWith('rk_test_')) {
  console.error('Refusing to run: STRIPE_SECRET_KEY must be a TEST-mode key (sk_test_…).');
  process.exit(1);
}

const stripe = new Stripe(key, { maxNetworkRetries: 2 });

interface Plan {
  label: string;
  amount: number;
  currency: string;
  source: string;
  refund?: 'full' | 'partial';
}

const PLAN: Plan[] = [
  { label: 'collected usd', amount: 45_000, currency: 'usd', source: 'tok_visa' },
  { label: 'collected usd', amount: 12_500, currency: 'usd', source: 'tok_visa' },
  { label: 'collected usd', amount: 30_000, currency: 'usd', source: 'tok_visa' },
  { label: 'collected eur', amount: 7_500, currency: 'eur', source: 'tok_visa' },
  { label: 'collected gbp', amount: 60_000, currency: 'gbp', source: 'tok_visa' },
  { label: 'declined (never collected)', amount: 64_000, currency: 'usd', source: 'tok_chargeDeclined' },
  { label: 'fully refunded', amount: 88_000, currency: 'usd', source: 'tok_visa', refund: 'full' },
  { label: 'partially refunded', amount: 20_000, currency: 'usd', source: 'tok_visa', refund: 'partial' },
];

let created = 0;
let declined = 0;

for (const p of PLAN) {
  try {
    const charge = await stripe.charges.create({
      amount: p.amount,
      currency: p.currency,
      source: p.source,
      description: `revenue-metrics seed: ${p.label}`,
    });

    if (p.refund === 'full') {
      await stripe.refunds.create({ charge: charge.id });
    } else if (p.refund === 'partial') {
      await stripe.refunds.create({ charge: charge.id, amount: Math.floor(p.amount * 0.25) });
    }

    created += 1;
    console.log(`✓ ${charge.id}  ${p.amount} ${p.currency}  ${p.label}`);
  } catch (err) {
    // A declined card raises rather than returning a failed charge — that is the
    // intended outcome for the tok_chargeDeclined row, not a script failure.
    const message = err instanceof Error ? err.message : String(err);
    if (p.source === 'tok_chargeDeclined') {
      declined += 1;
      console.log(`✓ declined as intended  ${p.amount} ${p.currency}  (${message})`);
    } else {
      console.error(`✗ ${p.label}: ${message}`);
      process.exitCode = 1;
    }
  }
}

console.log(
  `\n${created} charges created, ${declined} declined as intended.\n` +
    'Now run: curl -X POST "$BASE_URL/sync?source=stripe"',
);
