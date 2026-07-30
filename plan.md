# Revenue Metrics Service — Project Plan

## Goal

Build a backend service that computes **total revenue collected** for an arbitrary date range across multiple payment sources, using one canonical definition of "collected," and exposes that same number through two views that can never disagree.

Concretely:

* Ingest transactions from **two sources with different status vocabularies** (Stripe test mode + a fixture-backed source).
* Normalize into one canonical schema, preserving the raw provider status for audit.
* Store in Supabase Postgres.
* Compute revenue via a **single canonical module** using a status **allow-list**.
* Expose a summary endpoint and a daily-breakdown endpoint that are provably equal.
* Ship automated guards that **fail the build** if a second, divergent revenue calculation is ever introduced.

---

## Canonical Decisions

These are the decisions that make the number stable. Every one of them lives in exactly one place in code, and each is stated in the README.

| Question | Decision | Rationale |
| --- | --- | --- |
| What counts as collected? | Allow-list of canonical statuses (`COLLECTED`) | Exclusion lists let new/unknown statuses through as revenue |
| Unknown status | Excluded from revenue **and** surfaced as a warning | Silent exclusion means nobody notices a new vocabulary |
| Money representation | `BIGINT` minor units (cents) | Floats and `NUMERIC`-as-string both drift |
| Summation | Performed in SQL over `BIGINT` | Exact integer arithmetic, one code path |
| Currency | Revenue is reported **per currency**; no cross-currency sum | Summing USD + EUR is a meaningless number |
| Timezone | All bucketing in **UTC**, explicitly | Implicit server timezone makes day boundaries non-deterministic |
| Range semantics | `from` inclusive, `to` **exclusive** (`[from, to)`) | Half-open ranges compose; no double-counted boundary day |
| Refunds | A refunded payment is **not** collected. Partial refunds are **not** netted in v1 | Stated limitation, documented; see Tradeoffs |
| Days with no revenue | Omitted from the daily response, not zero-filled | Callers sum the array; absent days contribute 0 either way |

### Refund policy detail

`refunded` and `partially_refunded` are mapped to canonical `REFUNDED`, which is **not** in the allow-list. A fully refunded charge therefore contributes zero. A *partially* refunded charge in Stripe keeps status `succeeded` with a non-zero `amount_refunded`; v1 counts its full amount and records `amount_refunded_minor` in the row so the limitation is visible and a future version can net it without changing the calculation's location.

---

## Requirements Coverage

Plan status — nothing here is claimed as done until it is built and tested.

| Requirement | Approach |
| --- | --- |
| Real payment source | Stripe test mode (live API, paginated sync) |
| Multiple source systems | Stripe + `ledger-csv` fixture source with a different vocabulary |
| Store in Supabase | Postgres via `pg` over the Supabase connection pooler |
| Normalize data | Per-source adapter → canonical `NormalizedTransaction` |
| Allow-list of collected statuses | `revenue/canonical.ts`, single export, parameterized into SQL |
| Summary endpoint | `GET /revenue/summary` |
| Breakdown endpoint | `GET /revenue/daily` |
| Both views agree | Shared range normalization + shared SQL predicate + equality test |
| Catch a second divergent implementation | Guard test + agreement test + CI (see Drift Guards) |
| Handle failure | Typed errors, quarantine table, no crash on bad input |
| Deploy on Render | Free tier web service, `/health`, pooler connection |
| README | Overview, run steps, API docs, tradeoffs, sources, AI disclosure |
| Demo video | Includes the unknown-status edge case, live |

---

## Tech Stack

**Backend:** Node.js, TypeScript, Express
**Database:** Supabase Postgres, accessed with `pg` (single data path — no Supabase JS client)
**Deployment:** Render free tier
**Testing:** Vitest, GitHub Actions
**Libraries:** `express`, `pg`, `stripe`, `zod`, `dotenv`, `pino`, `vitest`, `tsx`

> Only one database access path. Mixing the Supabase REST client and raw SQL creates a second place revenue could be queried from, which is the drift we are trying to prevent.

---

## Project Structure

