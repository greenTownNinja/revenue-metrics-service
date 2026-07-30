/**
 * Process bootstrap: build dependencies, run migrations, listen.
 */

import { createApp } from './app.js';
import { createExecutor, closePool, getPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { SyncService } from './sync/SyncService.js';
import { StripeAdapter } from './sources/stripe/StripeAdapter.js';
import { LedgerCsvAdapter } from './sources/ledgerCsv/LedgerCsvAdapter.js';
import type { SourceAdapter } from './sources/SourceAdapter.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  const db = createExecutor(getPool());

  // Migrations are idempotent (CREATE ... IF NOT EXISTS), so running them at
  // boot keeps a Render free-tier deploy to a single step.
  await runMigrations(db);

  const adapters: SourceAdapter[] = [new LedgerCsvAdapter()];

  // Stripe is optional at boot: a missing key must not stop the service from
  // serving revenue for sources that are already synced.
  try {
    adapters.push(StripeAdapter.fromEnv());
    logger.info('stripe adapter registered');
  } catch (err) {
    logger.warn(
      { reason: err instanceof Error ? err.message : String(err) },
      'stripe adapter NOT registered; /sync?source=stripe will 400',
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
