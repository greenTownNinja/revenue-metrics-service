/**
 * Thin controller: validate, call the service, serialize. No business logic, no
 * SQL, no status literals.
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import type { RevenueService } from '../revenue/RevenueService.js';
import { ValidationError } from '../errors.js';
import { currencyTotalJson, dayTotalJson, unmappedJson } from './serialize.js';

/**
 * Shape check only. The semantics of the range — half-open, UTC, maximum span —
 * belong to DateRange.parseRange() so both views cannot disagree about them.
 */
const rangeQuery = z.object({
  from: z.string({ required_error: "'from' is required (YYYY-MM-DD)" }),
  to: z.string({ required_error: "'to' is required (YYYY-MM-DD, exclusive)" }),
});

function parseQuery(req: Request): { from: string; to: string } {
  const parsed = rangeQuery.safeParse(req.query);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ValidationError(issue?.message ?? 'invalid query', String(issue?.path[0] ?? ''));
  }
  return parsed.data;
}

export class RevenueController {
  constructor(private readonly service: RevenueService) {}

  summary = async (req: Request, res: Response): Promise<void> => {
    const result = await this.service.getSummary(parseQuery(req));
    res.json({
      range: result.range,
      definition: result.definition,
      sources: result.sources,
      totals: result.totals.map(currencyTotalJson),
    });
  };

  daily = async (req: Request, res: Response): Promise<void> => {
    const result = await this.service.getDailyBreakdown(parseQuery(req));
    res.json({
      range: result.range,
      definition: result.definition,
      days: result.days.map(dayTotalJson),
    });
  };

  unmapped = async (req: Request, res: Response): Promise<void> => {
    const result = await this.service.getUnmappedStatuses(parseQuery(req));
    res.json({
      range: result.range,
      definition: result.definition,
      unmapped: result.unmapped.map(unmappedJson),
    });
  };
}
