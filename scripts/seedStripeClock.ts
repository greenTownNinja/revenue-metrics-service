/**
 * Generates genuinely BACKDATED Stripe charges using Test Clocks, so
 * /revenue/daily has real Stripe data spread across weeks rather than a single
 * spike on today.
 *
 *   npm run seed:stripe:clock                 # ~17 weeks back
 *   npm run seed:stripe:clock -- --weeks 12
 *   npm run seed:stripe:clock -- --cleanup    # delete clocks + their objects
 *
 * WHY THIS SHAPE. `charges.create` cannot backdate `created`. A test clock can:
 * objects generated while the clock advances are stamped with the simulated time.
 * Stripe's documented limits then dictate the design
 * (https://docs.stripe.com/billing/testing/test-clocks/api-advanced-usage):
 *
 *   - Max 2 billing cycles per advance → weekly prices advance 2 weeks at a time.
 *   - 20 invoices per subscription per day → a weekly price over ~17 weeks is 17
 *     invoices per subscription, safely under it. Daily billing would blow it.
 *   - 3 customers per clock, 3 subscriptions each → 9 subscriptions, so one
 *     currency per customer and ~150 charges total.
 *   - Clocks auto-delete after 30 days; --cleanup removes them sooner.
 *
 * MEASURED RESULT — read this before spending three minutes on it.
 *
 * Test clocks backdate INVOICES but NOT CHARGES. Verified on 2026-07-30 against a
 * real sandbox: a 17-week run produced 54 invoices per customer spread across 18
 * days (2026-04-01 → 2026-07-29), while every resulting charge was stamped with
 * real wall-clock time (2026-07-30). The clock advances the billing simulation;
 * the charge object is created when the request actually executes.
 *
 * Since StripeAdapter reads charges, this does NOT give the day-by-day view real
 * Stripe data. Use `npm run generate:ledger` for a multi-day breakdown.
 *
 * The script is kept because the finding is worth being able to reproduce, and
 * because `--cleanup` is genuinely useful. Its verification step now reports
 * invoices and charges separately so the distinction is visible rather than
 * inferred.
 */

import 'dotenv/config';
import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key?.startsWith('sk_test_') && !key?.startsWith('rk_test_')) {
  console.error('Refusing to run: STRIPE_SECRET_KEY must be a TEST-mode key (sk_test_…).');
  process.exit(1);
}

const stripe = new Stripe(key, { maxNetworkRetries: 3, timeout: 60_000 });

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const CLEANUP = process.argv.includes('--cleanup');
const WEEKS = Math.max(2, Math.min(17, Number(arg('weeks', '17'))));

const WEEK = 7 * 86_400;
const DAY = 86_400;

/** One customer per currency — Stripe pins a customer's currency at first invoice. */
const CUSTOMERS = [
  { label: 'acme-usd', currency: 'usd', token: 'tok_visa', amounts: [4_900, 12_900, 29_900] },
  { label: 'globex-eur', currency: 'eur', token: 'tok_visa', amounts: [3_900, 9_900, 24_900] },
  // Fails at payment time, producing real FAILED charges dated across the range —
  // the allow-list needs something to exclude that is not synthetic.
  { label: 'initech-gbp', currency: 'gbp', token: 'tok_chargeCustomerFail', amounts: [5_900, 15_900] },
];

async function cleanup(): Promise<void> {
  const clocks = await stripe.testHelpers.testClocks.list({ limit: 100 });
  const ours = clocks.data.filter((c) => (c.name ?? '').startsWith('revenue-metrics'));
  if (ours.length === 0) {
    console.log('No revenue-metrics test clocks to clean up.');
    return;
  }
  for (const clock of ours) {
    await stripe.testHelpers.testClocks.del(clock.id);
    console.log(`  deleted ${clock.id} (${clock.name})`);
  }
  console.log(`\nDeleted ${ours.length} clock(s) and every object attached to them.`);
}

