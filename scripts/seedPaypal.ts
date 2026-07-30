/**
 * Creates sandbox transactions in PayPal, and diagnoses the two things that
 * actually go wrong when they do.
 *
 *   npm run seed:paypal -- --check      # verify credentials, scope, and what
 *                                       # Transaction Search can currently see
 *   npm run seed:paypal -- --count 40   # create orders and capture them
 *
 * TWO THINGS TO KNOW BEFORE YOU START.
 *
 * 1. Transaction Search lags. PayPal documents "a maximum of three hours for
 *    executed transactions to appear in the list transactions call"
 *    (https://developer.paypal.com/docs/api/transaction-search/v1/). An empty
 *    sync right after seeding is expected, not a bug. Seed first, do something
 *    else, sync later. `--check` tells you when the data has landed.
 *
 * 2. Creating orders server-side needs "Advanced Credit and Debit Card Payments"
 *    on the sandbox app. Without it, card payment sources are rejected and the
 *    only route is the browser approval flow — this script detects that and
 *    prints the fallback rather than failing obscurely.
 */

import 'dotenv/config';

const SANDBOX = 'https://api-m.sandbox.paypal.com';
const REPORTING_SCOPE = 'https://uri.paypal.com/services/reporting/search/read';

const id = process.env.PAYPAL_CLIENT_ID;
const secret = process.env.PAYPAL_CLIENT_SECRET;
if (!id || !secret) {
  console.error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must both be set in .env');
  process.exit(1);
}
if (process.env.PAYPAL_ENV === 'live') {
  console.error('Refusing to run against live PayPal. Unset PAYPAL_ENV or set it to sandbox.');
  process.exit(1);
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const CHECK_ONLY = process.argv.includes('--check');
const COUNT = Math.max(1, Number(arg('count', '40')));
/** Sandbox Visa. Generate others in the Developer Dashboard → credit card generator. */
const CARD = arg('card', '4111111111111111')!;

interface TokenResponse {
  access_token: string;
  scope?: string;
  expires_in?: number;
}

async function getToken(): Promise<TokenResponse> {
  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetch(`${SANDBOX}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (res.status === 401) {
    console.error('\n✗ PayPal rejected the credentials (401).');
    console.error('  Check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are the SANDBOX pair');
    console.error('  from developer.paypal.com → Apps & Credentials → Sandbox.');
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`\n✗ Token endpoint returned ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  return (await res.json()) as TokenResponse;
}

/**
 * The token response lists granted scopes, so a missing Transaction Search
 * permission is detectable up front rather than as a 403 hours later.
 */
function reportScope(token: TokenResponse): boolean {
  const scopes = (token.scope ?? '').split(/\s+/).filter(Boolean);
  const hasReporting = scopes.includes(REPORTING_SCOPE);

  console.log(`  credentials      : ✓ accepted`);
  console.log(`  granted scopes   : ${scopes.length}`);
  console.log(`  transaction search: ${hasReporting ? '✓ granted' : '✗ MISSING'}`);

  if (!hasReporting) {
    console.log(
      '\n  ⚠️  Your app cannot read Transaction Search, so /sync?source=paypal will 502.\n' +
        '     Fix: developer.paypal.com → Apps & Credentials → Sandbox → your app →\n' +
        '     Features → enable "Transaction search", then Save. The change applies to\n' +
        '     the existing credentials; no need to regenerate them.',
    );
  }
  return hasReporting;
}

/** Shows what Transaction Search currently returns, so the lag is visible. */
async function checkVisibility(token: string): Promise<void> {
  const end = new Date();
  const start = new Date(end.getTime() - 31 * 86_400_000);
  const query = new URLSearchParams({
    start_date: start.toISOString(),
    end_date: end.toISOString(),
    fields: 'transaction_info',
    page_size: '100',
    page: '1',
  });

  const res = await fetch(`${SANDBOX}/v1/reporting/transactions?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    console.log(`\n  Transaction Search returned ${res.status}:`);
    console.log(`  ${(await res.text()).slice(0, 400)}`);
    return;
  }

  const body = (await res.json()) as {
    transaction_details?: { transaction_info?: Record<string, unknown> }[];
    total_pages?: number;
  };
  const details = body.transaction_details ?? [];

  const byStatus = new Map<string, number>();
  const days = new Set<string>();
  for (const d of details) {
    const info = d.transaction_info ?? {};
    const status = String(info.transaction_status ?? '?');
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    const at = String(info.transaction_initiation_date ?? '');
    if (at) days.add(at.slice(0, 10));
  }

  console.log(`\n  Last 31 days, as Transaction Search sees it right now:`);
  console.log(`    transactions : ${details.length}${(body.total_pages ?? 1) > 1 ? '+ (more pages)' : ''}`);
  console.log(`    distinct days: ${days.size}`);
  console.log(
    `    by status    : ${[...byStatus].map(([s, n]) => `${s}=${n}`).join(', ') || '— none yet'}`,
  );

  if (details.length === 0) {
    console.log(
      '\n  Nothing visible yet. If you seeded recently this is the documented\n' +
        '  three-hour reporting delay, not a failure. Re-run --check later.',
    );
  }
}

interface Spec {
  label: string;
  weight: number;
  currency: string;
  min: number;
  max: number;
}

const SPECS: Spec[] = [
  { label: 'usd', weight: 60, currency: 'USD', min: 500, max: 250_000 },
  { label: 'eur', weight: 25, currency: 'EUR', min: 500, max: 120_000 },
  { label: 'gbp', weight: 15, currency: 'GBP', min: 500, max: 120_000 },
];

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(Number(process.env.SEED_RANDOM ?? 20260730));

/** Minor units → the decimal string PayPal wants. Done on integers, not floats. */
function toDecimal(minor: number, currency: string): string {
  const exponent = ['JPY', 'HUF', 'TWD'].includes(currency) ? 0 : 2;
  if (exponent === 0) return String(minor);
  const s = String(minor).padStart(exponent + 1, '0');
  return `${s.slice(0, -exponent)}.${s.slice(-exponent)}`;
}

async function createAndCapture(
  token: string,
  spec: Spec,
  amountMinor: number,
  index: number,
): Promise<'ok' | 'no-acdc' | 'failed'> {
  const value = toDecimal(amountMinor, spec.currency);

  const createRes = await fetch(`${SANDBOX}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      // Idempotency, so a retry cannot double-charge.
      'PayPal-Request-Id': `revmetrics-${process.env.SEED_RANDOM ?? '1'}-${index}`,
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: { currency_code: spec.currency, value },
          description: 'revenue-metrics seed',
        },
      ],
      payment_source: {
        card: { number: CARD, expiry: '2030-01', name: 'Test Buyer' },
      },
    }),
  });

  const body = (await createRes.json().catch(() => ({}))) as {
    id?: string;
    status?: string;
    name?: string;
    details?: { issue?: string; description?: string }[];
    message?: string;
  };

  if (!createRes.ok) {
    const issue = body.details?.[0]?.issue ?? body.name ?? '';
    // The signature of a sandbox app without Advanced Credit and Debit Card
    // Payments enabled. Worth naming, because the raw error does not say so.
    if (
      /PAYMENT_SOURCE_CANNOT_BE_USED|UNPROCESSABLE|NOT_ENABLED|PERMISSION_DENIED/i.test(
        issue + (body.message ?? ''),
      )
    ) {
      return 'no-acdc';
    }
    if (index === 0) {
      console.error(`\n  first order failed (${createRes.status}): ${JSON.stringify(body).slice(0, 300)}`);
    }
    return 'failed';
  }

  if (body.status === 'COMPLETED') return 'ok';

  const orderId = body.id;
  if (!orderId) return 'failed';

  const capRes = await fetch(`${SANDBOX}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': `revmetrics-cap-${process.env.SEED_RANDOM ?? '1'}-${index}`,
    },
  });
  return capRes.ok ? 'ok' : 'failed';
}

function printApprovalFallback(): void {
  console.log(
    '\n  ⚠️  This sandbox app cannot take card payments server-side.\n' +
      '     "Advanced Credit and Debit Card Payments" is not enabled on it.\n' +
      '\n' +
      '     Two ways forward:\n' +
      '\n' +
      '     a) Enable it: Developer Dashboard → Apps & Credentials → Sandbox →\n' +
      '        your app → Features → "Advanced Credit and Debit Card Payments".\n' +
      '        Not available on every sandbox account. Re-run this script after.\n' +
      '\n' +
      '     b) Use the buyer-approval flow instead: create an order without a\n' +
      '        payment_source, open its `approve` link in a browser, log in with a\n' +
      '        sandbox PERSONAL account (Testing Tools → Sandbox Accounts), approve,\n' +
      '        then capture. Reliable, but manual per transaction.\n' +
      '\n' +
      '     Either way, PayPal remains the least controllable of the three sources.\n' +
      '     `npm run generate:ledger` gives multi-day data with none of this.',
  );
}

// ── main ──────────────────────────────────────────────────────────────────────

console.log('PayPal sandbox\n');
const token = await getToken();
const hasReporting = reportScope(token);

if (CHECK_ONLY) {
  if (hasReporting) await checkVisibility(token.access_token);
  process.exit(0);
}

const totalWeight = SPECS.reduce((a, s) => a + s.weight, 0);
function pickSpec(): Spec {
  let roll = rand() * totalWeight;
  for (const s of SPECS) {
    roll -= s.weight;
    if (roll <= 0) return s;
  }
  return SPECS[0]!;
}

console.log(`\nCreating ${COUNT} orders…`);

let ok = 0;
let failed = 0;
const byCurrency = new Map<string, number>();

for (let i = 0; i < COUNT; i += 1) {
  const spec = pickSpec();
  const amount = spec.min + Math.floor(rand() * (spec.max - spec.min + 1));
  const result = await createAndCapture(token.access_token, spec, amount, i);

  if (result === 'no-acdc') {
    printApprovalFallback();
    process.exit(1);
  }
  if (result === 'ok') {
    ok += 1;
    byCurrency.set(spec.currency, (byCurrency.get(spec.currency) ?? 0) + 1);
  } else {
    failed += 1;
  }

  if ((i + 1) % 5 === 0 || i + 1 === COUNT) {
    process.stdout.write(`\r  ${i + 1}/${COUNT} …`);
  }
}

console.log('\n');
for (const [currency, n] of [...byCurrency.entries()].sort()) {
  console.log(`  ${String(n).padStart(4)}  ${currency}`);
}
console.log(`\n${ok} captured${failed > 0 ? `, ${failed} failed` : ''}.`);
console.log(
  '\nTransaction Search takes up to 3 HOURS to surface these.\n' +
    'Check with:  npm run seed:paypal -- --check\n' +
    'Then sync:   curl -X POST "http://localhost:3000/sync?source=paypal"',
);

if (failed > 0) process.exitCode = 1;
