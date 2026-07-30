/**
 * Orchestrates: fetch → normalize → upsert → advance watermark → report.
 *
 * Two invariants:
 *   - A single bad record never aborts a sync. It is quarantined and reported.
 *   - The watermark only advances after a successful write, so a failed sync
 *     never skips data.
 */

import type { TransactionalExecutor } from '../db/Executor.js';
import { CanonicalStatus } from '../revenue/canonical.js';
import type { SourceAdapter } from '../sources/SourceAdapter.js';
import { TransactionStore } from './TransactionStore.js';
import { UnknownSourceError } from '../errors.js';
import { logger } from '../logger.js';

/** Page cap per sync, so the request finishes inside Render's timeout. */
const DEFAULT_MAX_PAGES = 10;

export interface UnknownStatusSummary {
  rawStatus: string;
  count: number;
}

export interface SyncReport {
  source: string;
  fetched: number;
  upserted: number;
  quarantined: number;
  /**
   * Statuses this sync could not map. Present so a new provider vocabulary
   * surfaces immediately rather than quietly contributing zero forever.
   */
  unknownStatuses: UnknownStatusSummary[];
  durationMs: number;
}

export class SyncService {
  private readonly adapters = new Map<string, SourceAdapter>();

  constructor(
    private readonly db: TransactionalExecutor,
    adapters: readonly SourceAdapter[],
  ) {
    for (const a of adapters) this.adapters.set(a.name, a);
  }

  get sourceNames(): string[] {
    return [...this.adapters.keys()].sort();
  }

  async syncSource(name: string, maxPages = DEFAULT_MAX_PAGES): Promise<SyncReport> {
    const adapter = this.adapters.get(name);
    if (!adapter) throw new UnknownSourceError(name, this.sourceNames);

    const startedAt = Date.now();
    logger.info({ source: name }, 'sync started');

    const readStore = new TransactionStore(this.db);
    const cursor = await readStore.getCursor(name);

    // Fetching happens outside the transaction: a slow upstream should not hold
    // a Postgres connection open on a 3-connection pool.
    const result = await adapter.fetch({ cursor, maxPages });

    const unknownStatuses = tallyUnknownStatuses(result.normalized);

    // Rows, quarantine and watermark move together: a partial write would leave
    // the watermark ahead of data that was never stored.
    const { upserted, quarantined } = await this.db.transaction(async (tx) => {
      const store = new TransactionStore(tx);
      const upsertedCount = await store.upsertMany(result.normalized);
      const quarantinedCount = await store.quarantineMany(result.quarantined);
      await store.setCursor(name, result.nextCursor);
      return { upserted: upsertedCount, quarantined: quarantinedCount };
    });

    const report: SyncReport = {
      source: name,
      fetched: result.fetched,
      upserted,
      quarantined,
      unknownStatuses,
      durationMs: Date.now() - startedAt,
    };

    logger.info({ ...report }, 'sync finished');
    if (unknownStatuses.length > 0) {
      logger.warn(
        { source: name, unknownStatuses },
        'sync saw statuses no adapter recognises — excluded from revenue',
      );
    }
    if (quarantined > 0) {
      logger.warn({ source: name, quarantined }, 'records quarantined');
    }

    return report;
  }

  /** Syncs every registered source. One failing source does not stop the others. */
  async syncAll(maxPages = DEFAULT_MAX_PAGES): Promise<{
    reports: SyncReport[];
    failures: { source: string; error: string }[];
  }> {
    const reports: SyncReport[] = [];
    const failures: { source: string; error: string }[] = [];

    for (const name of this.sourceNames) {
      try {
        reports.push(await this.syncSource(name, maxPages));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ source: name, err }, 'source sync failed');
        failures.push({ source: name, error: message });
      }
    }

    return { reports, failures };
  }
}

function tallyUnknownStatuses(
  txs: readonly { canonicalStatus: CanonicalStatus; rawStatus: string }[],
): UnknownStatusSummary[] {
  const counts = new Map<string, number>();
  for (const t of txs) {
    if (t.canonicalStatus === CanonicalStatus.UNKNOWN) {
      const key = t.rawStatus.trim();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([rawStatus, count]) => ({ rawStatus, count }))
    .sort((a, b) => b.count - a.count || a.rawStatus.localeCompare(b.rawStatus));
}
