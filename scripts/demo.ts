/**
 * Runs the whole service locally with NO credentials — no Supabase project, no
 * Stripe key. Backed by PGlite (Postgres compiled to WASM) and the CSV source.
 *
 * `npm run demo`
 *
 * Useful for reviewing this repo without setting anything up, and it drives the
 * demo-video walkthrough: sync, both views agreeing, and the edge cases.
 */

import 'dotenv/config';

import { createApp } from '../src/app.js';
import { createTestDb } from '../tests/helpers/testDb.js';
import { SyncService } from '../src/sync/SyncService.js';
import { LedgerCsvAdapter } from '../src/sources/ledgerCsv/LedgerCsvAdapter.js';
import { StripeAdapter } from '../src/sources/stripe/StripeAdapter.js';
import type { SourceAdapter } from '../src/sources/SourceAdapter.js';

const PORT = Number(process.env.DEMO_PORT ?? 4599);
const RANGE = 'from=2026-07-01&to=2026-08-01';

const db = await createTestDb();

const adapters: SourceAdapter[] = [new LedgerCsvAdapter()];
if (process.env.STRIPE_SECRET_KEY) {
  try {
    adapters.push(StripeAdapter.fromEnv());
  } catch (err) {
    console.log(`(stripe not registered: ${err instanceof Error ? err.message : String(err)})`);
  }
}

const app = createApp({ db, syncService: new SyncService(db, adapters) });
const server = app.listen(PORT);
const base = `http://127.0.0.1:${PORT}`;

async function call(label: string, path: string, method: 'GET' | 'POST' = 'GET'): Promise<any> {
  const res = await fetch(base + path, { method });
  const body = await res.json();
  console.log(`\n\x1b[1m── ${label}\x1b[0m  \x1b[2m[${res.status}] ${method} ${path}\x1b[0m`);
  console.log(JSON.stringify(body, null, 2));
  return body;
}

try {
  console.log(`\nRevenue Metrics Service — local demo on ${base}`);
  console.log(`Sources: ${adapters.map((a) => a.name).join(', ')}`);

  const first = await call('1. Sync', '/sync?source=ledger-csv', 'POST');
  const second = await call('2. Sync again — idempotent', '/sync?source=ledger-csv', 'POST');

  const summary = await call('3. Summary total', `/revenue/summary?${RANGE}`);
  const daily = await call('4. Day-by-day breakdown', `/revenue/daily?${RANGE}`);

  // Fold the wire format exactly as a client would: BigInt over the strings.
  console.log('\n\x1b[1m── 5. Do the two views agree?\x1b[0m');
  const folded = new Map<string, bigint>();
  for (const d of daily.days) {
    folded.set(d.currency, (folded.get(d.currency) ?? 0n) + BigInt(d.amountMinor));
  }
  let allAgree = true;
  for (const t of summary.totals) {
    const sum = folded.get(t.currency) ?? 0n;
    const agree = sum === BigInt(t.amountMinor);
    allAgree = allAgree && agree;
    console.log(
      `   ${agree ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${t.currency}: ` +
        `summary=${t.amountMinor}  sum(daily)=${sum}`,
    );
  }
  console.log(
    allAgree
      ? '   \x1b[32mBoth views agree exactly.\x1b[0m'
      : '   \x1b[31mVIEWS DISAGREE — this should be impossible.\x1b[0m',
  );

  await call('6. Edge case: statuses no adapter recognises', `/revenue/unmapped?${RANGE}`);

  console.log(
    "\n   'disputed' contributed 0 to revenue and is reported above.\n" +
      "   An exclusion list (status != 'failed') would have counted it as revenue.",
  );

  console.log('\n\x1b[1m── 7. Edge case: quarantined record\x1b[0m');
  const { rows } = await db.query<{ external_id: string; reason: string }>(
    'SELECT external_id, reason FROM quarantined_transactions',
  );
  console.log(JSON.stringify(rows, null, 2));
  console.log('   The sync still succeeded — one bad row does not abort it.');

  await call('8. Edge case: inverted range', '/revenue/summary?from=2026-08-01&to=2026-07-01');
  await call('9. Edge case: unknown source', '/sync?source=paypal', 'POST');

  console.log('\n\x1b[1m── Summary\x1b[0m');
  console.log(`   fetched:      ${first.fetched}`);
  console.log(`   upserted:     ${first.upserted}  (re-sync: ${second.upserted}, no duplicates)`);
  console.log(`   quarantined:  ${first.quarantined}`);
  console.log(`   unmapped:     ${JSON.stringify(first.unknownStatuses)}`);
  console.log(`   views agree:  ${allAgree}\n`);
} finally {
  server.close();
  await db.close();
}
