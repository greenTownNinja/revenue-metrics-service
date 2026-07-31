/**
 * HTTP surface: the real Express app, mounted against PGlite, exercised over a
 * real socket. No mocks of our own code.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { createTestDb, type TestDb } from './helpers/testDb.js';
import { SyncService } from '../src/sync/SyncService.js';
import { LedgerCsvAdapter } from '../src/sources/ledgerCsv/LedgerCsvAdapter.js';

let db: TestDb;
let server: Server;
let base: string;

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}
async function post(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, { method: 'POST' });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  db = await createTestDb();
  const app = createApp({ db, syncService: new SyncService(db, [new LedgerCsvAdapter()]) });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
});

describe('API', () => {
  it('reports health with a live DB check', async () => {
    const { status, body } = await get('/health');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.db).toBe('ok');
  });

  it('describes itself at the root', async () => {
    const { status, body } = await get('/');
    expect(status).toBe(200);
    expect(body.endpoints).toHaveProperty('summary');
    expect(body.note).toMatch(/EXCLUSIVE/);
  });

  it('syncs, then serves two views that agree', async () => {
    const sync = await post('/sync?source=ledger-csv');
    expect(sync.status).toBe(200);
    expect(sync.body.upserted).toBeGreaterThan(0);
    expect(sync.body.unknownStatuses).toEqual([{ rawStatus: 'disputed', count: 1 }]);

    const summary = await get('/revenue/summary?from=2026-07-01&to=2026-08-01');
    const daily = await get('/revenue/daily?from=2026-07-01&to=2026-08-01');
    expect(summary.status).toBe(200);
    expect(daily.status).toBe(200);

    // Fold the wire format the way a client would, using BigInt on the strings.
    const folded = new Map<string, bigint>();
    for (const d of daily.body.days) {
      folded.set(d.currency, (folded.get(d.currency) ?? 0n) + BigInt(d.amountMinor));
    }
    for (const t of summary.body.totals) {
      expect(folded.get(t.currency), `currency ${t.currency}`).toBe(BigInt(t.amountMinor));
    }
    expect(folded.size).toBe(summary.body.totals.length);
  });

  it('serializes amounts as strings, never JSON numbers', async () => {
    const { body } = await get('/revenue/summary?from=2026-07-01&to=2026-08-01');
    for (const t of body.totals) {
      expect(typeof t.amountMinor).toBe('string');
    }
    // The big-amount fixture row survives the round trip exactly.
    const usd = body.totals.find((t: any) => t.currency === 'usd');
    expect(BigInt(usd.amountMinor)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it('echoes the definition in both views so a caller can verify the rules match', async () => {
    const summary = await get('/revenue/summary?from=2026-07-01&to=2026-08-01');
    const daily = await get('/revenue/daily?from=2026-07-01&to=2026-08-01');
    expect(summary.body.definition).toEqual(daily.body.definition);
    expect(summary.body.definition).toMatchObject({
      collectedStatuses: ['COLLECTED'],
      refundsNetted: false,
      timezone: 'UTC',
      rangeSemantics: '[from, to)',
    });
  });

  it('surfaces unmapped statuses', async () => {
    const { status, body } = await get('/revenue/unmapped?from=2026-07-01&to=2026-08-01');
    expect(status).toBe(200);
    expect(body.unmapped).toEqual([
      {
        source: 'ledger-csv',
        rawStatus: 'disputed',
        currency: 'usd',
        occurrences: 1,
        excludedAmountMinor: '77000',
      },
    ]);
  });

  it('returns 400 for bad input rather than crashing', async () => {
    const cases = [
      '/revenue/summary',
      '/revenue/summary?from=2026-07-01',
      '/revenue/summary?from=bogus&to=2026-08-01',
      '/revenue/summary?from=2026-08-01&to=2026-07-01',
      '/revenue/summary?from=2020-01-01&to=2026-01-01',
      '/revenue/daily?from=2026-02-30&to=2026-08-01',
    ];
    for (const path of cases) {
      const { status, body } = await get(path);
      expect(status, path).toBe(400);
      expect(body.error.code, path).toBe('VALIDATION_ERROR');
      expect(typeof body.error.message).toBe('string');
    }

    // Still serving afterwards — a rejected request must not take the app down.
    expect((await get('/health')).status).toBe(200);
  });

  it('returns 400 with the available sources for an unknown source', async () => {
    const { status, body } = await post('/sync?source=paypal');
    expect(status).toBe(400);
    expect(body.error.code).toBe('UNKNOWN_SOURCE');
    expect(body.error.details.available).toContain('ledger-csv');
  });

  it('returns 404 for an unknown route', async () => {
    const { status, body } = await get('/revenue/total');
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('does not register the demo-charge route when Stripe is absent', async () => {
    // A 404 is the honest answer for a route that could never have worked here.
    const res = await fetch(`${base}/demo/stripe-charge`, { method: 'POST' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('allows cross-origin reads from any origin', async () => {
    const res = await fetch(`${base}/revenue/summary?from=2026-07-01&to=2026-08-01`, {
      headers: { Origin: 'https://some-frontend.example' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('answers a preflight for POST /sync without running the sync', async () => {
    const before = await get('/revenue/summary?from=2026-07-01&to=2026-08-01');
    const res = await fetch(`${base}/sync?source=ledger-csv`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://some-frontend.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toContain('Content-Type');

    // A preflight must be a no-op. If OPTIONS fell through to the POST handler,
    // a browser merely *asking* whether it may sync would perform a sync.
    const after = await get('/revenue/summary?from=2026-07-01&to=2026-08-01');
    expect(after.body.totals).toEqual(before.body.totals);
  });

  it('sends CORS headers on errors too, so the browser sees the real status', async () => {
    // Without this a 400 reaches the frontend as an opaque network failure and
    // the actual validation message is unreadable.
    const res = await fetch(`${base}/revenue/summary?from=2026-08-01&to=2026-07-01`, {
      headers: { Origin: 'https://some-frontend.example' },
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('stays idempotent over HTTP', async () => {
    const before = await get('/revenue/summary?from=2026-07-01&to=2026-08-01');
    await post('/sync?source=ledger-csv');
    await post('/sync?source=ledger-csv');
    const after = await get('/revenue/summary?from=2026-07-01&to=2026-08-01');
    expect(after.body.totals).toEqual(before.body.totals);
  });
});