```text
revenue-metrics-service/
├── src/
│   ├── server.ts                    # bootstrap only
│   ├── app.ts                       # express wiring, error handler
│   │
│   ├── revenue/                     # THE canonical metric. Nothing else computes revenue.
│   │   ├── canonical.ts             # CanonicalStatus, COLLECTED_STATUSES, collectedSqlPredicate
│   │   ├── RevenueService.ts        # getSummary / getDailyBreakdown
│   │   ├── RevenueRepository.ts     # the only SQL that sums money
│   │   └── DateRange.ts             # parse + normalize [from, to) in UTC
│   │
│   ├── sources/
│   │   ├── SourceAdapter.ts         # interface every source implements
│   │   ├── stripe/
│   │   │   ├── StripeClient.ts      # paginated fetch, retries
│   │   │   └── StripeAdapter.ts     # Stripe vocabulary → CanonicalStatus
│   │   └── ledgerCsv/
│   │       ├── fixtures/ledger.csv
│   │       └── LedgerCsvAdapter.ts  # paid/voided/completed → CanonicalStatus
│   │
│   ├── sync/
│   │   ├── SyncService.ts           # fetch → normalize → upsert → report
│   │   └── SyncController.ts
│   │
│   ├── api/
│   │   ├── revenue.routes.ts
│   │   ├── RevenueController.ts     # thin: validate, call, serialize
│   │   └── health.routes.ts
│   │
│   ├── db/
│   │   ├── pool.ts
│   │   └── migrations/001_init.sql
│   │
│   └── errors.ts                    # ValidationError, UpstreamError, DbError
│
├── tests/
│   ├── agreement.test.ts            # summary == sum(daily), randomized ranges
│   ├── allowlist.test.ts            # status-by-status revenue behaviour
│   ├── boundaries.test.ts           # UTC day edges, half-open range
│   ├── sync.idempotency.test.ts     # re-sync produces no duplicates
│   ├── unknownStatus.test.ts        # new status → excluded + surfaced
│   └── guards/no-second-implementation.test.ts
│
├── .github/workflows/ci.yml
├── README.md
└── package.json
```

The directory boundary is the design: `src/revenue/` is the only place that knows what revenue means, and the guard test enforces that boundary mechanically.

---

## Canonical Status Model

Provider vocabularies are mapped to a closed canonical enum. The allow-list is over *canonical* values, so adding a source cannot add a revenue-counting status by accident.

```ts
// src/revenue/canonical.ts  — the only file that decides what revenue is

export enum CanonicalStatus {
  COLLECTED = 'COLLECTED',
  PENDING   = 'PENDING',
  FAILED    = 'FAILED',
  VOIDED    = 'VOIDED',
  REFUNDED  = 'REFUNDED',
  UNKNOWN   = 'UNKNOWN',
}

/** Allow-list. Statuses that count as collected revenue. Nothing else counts. */
export const COLLECTED_STATUSES: readonly CanonicalStatus[] = Object.freeze([
  CanonicalStatus.COLLECTED,
]);

/** SQL fragment + bind params. Both views use this exact predicate. */
export function collectedPredicate(paramIndex: number) {
  return { sql: `canonical_status = ANY($${paramIndex}::text[])`,
           params: [COLLECTED_STATUSES as unknown as string[]] };
}
```

Per-source mapping, with an explicit unknown fallback:

```ts
// StripeAdapter — Stripe charge vocabulary
succeeded → COLLECTED     pending  → PENDING
failed    → FAILED        refunded → REFUNDED
default   → UNKNOWN       // never silently COLLECTED

// LedgerCsvAdapter — a deliberately different vocabulary
paid      → COLLECTED     completed → COLLECTED
voided    → VOIDED        processing → PENDING
default   → UNKNOWN
```

Raw status is normalized (`trim().toLowerCase()`) before mapping, and the **original** string is stored unmodified in `raw_status`.

Why an allow-list and not `status != 'failed'`: when a provider introduces `disputed` or `processing`, an exclusion list counts it as revenue. An allow-list excludes it and — because unknowns are recorded — tells us it appeared.

---

## Database Schema

```sql
CREATE TABLE transactions (
  id                    BIGSERIAL PRIMARY KEY,
  source                TEXT        NOT NULL,
  external_id           TEXT        NOT NULL,

  amount_minor          BIGINT      NOT NULL,   -- integer minor units, never float
  amount_refunded_minor BIGINT      NOT NULL DEFAULT 0,
  currency              TEXT        NOT NULL,   -- ISO 4217, lowercased

  raw_status            TEXT        NOT NULL,   -- exactly what the provider said
  canonical_status      TEXT        NOT NULL,   -- CanonicalStatus, incl. 'UNKNOWN'

  occurred_at           TIMESTAMPTZ NOT NULL,   -- tz-aware; bucketed in UTC
  synced_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (source, external_id)
);

-- Serves both the summary and the daily view.
CREATE INDEX idx_tx_revenue
  ON transactions (canonical_status, currency, occurred_at);

-- Rows we could not normalize at all. Never silently dropped.
CREATE TABLE quarantined_transactions (
  id           BIGSERIAL PRIMARY KEY,
  source       TEXT        NOT NULL,
  external_id  TEXT,
  payload      JSONB       NOT NULL,
  reason       TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Incremental sync watermark, so /sync stays fast on Render's free tier.
CREATE TABLE sync_state (
  source        TEXT PRIMARY KEY,
  last_cursor   TEXT,
  last_synced_at TIMESTAMPTZ
);
```

