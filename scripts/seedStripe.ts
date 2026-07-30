/**
 * Creates sample charges in a Stripe TEST-mode account, so the allow-list has
 * something real to include and exclude.
 *
 *   npm run seed:stripe              # 60 charges
 *   npm run seed:stripe -- 250       # or however many
 *   SEED_COUNT=250 npm run seed:stripe
 *
 * A NOTE ON DATES: Stripe sets `created` server-side and it cannot be backdated,
 * so every charge here lands on today. `/revenue/daily` will therefore show a
 * single day for Stripe no matter how many you seed. For a multi-day breakdown
 * in a demo, enable the CSV fixture source (ENABLE_CSV_SOURCE=true), whose rows
 * are spread across a month by design.
 *
 * Uses Stripe's test tokens, which produce each outcome deterministically:
 *   tok_visa            → succeeded
 *   tok_chargeDeclined  → the charge attempt fails (raises, as intended)
 */

import 'dotenv/config';
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

const COUNT = Math.max(1, Number(process.argv[2] ?? process.env.SEED_COUNT ?? 60));
/** Stripe test mode rate-limits around 25 req/s; stay well under it. */
const CONCURRENCY = 4;

const stripe = new Stripe(key, { maxNetworkRetries: 3, timeout: 30_000 });

interface Template {
  label: string;
  /** Relative frequency in the generated mix. */
  weight: number;
  currency: string;
  token: string;
  refund?: 'full' | 'partial';
  /** Inclusive amount range in minor units. */
  min: number;
  max: number;
}

/**
 * A realistic-ish mix. Most money is collected; a meaningful slice is not, so the
 * allow-list demonstrably excludes something rather than being a no-op.
 */
const TEMPLATES: Template[] = [
  { label: 'collected usd', weight: 50, currency: 'usd', token: 'tok_visa', min: 500, max: 250_000 },
  { label: 'collected eur', weight: 12, currency: 'eur', token: 'tok_visa', min: 500, max: 90_000 },
  { label: 'collected gbp', weight: 8, currency: 'gbp', token: 'tok_visa', min: 500, max: 90_000 },
  { label: 'declined', weight: 12, currency: 'usd', token: 'tok_chargeDeclined', min: 1_000, max: 120_000 },
  { label: 'fully refunded', weight: 10, currency: 'usd', token: 'tok_visa', refund: 'full', min: 1_000, max: 150_000 },
  { label: 'partially refunded', weight: 8, currency: 'usd', token: 'tok_visa', refund: 'partial', min: 4_000, max: 200_000 },
];

/** Deterministic PRNG, so a seeded account is reproducible from SEED_RANDOM. */
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(Number(process.env.SEED_RANDOM ?? 20260730));

const totalWeight = TEMPLATES.reduce((a, t) => a + t.weight, 0);
function pickTemplate(): Template {
  let roll = rand() * totalWeight;
  for (const t of TEMPLATES) {
    roll -= t.weight;
    if (roll <= 0) return t;
  }
  return TEMPLATES[0]!;
}

const plan = Array.from({ length: COUNT }, (_, i) => {
  const t = pickTemplate();
  return {
    index: i,
    template: t,
    amount: t.min + Math.floor(rand() * (t.max - t.min + 1)),
  };
});

const counts = new Map<string, number>();
let created = 0;
let declined = 0;
let failed = 0;

async function seedOne(item: (typeof plan)[number]): Promise<void> {
  const { template: t, amount } = item;
  try {
    const charge = await stripe.charges.create({
      amount,
      currency: t.currency,
      source: t.token,
      description: `revenue-metrics seed: ${t.label}`,
      metadata: { seed: 'revenue-metrics', label: t.label },
    });

    if (t.refund === 'full') {
      await stripe.refunds.create({ charge: charge.id });
    } else if (t.refund === 'partial') {
      // A quarter back, so the charge stays COLLECTED with a non-zero
      // amount_refunded — the case v1 deliberately does not net.
      await stripe.refunds.create({ charge: charge.id, amount: Math.floor(amount / 4) });
    }

    created += 1;
    counts.set(t.label, (counts.get(t.label) ?? 0) + 1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A declined card raises rather than returning a failed charge. For the
    // decline template that is the intended outcome, not a script failure.
    if (t.token === 'tok_chargeDeclined') {
      declined += 1;
      counts.set(t.label, (counts.get(t.label) ?? 0) + 1);
    } else {
      failed += 1;
      console.error(`  ✗ ${t.label} ${amount} ${t.currency}: ${message}`);
    }
  }

  const done = created + declined + failed;
  if (done % 10 === 0 || done === COUNT) {
    process.stdout.write(`\r  ${done}/${COUNT} …`);
  }
}

console.log(`Seeding ${COUNT} charges into Stripe test mode (concurrency ${CONCURRENCY})\n`);

// Fixed-size worker pool: a flat Promise.all over hundreds of charges would trip
// Stripe's rate limiter and turn deterministic seeding into a retry storm.
const queue = [...plan];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      await seedOne(item);
    }
  }),
);

console.log('\n');
for (const [label, n] of [...counts.entries()].sort()) {
  console.log(`  ${String(n).padStart(4)}  ${label}`);
}
console.log(
  `\n${created} charges created, ${declined} declined as intended` +
    (failed > 0 ? `, ${failed} FAILED unexpectedly` : '') +
    '.',
);
console.log('\nAll charges are dated today — Stripe cannot backdate `created`.');
console.log('Next: curl -X POST "http://localhost:3000/sync?source=stripe"');

if (failed > 0) process.exitCode = 1;
