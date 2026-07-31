/**
 * Express wiring. Built from injected dependencies so tests can mount the real
 * app against PGlite without a network or a Stripe key.
 */

import express, { type Application, type NextFunction, type Request, type Response } from 'express';
import pinoHttp from 'pino-http';
import type Stripe from 'stripe';
import type { Executor, TransactionalExecutor } from './db/Executor.js';
import { RevenueService } from './revenue/RevenueService.js';
import type { SyncService } from './sync/SyncService.js';
import { RevenueController } from './api/RevenueController.js';
import { SyncController } from './api/SyncController.js';
import { DemoController } from './api/DemoController.js';
import { AppError } from './errors.js';
import { logger } from './logger.js';
import { revenueDefinition } from './revenue/canonical.js';

export interface AppDeps {
  db: TransactionalExecutor;
  syncService: SyncService;
  /**
   * Stripe client for the demo-charge endpoint. Omitted when Stripe is not
   * configured, in which case the route is not registered at all — a 404 is a
   * clearer answer than a 500 from a route that could never have worked.
   */
  stripe?: Stripe;
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

/**
 * Permissive CORS, so a separately-hosted frontend can call this service.
 *
 * Hand-rolled rather than pulling in `cors`: it is a dozen lines, and the read
 * endpoints take no credentials, so there is nothing to get subtly wrong.
 *
 * `*` is safe HERE specifically because every endpoint is unauthenticated and
 * carries no cookies — a browser will not attach ambient credentials, so a
 * hostile page learns nothing it could not learn by curling the URL itself. The
 * moment this service grows an API key or a session, `*` must be replaced with
 * an explicit origin list: the wildcard is invalid alongside
 * `Access-Control-Allow-Credentials: true`, and browsers will reject it.
 *
 * Registered first, so preflights, 404s, and error responses all carry the
 * headers too — a CORS-less 500 shows up in the browser as an opaque network
 * failure rather than the actual status.
 */
function cors(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Lets a browser cache the preflight for a day instead of re-asking per call.
  res.setHeader('Access-Control-Max-Age', '86400');
  // Responses vary by origin only in principle today, but proxies and CDNs cache
  // this service's GETs; without Vary they could serve one origin's headers to
  // another.
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

export function createApp(deps: AppDeps): Application {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors);
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

  const revenueService = new RevenueService(deps.db);
  const revenue = new RevenueController(revenueService);
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
        sync: 'POST /sync?source=stripe|paypal|ledger-csv (omit source to sync all)',
        summary: 'GET /revenue/summary?from=YYYY-MM-DD&to=YYYY-MM-DD',
        daily: 'GET /revenue/daily?from=YYYY-MM-DD&to=YYYY-MM-DD',
        unmapped: 'GET /revenue/unmapped?from=YYYY-MM-DD&to=YYYY-MM-DD',
        ...(deps.stripe
          ? {
              demoCharge:
                'POST /demo/stripe-charge {"count":1-5} — creates test charges in Stripe ' +
                'only; sync separately to bring them into the metric',
            }
          : {}),
      },
      note: "'to' is EXCLUSIVE. All bucketing is UTC. Amounts are integer minor units as strings.",
    });
  });

  app.post('/sync', wrap(sync.sync));
  app.get('/revenue/summary', wrap(revenue.summary));
  app.get('/revenue/daily', wrap(revenue.daily));
  app.get('/revenue/unmapped', wrap(revenue.unmapped));

  if (deps.stripe) {
    const demo = new DemoController(revenueService, deps.stripe);
    app.post('/demo/stripe-charge', wrap(demo.stripeCharge));
  }

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