**`UNIQUE (source, external_id)`** makes sync idempotent: `ON CONFLICT (source, external_id) DO UPDATE` means re-running a sync refreshes rows instead of duplicating them. `external_id` alone is not unique — two providers can both issue `inv_1001`.

**Why `canonical_status` is stored, not derived at query time:** it lets Postgres do the filtering and summing (exact `BIGINT` arithmetic, one query). The cost is that changing a mapping requires a backfill; the migration runbook is in the README, and mappings are covered by tests so a change is deliberate.

---

## The Metric: One Implementation

```
Stripe API ─┐
            ├─→ SourceAdapter → NormalizedTransaction → UPSERT → transactions
ledger.csv ─┘                                                        │
                                                                     ▼
                                                          RevenueRepository
                                                     (the only SQL that sums money)
                                                                     │
                                                          RevenueService
                                                    ┌────────────────┴────────────────┐
                                              GET /revenue/summary          GET /revenue/daily
```

Both endpoints funnel through the same service, the same range normalization, and the same SQL predicate.

```ts
class RevenueService {
  // Both call parseRange() and collectedPredicate(). Neither has its own filter.
  getSummary(input: RangeInput): Promise<{ range: Range; totals: CurrencyTotal[] }>
  getDailyBreakdown(input: RangeInput): Promise<{ range: Range; days: DayTotal[] }>
}
```

The only difference between the two is a `date_trunc('day', occurred_at AT TIME ZONE 'UTC')` grouping key. Same `WHERE` clause, same range bounds, same allow-list — so `sum(daily) == summary` per currency holds by construction, and the agreement test proves it stays true.

---

## Drift Guards

The plan requirement is that a *second, slightly different* calculation gets caught. Four mechanisms, all in CI:

**1. Agreement test** — for ~200 randomized `[from, to)` ranges over a seeded dataset (including empty ranges, single-day ranges, and ranges straddling UTC midnight), assert per-currency `sum(daily) === summary` exactly, as integers.

**2. Source guard test** — walk `src/`, and fail if any file outside `src/revenue/` contains:
- the identifiers `COLLECTED_STATUSES` / `CanonicalStatus.COLLECTED`
- the literal strings `'succeeded'`, `'paid'`, `'completed'`, `'captured'` (outside `src/sources/*/`, where mapping legitimately lives)
- `SUM(` or `sum(` applied to an amount column
- the table name `transactions` in a `SELECT` that also references an amount column

Failure message names the offending file and points at `src/revenue/canonical.ts`. This is the mechanism that actually fires when someone writes a convenient one-off query in a controller.

**3. Allow-list closure test** — assert every `CanonicalStatus` member is explicitly classified as collected or not. Adding an enum member without deciding fails the test, so a new status can never default into revenue.

**4. Mapping snapshot test** — every provider status string the adapters know about is asserted against its canonical value. Changing a mapping requires editing the test, which makes it a reviewed decision instead of an accident.

CI runs all of these plus typecheck on every push.

---

## Sync

```
POST /sync[?source=stripe|ledger-csv]
   → read watermark from sync_state
   → adapter.fetchSince(cursor)     [paginated: has_more / starting_after]
   → normalize each record
        ├─ mappable   → NormalizedTransaction
        └─ unmappable → quarantined_transactions (+ reason)
   → UPSERT in batches, ON CONFLICT (source, external_id) DO UPDATE
   → advance watermark
   → report
```

Response:

```json
{
  "source": "stripe",
  "fetched": 42,
  "upserted": 42,
  "quarantined": 1,
  "unknownStatuses": [{ "rawStatus": "disputed", "count": 2 }],
  "durationMs": 1840
}
```

`unknownStatuses` is the reason a new status vocabulary cannot appear unnoticed. `upserted` is reported as one number rather than split into inserted/updated — distinguishing them with `ON CONFLICT` requires an `xmax` trick that adds fragility for no analytic value.

