/**
 * Write-side persistence. Deliberately separate from RevenueRepository: this
 * file inserts rows and never aggregates money, so the read path stays the only
 * place a total can be produced.
 */

import type { Executor } from '../db/Executor.js';
import type { NormalizedTransaction, QuarantinedRecord } from '../sources/SourceAdapter.js';

/** Rows per INSERT. Keeps parameter count well under Postgres' 65535 limit. */
const BATCH_SIZE = 250;
const COLUMNS_PER_ROW = 9;

export class TransactionStore {
  constructor(private readonly db: Executor) {}

  /**
   * Idempotent upsert on (source, external_id).
   *
   * Re-running a sync refreshes mutable fields (status, refund amount) instead
   * of creating duplicate rows. `synced_at` is bumped so it is possible to see
   * when a row was last confirmed.
   *
   * Returns the number of rows written. Inserts and updates are not reported
   * separately: distinguishing them under ON CONFLICT requires an `xmax` trick
   * that adds fragility without telling us anything about the metric.
   */
  async upsertMany(txs: readonly NormalizedTransaction[]): Promise<number> {
    let written = 0;

    for (let start = 0; start < txs.length; start += BATCH_SIZE) {
      const batch = txs.slice(start, start + BATCH_SIZE);

      const placeholders = batch
        .map((_, i) => {
          const b = i * COLUMNS_PER_ROW;
          return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9})`;
        })
        .join(', ');

      const params = batch.flatMap((t) => [
        t.source,
        t.externalId,
        // BigInt is passed as a string: node-postgres cannot serialize BigInt,
        // and Postgres parses the text into BIGINT without precision loss.
        t.amountMinor.toString(),
        t.amountRefundedMinor.toString(),
        t.currency,
        t.rawStatus,
        t.canonicalStatus,
        t.occurredAt.toISOString(),
        new Date().toISOString(),
      ]);

      const { rowCount } = await this.db.query(
        `INSERT INTO transactions (
           source, external_id, amount_minor, amount_refunded_minor,
           currency, raw_status, canonical_status, occurred_at, synced_at
         )
         VALUES ${placeholders}
         ON CONFLICT (source, external_id) DO UPDATE SET
           amount_minor          = EXCLUDED.amount_minor,
           amount_refunded_minor = EXCLUDED.amount_refunded_minor,
           currency              = EXCLUDED.currency,
           raw_status            = EXCLUDED.raw_status,
           canonical_status      = EXCLUDED.canonical_status,
           occurred_at           = EXCLUDED.occurred_at,
           synced_at             = EXCLUDED.synced_at`,
        params,
      );

      written += rowCount;
    }

    return written;
  }

  /**
   * Idempotent quarantine.
   *
   * Re-encountering the same bad record for the same reason bumps `last_seen` and
   * `seen_count` rather than inserting a duplicate — otherwise the table grows on
   * every sync and "re-running changes nothing" would only be half true.
   *
   * Returns the number of records quarantined by this call (new or repeat), which
   * is what the sync report is about — not how many rows were created.
   */
  async quarantineMany(records: readonly QuarantinedRecord[]): Promise<number> {
    for (const r of records) {
      await this.db.query(
        `INSERT INTO quarantined_transactions (source, external_id, payload, reason)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (dedupe_key) DO UPDATE SET
           payload    = EXCLUDED.payload,
           last_seen  = now(),
           seen_count = quarantined_transactions.seen_count + 1`,
        [r.source, r.externalId, JSON.stringify(r.payload ?? null), r.reason],
      );
    }
    return records.length;
  }

  async getCursor(source: string): Promise<string | null> {
    const { rows } = await this.db.query<{ last_cursor: string | null }>(
      `SELECT last_cursor FROM sync_state WHERE source = $1`,
      [source],
    );
    return rows[0]?.last_cursor ?? null;
  }

  async setCursor(source: string, cursor: string | null): Promise<void> {
    await this.db.query(
      `INSERT INTO sync_state (source, last_cursor, last_synced_at)
       VALUES ($1, $2, now())
       ON CONFLICT (source) DO UPDATE SET
         last_cursor    = EXCLUDED.last_cursor,
         last_synced_at = EXCLUDED.last_synced_at`,
      [source, cursor],
    );
  }
}
