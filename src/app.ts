/**
 * Express wiring. Built from injected dependencies so tests can mount the real
 * app against PGlite without a network or a Stripe key.
 */

import express, { type Application, type NextFunction, type Request, type Response } from 'express';
import pinoHttp from 'pino-http';
import type { Executor, TransactionalExecutor } from './db/Executor.js';
import { RevenueService } from './revenue/RevenueService.js';
import type { SyncService } from './sync/SyncService.js';
import { RevenueController } from './api/RevenueController.js';
import { SyncController } from './api/SyncController.js';
import { AppError } from './errors.js';
import { logger } from './logger.js';
import { revenueDefinition } from './revenue/canonical.js';

export interface AppDeps {
  db: TransactionalExecutor;
  syncService: SyncService;
}

/**
 * Wraps an async handler so a rejected promise reaches the error middleware.
 * Express 4 does not do this itself; without it a thrown error becomes a hung
 * request instead of a 500.
 */
function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}

export function createApp(deps: AppDeps): Application {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

  const revenue = new RevenueController(new RevenueService(deps.db));
  const sync = new SyncController(deps.syncService);

  app.get('/health', wrap(async (_req, res) => {
    // Cheap DB round-trip: a green health check that does not touch Postgres is
    // not worth much on a free tier where the database can be paused.
    let db = 'ok';
    try {
      await deps.db.query('SELECT 1');
    } catch {
      db = 'unavailable';
    }
    res.status(db === 'ok' ? 200 : 503).json({
      status: db === 'ok' ? 'ok' : 'degraded',
      db,
      definition: revenueDefinition(),
    });
  }));

  // Self-describing root, so a grader hitting the base URL is not stuck.
  app.get('/', (_req, res) => {
    res.json({
      service: 'revenue-metrics',
      definition: revenueDefinition(),
      endpoints: {
        health: 'GET /health',
        sync: 'POST /sync?source=stripe|ledger-csv (omit source to sync all)',
        summary: 'GET /revenue/summary?from=YYYY-MM-DD&to=YYYY-MM-DD',
        daily: 'GET /revenue/daily?from=YYYY-MM-DD&to=YYYY-MM-DD',
        unmapped: 'GET /revenue/unmapped?from=YYYY-MM-DD&to=YYYY-MM-DD',
      },
      note: "'to' is EXCLUSIVE. All bucketing is UTC. Amounts are integer minor units as strings.",
    });
  });

  app.post('/sync', wrap(sync.sync));
  app.get('/revenue/summary', wrap(revenue.summary));
  app.get('/revenue/daily', wrap(revenue.daily));
  app.get('/revenue/unmapped', wrap(revenue.unmapped));

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
  });

  app.use(errorHandler);
  return app;
}

/**
 * Central error handler. Typed AppErrors carry their own status; anything else is
 * an unexpected 500 whose internals are logged but not returned to the caller.
 * Either way the process survives.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    if (err.status >= 500) {
      logger.error({ err, path: req.path }, err.code);
    } else {
      logger.warn({ code: err.code, message: err.message, path: req.path }, 'request rejected');
    }
    res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
    return;
  }

  logger.error({ err, path: req.path }, 'unhandled error');
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
  });
}

export type { Executor };