Stripe specifics:
* Use **Charges**, not PaymentIntents — richer status vocabulary (`succeeded`/`pending`/`failed` plus `refunded` via `amount_refunded`), and amounts are already in minor units.
* Paginate with `has_more` / `starting_after`; a single unpaginated call returns only 10 records.
* Amounts come as integer cents — store as-is, no conversion, no rounding.
* Seed test data with a script that creates charges in several states (including at least one refund and one non-USD currency) so the dataset exercises the edge cases.

---

## API

All money is returned as **integer minor units** plus an explicit `currency`. No floats cross the wire.

### `GET /health`
```json
{ "status": "ok", "db": "ok", "version": "1.0.0" }
```

### `GET /revenue/summary?from=2026-07-01&to=2026-08-01`

`from` inclusive, `to` exclusive.

```json
{
  "range": { "from": "2026-07-01T00:00:00Z", "to": "2026-08-01T00:00:00Z", "timezone": "UTC" },
  "definition": { "collectedStatuses": ["COLLECTED"], "refundsNetted": false },
  "totals": [
    { "currency": "usd", "amountMinor": 125000, "transactionCount": 18 },
    { "currency": "eur", "amountMinor": 4200,   "transactionCount": 2  }
  ]
}
```

### `GET /revenue/daily?from=2026-07-01&to=2026-08-01`

```json
{
  "range": { "from": "2026-07-01T00:00:00Z", "to": "2026-08-01T00:00:00Z", "timezone": "UTC" },
  "definition": { "collectedStatuses": ["COLLECTED"], "refundsNetted": false },
  "days": [
    { "date": "2026-07-01", "currency": "usd", "amountMinor": 12000, "transactionCount": 2 },
    { "date": "2026-07-02", "currency": "usd", "amountMinor": 30000, "transactionCount": 4 }
  ]
}
```

Days with no collected revenue are omitted; summing the array per currency yields exactly the summary total. Echoing `range` and `definition` in both responses means a caller comparing the two numbers can see they were computed under identical rules.

### `GET /revenue/unmapped?from=&to=`

Raw statuses seen that map to `UNKNOWN`, with counts and total excluded amount — the operational answer to "did a new status appear?"

---

## Error Handling

| Condition | Status | Behaviour |
| --- | --- | --- |
| Missing / malformed date | 400 | Zod validation, names the bad field |
| `from >= to` | 400 | Explicit message; no silent swap |
| Range longer than 366 days | 400 | Bounds response size on free tier |
| Unknown `source` on `/sync` | 400 | Lists valid sources |
| Stripe unreachable / 5xx | 503 | Retry with backoff first, then fail; partial sync is committed and reported |
| Stripe auth failure | 502 | Distinguishes config error from outage |
| Database unavailable | 500 | Pool error surfaced, request fails, process survives |
| Unnormalizable record | — | Quarantined with reason; sync continues |
| Unhandled | 500 | Central error middleware, logged with request id |

Invariants: the process never exits on a request error; a failing record never aborts a sync; a partial sync never advances the watermark past unprocessed data.

---

## Testing

Automated, in CI — not a manual checklist.

* **Agreement** — randomized ranges, `sum(daily) == summary` per currency.
* **Allow-list** — insert `succeeded` 100 → 100; add `failed` 200 → still 100; add `processing` 300 → still 100; add `paid` (other source) 400 → 500; add `disputed` 500 → still 500 **and** it appears in `/revenue/unmapped`.
* **Boundaries** — a transaction at `23:59:59.999Z` and one at `00:00:00.000Z` land in the correct UTC days; `to` is exclusive; empty range returns `[]` and `0`, not an error.
* **Idempotency** — sync twice, assert row count and totals unchanged.
* **Multi-source** — two sources with different vocabularies produce one correct combined total.
* **Precision** — amounts near `Number.MAX_SAFE_INTEGER` sum exactly (proves the `BIGINT` path).
* **Guards** — the four drift guards above.

Tests run against a real Postgres (Supabase test schema or a local container), inside a transaction rolled back per test, so the SQL under test is the SQL that ships.

---

## Deployment

**Render free tier**, web service, `npm run build` → `node dist/server.js`.

Known free-tier constraints, to handle rather than discover:

* **Supabase connection string must be the pooler URL** (`aws-0-<region>.pooler.supabase.com`), not the direct `db.<ref>.supabase.co` host — Render free egress can't reliably reach the direct host over IPv6. This is the most likely deployment stall; do it first.
* **Small pool** — `max: 3`; the pooler plus Render's free instance won't tolerate more.
* **Cold starts** — the service spins down when idle, so the first request takes ~50s. Documented in the README; `/health` gives a cheap warm-up target.
* **Sync timeouts** — `/sync` is incremental and page-capped so it completes well inside Render's request timeout.
* **Supabase pauses after ~7 days idle** — noted in the README so a grader hitting a paused DB knows why.
* Secrets live in Render env vars only. The Stripe key is a **test-mode** key; the Postgres password never enters the repo.

