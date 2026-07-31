/**
 * `POST /demo/stripe-charge` — creates real test-mode charges in Stripe, syncs,
 * and returns the metric before and after, so a browser can watch new money
 * arrive end to end.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not compute an expected total, and
 * it does not add anything up. `before` and `after` both come from
 * RevenueService — the same call path `/revenue/summary` uses. The endpoint's
 * claim is "the number moved", and the only way it can make that claim is by
 * asking the one canonical implementation twice. Computing the delta server-side
 * would mean this file knew how to derive revenue, which is exactly what the
 * drift guard exists to prevent.
 *
 * SAFETY. The charges are real API calls, and the route is public and
 * unauthenticated (CORS is open). Three things bound the blast radius:
 *   - the Stripe client comes from stripeClientFromEnv(), which refuses any key
 *     that is not test-mode, so this cannot touch live money
 *   - at most MAX_DEMO_CHARGES charges per request, from a fixed plan — the
 *     caller chooses how many, never the amounts
 *   - a process-wide cooldown, so a page left open in a loop cannot fill the
 *     test account
 */

import type { Request, Response } from 'express';
import type Stripe from 'stripe';
import { z } from 'zod';
import type { RevenueService } from '../revenue/RevenueService.js';
import type { SyncService } from '../sync/SyncService.js';
import { RateLimitedError, ValidationError } from '../errors.js';
import { currencyTotalJson } from './serialize.js';
import { STRIPE_SOURCE } from '../sources/stripe/StripeAdapter.js';
import { createDemoCharges, MAX_DEMO_CHARGES } from '../sources/stripe/StripeDemoCharges.js';

const body = z.object({
  count: z.coerce.number().int().min(1).max(MAX_DEMO_CHARGES).optional(),
});

/** Minimum gap between demo charge runs, process-wide. */
const COOLDOWN_MS = 10_000;

/**
 * The UTC day a charge created right now will land in.
 *
 * Stripe stamps `created` server-side in UTC, and the metric buckets by UTC day,
 * so this must be the UTC date rather than the server's local one — otherwise
 * the range returned would miss the charge for part of every day.
 */
function todayUtcRange(): { from: string; to: string } {
  const now = Date.now();
  return {
    from: new Date(now).toISOString().slice(0, 10),
    to: new Date(now + 86_400_000).toISOString().slice(0, 10),
  };
}

export class DemoController {
  private lastRunAt = 0;

  constructor(
    private readonly revenue: RevenueService,
    private readonly sync: SyncService,
    private readonly stripe: Stripe,
  ) {}

  stripeCharge = async (req: Request, res: Response): Promise<void> => {
    const parsed = body.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ValidationError(issue?.message ?? 'invalid body', String(issue?.path[0] ?? 'count'));
    }

    const since = Date.now() - this.lastRunAt;
    if (since < COOLDOWN_MS) {
      throw new RateLimitedError(Math.ceil((COOLDOWN_MS - since) / 1000));
    }
    // Claimed before the slow work starts, so two concurrent requests cannot both
    // pass the check and double the charges.
    this.lastRunAt = Date.now();

    const range = todayUtcRange();

    // Read the baseline BEFORE creating anything, through the canonical service.
    const before = await this.revenue.getSummary(range);

    const created = await createDemoCharges(this.stripe, parsed.data.count ?? MAX_DEMO_CHARGES);

    const syncReport = await this.sync.syncSource(STRIPE_SOURCE);

    const after = await this.revenue.getSummary(range);

    // Same serializer the /revenue endpoints use: amounts leave as decimal
    // strings, never JSON numbers. Express would otherwise throw on the BigInt.
    const totals = (s: typeof before) => ({
      sources: s.sources,
      totals: s.totals.map(currencyTotalJson),
    });

    res.status(201).json({
      range,
      definition: before.definition,
      created,
      sync: syncReport,
      before: totals(before),
      after: totals(after),
      note:
        'before/after both come from the same RevenueService call that ' +
        '/revenue/summary uses. Charges marked countsTowardRevenue:false are real ' +
        'in Stripe and deliberately absent from the totals.',
    });
  };
}
