/**
 * Generates a large invoice ledger CSV spanning a real date range, so the
 * day-by-day and week-by-week views have something to actually break down.
 *
 *   npm run generate:ledger                          # 1200 rows over 180 days
 *   npm run generate:ledger -- --rows 5000 --days 365
 *   npm run generate:ledger -- --from 2026-01-01 --to 2026-07-31
 *
 * Writes to data/ledger.csv and prints the LEDGER_CSV_PATH to set.
 *
 * Why this exists: neither Stripe nor PayPal will let you backdate a transaction
 * — `created` is server-side — so a seeded sandbox account produces data on one
 * day only. A file-based ledger is a legitimate source shape (plenty of real
 * integrations are SFTP drops), and it is the one place we control the clock.
 *
 * The output is deliberately imperfect: mixed status casing, a mix of currencies,
 * unmappable statuses, and a few rows that must be quarantined. Clean data proves
 * nothing.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OUT = resolve(root, arg('out', 'data/ledger.csv')!);
const ROWS = Math.max(1, Number(arg('rows', '1200')));
const SEED = Number(arg('seed', '20260730'));

/** Range: --from/--to win; otherwise the last --days ending today. */
const DAYS = Math.max(1, Number(arg('days', '180')));
const toArg = arg('to');
const fromArg = arg('from');
const END = toArg ? new Date(`${toArg}T23:59:59.999Z`) : new Date();
const START = fromArg
  ? new Date(`${fromArg}T00:00:00.000Z`)
  : new Date(END.getTime() - DAYS * 86_400_000);

if (Number.isNaN(START.getTime()) || Number.isNaN(END.getTime()) || START >= END) {
  console.error('Invalid range. Use --from YYYY-MM-DD --to YYYY-MM-DD, or --days N.');
  process.exit(1);
}

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);

/** Status spellings, including casing and padding variants the mapper must survive. */
const STATUSES: { value: string; weight: number; refundRatio?: number }[] = [
  { value: 'paid', weight: 34 },
  { value: 'PAID', weight: 6 },
  { value: '  Paid  ', weight: 3 },
  { value: 'completed', weight: 18 },
  { value: 'captured', weight: 6 },
  { value: 'processing', weight: 9 },
  { value: 'awaiting_payment', weight: 4 },
  { value: 'voided', weight: 6 },
  { value: 'failed', weight: 7 },
  { value: 'refunded', weight: 5, refundRatio: 1 },
  // Unmappable on purpose: the status the allow-list has to exclude AND report.
  { value: 'disputed', weight: 1.5 },
  { value: 'on_hold', weight: 0.5 },
];

const CURRENCIES: { code: string; weight: number; max: number }[] = [
  { code: 'USD', weight: 62, max: 400_000 },
  { code: 'EUR', weight: 20, max: 250_000 },
  { code: 'GBP', weight: 12, max: 200_000 },
  { code: 'JPY', weight: 6, max: 800_000 },
];

function pick<T extends { weight: number }>(items: T[]): T {
  const total = items.reduce((a, x) => a + x.weight, 0);
  let roll = rand() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return items[0]!;
}

const rows: string[] = ['invoice_id,status,amount_cents,refunded_cents,currency,settled_at'];
const span = END.getTime() - START.getTime();

for (let i = 0; i < ROWS; i += 1) {
  const id = `inv_${String(100_000 + i)}`;

  // Weekday-weighted so the daily breakdown has visible shape rather than noise.
  let at = new Date(START.getTime() + rand() * span);
  const day = at.getUTCDay();
  if ((day === 0 || day === 6) && rand() < 0.6) {
    at = new Date(at.getTime() - 2 * 86_400_000);
    if (at < START) at = new Date(START.getTime() + rand() * span);
  }

  const status = pick(STATUSES);
  const currency = pick(CURRENCIES);
  const amount = 500 + Math.floor(rand() * currency.max);
  const refunded = status.refundRatio ? amount : 0;

  // A few rows that must be quarantined rather than crash the sync.
  const roll = rand();
  if (roll < 0.004) {
    rows.push(`${id},paid,not_a_number,0,${currency.code},${at.toISOString()}`);
    continue;
  }
  if (roll < 0.007) {
    rows.push(`${id},paid,${amount},0,DOLLARS,${at.toISOString()}`);
    continue;
  }
  if (roll < 0.009) {
    rows.push(`${id},paid,${amount},0,${currency.code},not-a-date`);
    continue;
  }

  rows.push(
    `${id},${status.value},${amount},${refunded},${currency.code},${at.toISOString()}`,
  );
}

// One amount past Number.MAX_SAFE_INTEGER, so the BIGINT path is exercised by
// data a reviewer can see rather than only by a unit test.
rows.push(
  `inv_BIGINT,paid,9007199254740993,0,USD,${new Date(START.getTime() + span / 2).toISOString()}`,
);

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, rows.join('\n') + '\n', 'utf8');

const iso = (d: Date) => d.toISOString().slice(0, 10);
console.log(`Wrote ${rows.length - 1} rows to ${OUT}`);
console.log(`Range: ${iso(START)} → ${iso(END)}  (${Math.round(span / 86_400_000)} days)`);
console.log('\nAdd to .env:');
console.log('  ENABLE_CSV_SOURCE=true');
console.log(`  LEDGER_CSV_PATH=${OUT}`);
console.log('\nThen:');
console.log('  curl -X POST "http://localhost:3000/sync?source=ledger-csv"');
console.log(`  curl "http://localhost:3000/revenue/daily?from=${iso(START)}&to=${iso(END)}"`);
