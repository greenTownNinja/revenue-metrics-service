-- Revenue Metrics Service — initial schema.
-- Written to run identically on Supabase Postgres and on PGlite (tests), so it
-- avoids Supabase-only extensions.

CREATE TABLE IF NOT EXISTS transactions (
  id                    BIGSERIAL   PRIMARY KEY,

  -- Which source system this came from ('stripe', 'ledger-csv', ...).
  source                TEXT        NOT NULL,
  -- The source's own identifier. Unique only WITHIN a source: two providers can
  -- both issue 'inv_1001'.
  external_id           TEXT        NOT NULL,

  -- Money as integer minor units (cents). Never float, never NUMERIC:
  -- floats lose precision, and node-postgres hands NUMERIC back as a *string*,
  -- so `a + b` silently concatenates instead of adding.
  amount_minor          BIGINT      NOT NULL,
  -- Stored so the partial-refund limitation is visible in the data rather than
  -- only in the README. Not netted out in v1.
  amount_refunded_minor BIGINT      NOT NULL DEFAULT 0,
  -- ISO 4217, lowercased. Revenue is reported per currency; never summed across.
  currency              TEXT        NOT NULL,

  -- Exactly what the provider said, unmodified. Audit trail for mapping changes.
  raw_status            TEXT        NOT NULL,
  -- CanonicalStatus, including 'UNKNOWN'. Materialized at ingest so Postgres can
  -- filter and sum in one exact-integer query.
  canonical_status      TEXT        NOT NULL,

  -- Provider-reported event time, timezone-aware. All bucketing is in UTC.
  occurred_at           TIMESTAMPTZ NOT NULL,
  synced_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT transactions_amount_nonneg        CHECK (amount_minor >= 0),
  CONSTRAINT transactions_refund_nonneg        CHECK (amount_refunded_minor >= 0),
  CONSTRAINT transactions_refund_within_amount CHECK (amount_refunded_minor <= amount_minor),
  CONSTRAINT transactions_currency_iso         CHECK (currency ~ '^[a-z]{3}$'),

  -- Makes sync idempotent: re-running upserts instead of duplicating.
  CONSTRAINT transactions_source_external_uniq UNIQUE (source, external_id)
);

-- Serves both the summary and the daily breakdown: the leading columns match the
-- shared WHERE clause, and occurred_at supports both the range scan and the
-- date_trunc grouping.
CREATE INDEX IF NOT EXISTS idx_transactions_revenue
  ON transactions (canonical_status, currency, occurred_at);

-- Supports /revenue/unmapped without scanning collected rows.
CREATE INDEX IF NOT EXISTS idx_transactions_unmapped
  ON transactions (occurred_at)
  WHERE canonical_status = 'UNKNOWN';


-- Records we could not normalize at all (unparseable amount, missing id, bad
-- date). Never silently dropped — a sync reports its quarantine count.
CREATE TABLE IF NOT EXISTS quarantined_transactions (
  id          BIGSERIAL   PRIMARY KEY,
  source      TEXT        NOT NULL,
  external_id TEXT,
  payload     JSONB       NOT NULL,
  reason      TEXT        NOT NULL,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_count  INTEGER     NOT NULL DEFAULT 1,

  -- Quarantine has to be idempotent for the same reason the transactions table
  -- does: a re-sync re-encounters the same bad records, and without this the
  -- table grows without bound on every call. Generated rather than supplied by
  -- the app so the key cannot drift from its parts, and COALESCE'd because a
  -- NULL external_id would otherwise defeat the unique constraint (NULLs never
  -- compare equal).
  dedupe_key  TEXT        GENERATED ALWAYS AS
                            (source || '|' || COALESCE(external_id, '') || '|' || reason) STORED,
  CONSTRAINT quarantined_dedupe_uniq UNIQUE (dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_quarantined_source_last_seen
  ON quarantined_transactions (source, last_seen DESC);


-- Incremental sync watermark, so /sync completes well inside Render's request
-- timeout instead of re-fetching all history every call.
CREATE TABLE IF NOT EXISTS sync_state (
  source         TEXT        PRIMARY KEY,
  last_cursor    TEXT,
  last_synced_at TIMESTAMPTZ
);