/** Polls until the clock finishes advancing. Advancing is asynchronous. */
async function waitReady(clockId: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (clock.status === 'ready') return;
    if (clock.status === 'internal_failure') {
      throw new Error(`test clock ${clockId} failed internally`);
    }
    if (Date.now() > deadline) {
      throw new Error(`test clock ${clockId} still ${clock.status} after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function seed(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  // Start a whole number of weeks back, one day early so the first invoice lands
  // inside the range rather than exactly on its edge.
  const start = now - WEEKS * WEEK - DAY;

  console.log(
    `Creating test clock at ${new Date(start * 1000).toISOString().slice(0, 10)} ` +
      `and advancing ${WEEKS} weeks to today.\n`,
  );

  const clock = await stripe.testHelpers.testClocks.create({
    frozen_time: start,
    name: `revenue-metrics ${new Date().toISOString().slice(0, 10)}`,
  });
  console.log(`  clock: ${clock.id}`);

  const product = await stripe.products.create({ name: 'Revenue Metrics Demo Plan' });

  let subscriptions = 0;
  for (const spec of CUSTOMERS) {
    // The PaymentMethod must exist before the customer, so it can be set as the
    // default at creation time — a test-clock customer with no default payment
    // method produces unpaid invoices instead of charges.
    const pm = await stripe.paymentMethods.create({
      type: 'card',
      card: { token: spec.token } as Stripe.PaymentMethodCreateParams.Card,
    });

    const customer = await stripe.customers.create({
      email: `${spec.label}@example.com`,
      test_clock: clock.id,
      payment_method: pm.id,
      invoice_settings: { default_payment_method: pm.id },
      metadata: { seed: 'revenue-metrics' },
    });

    for (const amount of spec.amounts) {
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: amount,
        currency: spec.currency,
        // Weekly, so ~17 invoices per subscription stays under the documented
        // 20-invoices-per-subscription-per-day rate limit.
        recurring: { interval: 'week' },
      });
      await stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: price.id }],
      });
      subscriptions += 1;
    }
    console.log(`  customer: ${customer.id}  ${spec.label}  (${spec.amounts.length} subs)`);
  }

  console.log(`\n  ${subscriptions} subscriptions created. Advancing…`);

  // Two billing cycles per advance is the documented maximum; for a weekly price
  // that is two weeks.
  let at = start;
  let step = 0;
  const totalSteps = Math.ceil((now - start) / (2 * WEEK));
  while (at < now) {
    at = Math.min(at + 2 * WEEK, now);
    step += 1;
    await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: at });
    await waitReady(clock.id);
    process.stdout.write(
      `\r  advanced ${step}/${totalSteps} → ${new Date(at * 1000).toISOString().slice(0, 10)}   `,
    );
  }
  console.log('\n');

  await verify(clock.id, start, now);
}

/**
 * Reports invoice dates and charge dates SEPARATELY, because that is where the
 * distinction lives.
 *
 * The charge query deliberately excludes the last two days: charges.list returns
 * newest-first, so without a `created[lte]` bound the first page is entirely
 * today's charges and a backdated tail on later pages would be invisible. That
 * exact mistake produced a false negative the first time this ran.
 */
async function verify(clockId: string, start: number, now: number): Promise<void> {
  const spread = (times: number[]) => {
    const days = new Set(times.map((t) => new Date(t * 1000).toISOString().slice(0, 10)));
    const sorted = [...days].sort();
    return { count: days.size, first: sorted[0], last: sorted[sorted.length - 1] };
  };

  // Invoices, per customer — the customers list needs the explicit clock filter.
  const customers = await stripe.customers.list({ test_clock: clockId, limit: 10 });
  const invoiceTimes: number[] = [];
  for (const c of customers.data) {
    const invoices = await stripe.invoices.list({ customer: c.id, limit: 100 });
    invoiceTimes.push(...invoices.data.map((i) => i.created));
  }
  const inv = spread(invoiceTimes);

  // Charges, excluding the last two days so a backdated tail cannot hide behind
  // today's volume on page one.
  const older = await stripe.charges.list({
    limit: 100,
    created: { gte: start - DAY, lte: now - 2 * DAY },
  });
  const ch = spread(older.data.map((c) => c.created));

  console.log('Verification:');
  console.log(
    `  invoices : ${invoiceTimes.length} across ${inv.count} day(s)` +
      (inv.count ? `  ${inv.first} → ${inv.last}` : ''),
  );
  console.log(
    `  charges  : ${older.data.length} in the backdated window` +
      (ch.count ? ` across ${ch.count} day(s)  ${ch.first} → ${ch.last}` : ' (none)'),
  );

  if (older.data.length === 0) {
    console.log(
      '\n  Confirmed: the clock backdated the INVOICES but not the CHARGES.\n' +
        '  Charge objects are stamped when the request executes, not at simulated\n' +
        '  time, so StripeAdapter — which reads charges — sees nothing backdated.\n' +
        '\n' +
        '  For a multi-day breakdown use:  npm run generate:ledger\n' +
        '  To remove these objects:        npm run seed:stripe:clock -- --cleanup',
    );
    return;
  }

  console.log('\nNext:');
  console.log('  curl -X POST "http://localhost:3000/sync?source=stripe"');
  console.log(`  curl "http://localhost:3000/revenue/daily?from=${ch.first}&to=${ch.last}"`);
}

try {
  if (CLEANUP) await cleanup();
  else await seed();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\nFailed: ${message}`);
  console.error('\nIf this is a limits or permissions error, `npm run generate:ledger` needs none.');
  process.exitCode = 1;
}