Environment:

```
PORT=
DATABASE_URL=            # Supabase POOLER connection string
STRIPE_SECRET_KEY=       # sk_test_...
LOG_LEVEL=info
NODE_ENV=production
```

---

## Logging

Structured JSON via `pino`, with a request id on every line:

* sync started / finished (source, fetched, upserted, quarantined, duration)
* **unknown status encountered** — warn level, with raw value and source
* quarantined record — warn level, with reason
* revenue query (range, currency count, duration)
* errors with stack and request id

Unknown-status and quarantine events are logged at `warn` precisely so they are greppable in Render's log stream during the demo.

---

## Demo Video Plan (≤5 min)

1. Architecture in 30s — one canonical module, two views.
2. `POST /sync?source=stripe`, then `POST /sync?source=ledger-csv` — two vocabularies, one table.
3. `GET /revenue/summary` and `GET /revenue/daily` side by side; sum the daily array live to show it matches.
4. **Edge case, live:** insert a transaction with status `disputed`. Revenue is unchanged; it shows up in `/revenue/unmapped` and in the logs. Contrast with what an exclusion list would have done.
5. **Second edge case:** re-run `/sync` — row count and totals unchanged (idempotency).
6. **The drift guard:** add a naive `SELECT SUM(amount_minor)` in a controller, run the test suite, watch the guard test fail and name the file. Delete it, tests pass.

---

## Tradeoffs to Document

* **Partial refunds are not netted.** `amount_refunded_minor` is stored, so the data supports it; the calculation doesn't do it in v1. Stated explicitly rather than left ambiguous.
* **No FX conversion.** Revenue is per-currency. A single blended total would require a rate source and a rate-as-of policy — more drift surface than the assignment needs.
* **`canonical_status` is materialized at ingest**, trading mapping-change flexibility (needs a backfill) for exact SQL-side aggregation and a single query path.
* **UTC only.** No per-tenant timezone. Making the bucketing timezone a parameter is a clean extension, but the guarantee only holds if both views receive the same value.
* **Second source is fixture-backed**, not a second live sandbox. It demonstrates vocabulary normalization — the actual requirement — without a second account's setup cost. The adapter interface is the same, so a real second provider is a drop-in.
* **Timestamps are provider-reported `occurred_at`**, not ingest time, so late-arriving data changes historical totals. Correct for a revenue metric, but it means the number is not append-only.

---

## Build Order

Sequenced so the risky parts fail early.

| # | Step | Est. |
| --- | --- | --- |
| 1 | Repo, TypeScript, Express skeleton, `/health` | 20m |
| 2 | **Supabase + Render pooler connectivity end-to-end** (deploy a hello-world first) | 45m |
| 3 | Migration, `pool.ts`, test harness against real Postgres | 30m |
| 4 | `canonical.ts` + allow-list closure test | 25m |
| 5 | `DateRange` (UTC, half-open) + boundary tests | 30m |
| 6 | `RevenueRepository` + `RevenueService` + agreement test | 60m |
| 7 | Endpoints, Zod validation, error middleware | 40m |
| 8 | Stripe client (pagination, retries) + adapter + seed script | 75m |
| 9 | Ledger CSV adapter + multi-source test | 30m |
| 10 | `SyncService`, quarantine, watermark, idempotency test | 60m |
| 11 | `/revenue/unmapped` + unknown-status test | 25m |
| 12 | Drift guard test + CI workflow | 45m |
| 13 | Deploy, verify all endpoints live | 30m |
| 14 | README (tradeoffs, sources, AI disclosure) + demo video | 70m |

**≈ 9.5 hours.** Step 2 is deliberately second: connectivity is the likeliest multi-hour stall, and everything downstream depends on it.

---

## Success Criteria

* Two sources with different status vocabularies sync into one normalized table.
* Re-running a sync changes nothing (idempotent).
* `GET /revenue/summary` and `GET /revenue/daily` agree exactly, per currency, for any range — proven by a randomized test, not by inspection.
* A previously unseen status contributes **zero** revenue and is visibly surfaced.
* An unnormalizable record is quarantined and the sync still succeeds.
* Introducing a second revenue calculation anywhere in `src/` **fails CI**, with a message naming the file.
* Live on Render, reachable by curl, with a README covering setup, tradeoffs, sources, and AI usage.
```
