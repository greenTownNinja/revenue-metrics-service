/**
 * `POST /demo/stripe-charge` — creates real test-mode charges in Stripe and
 * stops there.
 *
 * IT DELIBERATELY DOES NOT SYNC. Ingestion stays an explicit, separate step, so
 * a demo can show the honest sequence: the charges exist in Stripe, the metric
 * has not moved, and only `POST /sync?source=stripe` brings them across. An
 * endpoint that created and synced in one call would hide the very boundary this
 * service is about — money in a provider is not revenue here until something
 * ingests it.
 *
 * IT ALSO DOES NOT COMPUTE A TOTAL. `metricBeforeSync` comes from
 * RevenueService, the same call path `/revenue/summary` uses. This file cannot
 * derive revenue — it can only ask the one canonical implementation and report
 * what it said. Deriving anything here is exactly what the drift guard prevents.
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

    const created = await createDemoCharges(this.stripe, parsed.data.count ?? MAX_DEMO_CHARGES);

    // Read AFTER creating, and deliberately BEFORE any sync. This is the whole
    // point of the endpoint: the charges now exist in Stripe and the metric has
    // not moved, because nothing has ingested them yet. Money in a provider is
    // not revenue in this service until a sync brings it across.
    const metric = await this.revenue.getSummary(range);

    res.status(201).json({
      range,
      definition: metric.definition,
      created,
      // Same serializer the /revenue endpoints use: amounts leave as decimal
      // strings, never JSON numbers. Express would otherwise throw on the BigInt.
      metricBeforeSync: {
        sources: metric.sources,
        totals: metric.totals.map(currencyTotalJson),
      },
      nextStep: `POST /sync?source=${STRIPE_SOURCE}, then GET /revenue/summary?from=${range.from}&to=${range.to}`,
      note:
        'These charges are live in Stripe and NOT yet in the metric. metricBeforeSync ' +
        'comes from the same RevenueService call /revenue/summary uses, so it is the ' +
        'baseline to compare against after you sync. Charges marked ' +
        'countsTowardRevenue:false will stay out of the total even then.',
    });
  };
}
