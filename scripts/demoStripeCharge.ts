/**
 * Creates a SMALL, FIXED set of Stripe charges for a live demo, then tells you
 * exactly how much the revenue number should move.
 *
 *   npm run demo:charge                      # create, print expected delta + curls
 *   npm run demo:charge -- --count 3         # fewer
 *   npm run demo:charge -- --verify          # create, sync, and prove the delta
 *   npm run demo:charge -- --base https://revenue-metrics-service-r5p3.onrender.com --verify
 *
 * WHY THIS EXISTS SEPARATELY FROM seedStripe.ts. That script generates a random
 * weighted mix — good for bulk, useless on camera, because you cannot state in
 * advance what the total will become. Here every amount is a fixed round number,
 * so the expected delta is computed up front and printed BEFORE anything is
 * created. Then you either read it out and let the viewer check, or pass
 * --verify and let the script check it for you.
 *
 * The plan deliberately includes charges that must NOT count. A demo where every
 * new charge is collected proves the sum works; it does not prove the allow-list
 * does anything.
 */

import 'dotenv/config';
import Stripe from 'stripe';
import {
  createDemoCharges,
  DEMO_CHARGE_PLAN,
  MAX_DEMO_CHARGES,
} from '../src/sources/stripe/StripeDemoCharges.js';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('STRIPE_SECRET_KEY is not set');
  process.exit(1);
}
if (!key.startsWith('sk_test_') && !key.startsWith('rk_test_')) {
  console.error('Refusing to run: STRIPE_SECRET_KEY must be a TEST-mode key (sk_test_…).');
  process.exit(1);
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const VERIFY = process.argv.includes('--verify');
const BASE = (arg('base', 'http://localhost:3000') as string).replace(/\/$/, '');

const stripe = new Stripe(key, { maxNetworkRetries: 3, timeout: 30_000 });

const COUNT = Math.max(
  1,
  Math.min(MAX_DEMO_CHARGES, Number(arg('count', String(MAX_DEMO_CHARGES)))),
);
const plan = DEMO_CHARGE_PLAN.slice(0, COUNT);

/** UTC day these charges will land in — Stripe stamps `created` server-side. */
const today = new Date().toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

function money(minor: bigint | number, currency: string): string {
  const n = BigInt(minor);
  const zeroDecimal = ['jpy', 'huf', 'twd'].includes(currency);
  if (zeroDecimal) return `${n} ${currency.toUpperCase()}`;
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')} ${currency.toUpperCase()}`;
}

/** What the collected total SHOULD move by, per currency. */
const expected = new Map<string, bigint>();
for (const c of plan.filter((c) => c.countsTowardRevenue)) {
  expected.set(c.currency, (expected.get(c.currency) ?? 0n) + BigInt(c.amountMinor));
}

function printPlan(): void {
  console.log(`\nCreating ${plan.length} charge(s) in Stripe test mode.\n`);
  for (const c of plan) {
    const mark = c.countsTowardRevenue ? '  COUNTS  ' : '  EXCLUDED';
    console.log(`  ${mark}  ${money(c.amountMinor, c.currency).padStart(14)}   ${c.note}`);
  }
  console.log('\nExpected change to collected revenue:');
  for (const [currency, delta] of [...expected].sort()) {
    console.log(`    ${currency}  +${money(delta, currency)}`);
  }
  let excluded = 0n;
  for (const c of plan.filter((c) => !c.countsTowardRevenue)) excluded += BigInt(c.amountMinor);
  console.log(`    (${money(excluded, 'usd')} created but deliberately not counted)\n`);
}

interface CurrencyTotal {
  currency: string;
  amountMinor: string;
  transactionCount: number;
}

async function summary(): Promise<Map<string, bigint>> {
  const url = `${BASE}/revenue/summary?from=${today}&to=${tomorrow}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { totals: CurrencyTotal[] };
  return new Map(body.totals.map((t) => [t.currency, BigInt(t.amountMinor)]));
}

/** Creation itself lives in src/, shared with POST /demo/stripe-charge. */
async function create(): Promise<void> {
  for (const c of await createDemoCharges(stripe, COUNT)) {
    const id = c.id ?? 'declined as intended';
    console.log(`  ✓ ${id}  ${money(c.amountMinor, c.currency)}  ${c.label}`);
  }
}

async function sync(): Promise<void> {
  const url = `${BASE}/sync?source=stripe`;
  const res = await fetch(url, { method: 'POST' });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`POST ${url} → ${res.status} ${JSON.stringify(body)}`);
  console.log(
    `  fetched=${body.fetched} upserted=${body.upserted} ` +
      `quarantined=${body.quarantined} durationMs=${body.durationMs}`,
  );
}

function printCurls(): void {
  console.log('\nNow run, in this order:\n');
  console.log(`  curl -X POST "${BASE}/sync?source=stripe"`);
  console.log(`  curl -s "${BASE}/revenue/summary?from=${today}&to=${tomorrow}" | jq`);
  console.log(`  curl -s "${BASE}/revenue/daily?from=${today}&to=${tomorrow}" | jq`);
  console.log(
    `\nBoth views cover the UTC day ${today}, and the daily rows sum to the summary\n` +
      'totals exactly — same allow-list, same range, one shared clause factory.',
  );
  console.log(
    '\nNote: the bucket is the UTC day, which is not always your local one. Stripe\n' +
      'stamps `created` server-side, so late-evening charges land in tomorrow.',
  );
}

printPlan();
await create();

if (!VERIFY) {
  printCurls();
} else {
  console.log(`\nVerifying against ${BASE}`);

  // Read AFTER creating but BEFORE syncing: this is the pre-sync baseline, and it
  // also demonstrates that creating a charge in Stripe does not by itself change
  // the number. The number only moves when the sync runs.
  const before = await summary();
  console.log('\n  before sync:');
  for (const [currency, amount] of [...before].sort()) {
    console.log(`    ${currency}  ${money(amount, currency)}`);
  }

  console.log('\n  syncing…');
  await sync();

  const after = await summary();
  console.log('\n  after sync:');
  for (const [currency, amount] of [...after].sort()) {
    console.log(`    ${currency}  ${money(amount, currency)}`);
  }

  console.log('\n  delta vs expected:');
  let ok = true;
  for (const [currency, want] of [...expected].sort()) {
    const got = (after.get(currency) ?? 0n) - (before.get(currency) ?? 0n);
    const match = got === want;
    ok &&= match;
    console.log(
      `    ${currency}  expected +${money(want, currency)}  ` +
        `got +${money(got, currency)}  ${match ? 'MATCH' : 'MISMATCH'}`,
    );
  }

  // Any currency that moved without being predicted means something else wrote to
  // the database during the demo — worth failing on rather than glossing over.
  for (const [currency, amount] of after) {
    if (!expected.has(currency) && amount !== (before.get(currency) ?? 0n)) {
      ok = false;
      console.log(`    ${currency}  UNEXPECTED movement — was this the only writer?`);
    }
  }

  console.log(ok ? '\n  ✓ the number moved by exactly the predicted amount.' : '\n  ✗ mismatch.');
  if (!ok) process.exitCode = 1;

  printCurls();
}
