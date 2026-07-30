import type { Request, Response } from 'express';
import { z } from 'zod';
import type { SyncService } from '../sync/SyncService.js';
import { ValidationError } from '../errors.js';

const syncQuery = z.object({
  source: z.string().optional(),
  maxPages: z.coerce.number().int().min(1).max(50).optional(),
});

export class SyncController {
  constructor(private readonly service: SyncService) {}

  sync = async (req: Request, res: Response): Promise<void> => {
    const parsed = syncQuery.safeParse(req.query);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ValidationError(issue?.message ?? 'invalid query', String(issue?.path[0] ?? ''));
    }
    const { source, maxPages } = parsed.data;

    if (source) {
      // Throws UnknownSourceError (400) for an unregistered name.
      const report = await this.service.syncSource(source, maxPages);
      res.json(report);
      return;
    }

    const { reports, failures } = await this.service.syncAll(maxPages);
    // 207: some sources succeeded and some did not. A flat 200 would hide the
    // failures behind a successful-looking response.
    res.status(failures.length > 0 ? 207 : 200).json({ reports, failures });
  };
}
