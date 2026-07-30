/**
 * Process bootstrap: build dependencies, run migrations, listen.
 */

// MUST be the first import: logger.ts reads LOG_LEVEL at module load, so .env has
// to be in process.env before anything else is evaluated. dotenv does not
// override variables that are already set, so Render's dashboard values still win
// in production (where there is no .env file at all).
import 'dotenv/config';

import { createApp } from './app.js';
import { createExecutor, closePool, getPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { SyncService } from './sync/SyncService.js';
import { StripeAdapter } from './sources/stripe/StripeAdapter.js';
import { PayPalAdapter } from './sources/paypal/PayPalAdapter.js';
import { LedgerCsvAdapter } from './sources/ledgerCsv/LedgerCsvAdapter.js';
import type { SourceAdapter } from './sources/SourceAdapter.js';
import { logger } from './logger.js';

/** Registers an adapter if its credentials are present; logs why if not. */
function register(into: SourceAdapter[], name: string, build: () => SourceAdapter): void {
  try {
    into.push(build());
    logger.info({ source: name }, 'source registered');
  } catch (err) {
    logger.warn(
      { source: name, reason: err instanceof Error ? err.message : String(err) },
      `source NOT registered; /sync?source=${name} will 400`,
    );
  }
}

async function main(): Promise<void> {
  const db = createExecutor(getPool());

  // Migrations are idempotent (CREATE ... IF NOT EXISTS), so running them at
  // boot keeps a Render free-tier deploy to a single step.
  await runMigrations(db);

  const adapters: SourceAdapter[] = [];

  // Every source is optional at boot. Missing credentials for one provider must
  // not stop the service from serving revenue for the others, or for data that is
  // already synced — a metrics API that refuses to answer because an upstream is
  // misconfigured is worse than one that answers from what it has.
  register(adapters, 'stripe', () => StripeAdapter.fromEnv());
  register(adapters, 'paypal', () => PayPalAdapter.fromEnv());

  // The CSV ledger is a fixture, not a real source. It stays available for the
  // credential-free demo and the test suite, but is off unless asked for.
  if (process.env.ENABLE_CSV_SOURCE === 'true') {
    adapters.push(LedgerCsvAdapter.fromEnv());
    logger.info(
      { source: 'ledger-csv', path: process.env.LEDGER_CSV_PATH ?? '(bundled fixture)' },
      'fixture source registered (ENABLE_CSV_SOURCE=true)',
    );
  }

  if (adapters.length === 0) {
    logger.warn(
      'no sources registered — /sync will 400 for every source. Set STRIPE_SECRET_KEY ' +
        'and/or PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET.',
    );
  }

  const syncService = new SyncService(db, adapters);
  const app = createApp({ db, syncService });

  const port = Number(process.env.PORT ?? 3000);
  const server = app.listen(port, () => {
    logger.info({ port, sources: syncService.sourceNames }, 'revenue-metrics listening');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      closePool()
        .catch((err) => logger.error({ err }, 'error closing pool'))
        .finally(() => process.exit(0));
    });
    // Render sends SIGTERM and waits; do not hang forever on a stuck socket.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // An unexpected rejection should be loud in the log, not a silent process exit.
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled rejection');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
