# Revenue Metrics Service

One canonical "total revenue collected" across multiple payment sources, exposed through two views that cannot disagree.

Transactions arrive from source systems with different status vocabularies — Stripe says `succeeded`, an invoice ledger says `paid` or `completed`. Both normalize onto one closed canonical enum, and revenue is computed from an **allow-list** of statuses that count, in exactly one place in the codebase. A summary endpoint and a day-by-day endpoint read that same code path, and a CI guard fails the build if a second, divergent calculation is ever introduced.

**Live deployment:** _(fill in your Render URL)_ — e.g. `https://revenue-metrics-service.onrender.com`

> Render's free tier spins the instance down when idle. The first request after a pause takes ~50 seconds while Node boots. Hit `/health` first.

---

## Try it in 30 seconds, no credentials

```bash
npm install
npm run demo
```

This boots the real Express app against [PGlite](https://pglite.dev) (Postgres compiled to WASM, in-process) and the CSV source, then walks through a sync, both views agreeing, and each edge case. No Supabase project and no Stripe key required.

```bash
npm test        # 67 tests, including the drift guard
npm run typecheck
```

---

## The problem this solves

A revenue number drifts for boring, specific reasons. Each one is a decision made in exactly one place here:

| Failure mode | How it is prevented |
| --- | --- |
| A new provider status (`disputed`, `on_hold`) silently counts as revenue | Allow-list of canonical statuses, never an exclusion list. Unrecognised → `UNKNOWN` → contributes zero |
| …and nobody notices it appeared | `UNKNOWN` is surfaced in the sync report, in `warn` logs, and at `GET /revenue/unmapped` |
| Two endpoints grow two slightly different queries | Both build from one shared SQL clause factory; a CI guard fails the build if revenue logic appears outside `src/revenue/` |
| Floating-point cents | Money is `BIGINT` minor units, summed in Postgres, serialized as strings. No float anywhere in the path |
| `NUMERIC` returned as a string, so `a + b` concatenates | No `NUMERIC` columns; `BIGINT` is parsed to `BigInt` deliberately at the repository boundary |
| USD and EUR added together | Revenue is reported **per currency**. There is no blended total to be wrong |
| Day buckets shift with server timezone | `TIMESTAMPTZ` storage, `AT TIME ZONE 'UTC'` truncation, in one query |
| Adjacent ranges double-count a boundary day | Ranges are half-open `[from, to)`, parsed in one place used by both views |
| A re-run of the sync inflates totals | `UNIQUE (source, external_id)` + upsert. Quarantine is deduped too |
| One malformed record kills the whole sync | Bad records are quarantined with a reason; the sync completes and reports the count |
| A failed sync skips data | The watermark advances only inside the successful write transaction |

---

## Canonical decisions

Stated here because a metric's definition is part of its API. All of it is echoed in every response as a `definition` object.

| Question | Decision |
| --- | --- |
| What counts as collected? | Allow-list: canonical `COLLECTED` only |
| Unknown status | Contributes zero **and** is surfaced |
| Money | `BIGINT` minor units, summed in SQL, serialized as decimal strings |
| Currency | Per-currency totals; never summed across currencies |
| Timezone | UTC, explicitly |
| Range | `from` inclusive, `to` **exclusive** |
| Fully refunded | Not collected |
| Partially refunded | **Counted in full** in v1; `amount_refunded_minor` is stored so the gap is visible |
| Days with zero revenue | Omitted from the breakdown |

### The refund detail

Stripe leaves a fully refunded charge's `status` as `succeeded`. Taking that at face value would count money we handed back, so the adapter records the *effective* status (`REFUNDED`) while preserving what Stripe literally said in `raw_status`. A **partial** refund keeps `COLLECTED` and its full amount — v1 does not net refunds. That is a real limitation, not an oversight: netting changes what the number means, and the data needed to do it later is already stored.

---

## Architecture

```
Stripe API (test mode) ─┐
                        ├─→ SourceAdapter ─→ NormalizedTransaction ─→ upsert ─→ transactions
ledger.csv ─────────────┘         │                                                  │
                                  │ unmappable                                       │
                                  └──────────→ quarantined_transactions              │
                                                                                     ▼
                                                                        RevenueRepository
                                                                  ← the ONLY SQL that sums money
                                                                                     │
                                                                          RevenueService
                                                          ┌──────────────────┴──────────────────┐
                                                    /revenue/summary                  /revenue/daily
```

**`src/revenue/` is the design.** It is the only directory that knows what revenue means, and the boundary is enforced mechanically rather than by convention.

```
src/
├── revenue/                     ← THE canonical metric
│   ├── canonical.ts               CanonicalStatus, COLLECTED_STATUSES, collectedPredicate()
│   ├── DateRange.ts               [from, to) in UTC — one definition for both views
│   ├── RevenueRepository.ts       the only SQL that aggregates money
│   └── RevenueService.ts          the only entry point for the number
├── sources/                     ← vocabulary mapping only; never aggregation
│   ├── SourceAdapter.ts
│   ├── stripe/StripeAdapter.ts
│   └── ledgerCsv/LedgerCsvAdapter.ts
├── sync/                          fetch → normalize → upsert → watermark
├── api/                           thin controllers: validate, call, serialize
├── db/                            pool, migrations, migration runner
├── app.ts  server.ts  errors.ts  logger.ts
tests/
├── guards/no-second-implementation.test.ts   ← the drift guard
├── agreement.test.ts  allowlist.test.ts  boundaries.test.ts
├── sync.test.ts  vocabulary.test.ts  api.test.ts
```

### How a second implementation gets caught

Four mechanisms, all in CI:

1. **Agreement test** — 200 randomized ranges plus single-day, empty, and midnight-straddling cases; asserts `sum(daily) === summary` per currency, compared as `BigInt`.
2. **Source guard** — walks `src/`, fails if anything outside `src/revenue/` reads the allow-list, sums a money column (SQL or JS), calls `date_trunc`, filters `occurred_at`, or hardcodes a collected status. The failure names the file and the fix. Adapters are exempt from the status-literal rules — declaring "this provider's `paid` means collected" is their job.
3. **Allow-list closure** — every `CanonicalStatus` member must be explicitly classified. Adding one without deciding fails CI instead of defaulting.
4. **Vocabulary snapshot** — every provider status is pinned to its canonical value, so changing a mapping is a reviewed edit rather than an accident. It also asserts the two sources use genuinely *different* spellings of "collected" — otherwise the suite wouldn't be testing normalization at all.

Verified by planting a violation:

```
src/api/RevenueController.ts:59
  aggregates a money column in SQL
  > `SELECT SUM(amount_minor) AS total FROM transactions
  fix: src/revenue/RevenueRepository.ts is the only place that sums money.
```

The guard also tests itself: each rule must still match a known-bad snippet, because a guard whose patterns have quietly stopped matching is worse than none — it looks like protection.

---

## API

Amounts are **integer minor units in strings**. A JSON number would put the value through an IEEE-754 double in every client that parsed it.

### `GET /health`
```json
{ "status": "ok", "db": "ok", "definition": { ... } }
```
Returns 503 if Postgres is unreachable. Also the cheapest way to warm a cold Render instance.

### `POST /sync?source=stripe|ledger-csv`
Omit `source` to sync all. Optional `maxPages` (1–50).

```json
{
  "source": "ledger-csv",
  "fetched": 16,
  "upserted": 15,
  "quarantined": 1,
  "unknownStatuses": [{ "rawStatus": "disputed", "count": 1 }],
  "durationMs": 21
}
```

Syncing all sources returns `207` if any source failed, with a `failures` array — a flat `200` would hide failures behind a successful-looking response.

### `GET /revenue/summary?from=2026-07-01&to=2026-08-01`

```json
{
  "range": { "from": "2026-07-01T00:00:00.000Z", "to": "2026-08-01T00:00:00.000Z",
             "timezone": "UTC", "semantics": "[from, to)" },
  "definition": { "collectedStatuses": ["COLLECTED"], "refundsNetted": false,
                  "timezone": "UTC", "rangeSemantics": "[from, to)" },
  "sources": ["ledger-csv", "stripe"],
  "totals": [
    { "currency": "eur", "amountMinor": "12000", "transactionCount": 2 },
    { "currency": "usd", "amountMinor": "142500", "transactionCount": 6 }
  ]
}
```

### `GET /revenue/daily?from=2026-07-01&to=2026-08-01`

```json
{
  "range": { ... }, "definition": { ... },
  "days": [
    { "date": "2026-07-01", "currency": "usd", "amountMinor": "57500", "transactionCount": 2 },
    { "date": "2026-07-02", "currency": "usd", "amountMinor": "30000", "transactionCount": 1 }
  ]
}
```

Summing `days` per currency reproduces `totals` exactly. Both responses echo the same `range` and `definition`, so a caller comparing two numbers can verify they were computed under identical rules — not just that they happen to match today.

### `GET /revenue/unmapped?from=&to=`

The operational answer to "did a new status appear?"

```json
{
  "unmapped": [
    { "source": "ledger-csv", "rawStatus": "disputed", "currency": "usd",
      "occurrences": 1, "excludedAmountMinor": "77000" }
  ]
}
```

### Errors

| Condition | Status | Code |
| --- | --- | --- |
| Missing/malformed date, `from >= to`, range > 366 days | 400 | `VALIDATION_ERROR` |
| Unknown `source` | 400 | `UNKNOWN_SOURCE` (lists available) |
| Stripe rejected our key/request | 502 | `UPSTREAM_CONFIG_ERROR` |
| Stripe unreachable or 5xx | 503 | `UPSTREAM_UNAVAILABLE` |
| Postgres unavailable | 500 | `DATABASE_ERROR` |
| Unknown route | 404 | `NOT_FOUND` |

`2026-02-30` is rejected: `new Date()` would roll it forward to March 2nd rather than failing.

---

## Running locally

### No credentials (recommended for review)

```bash
npm install
npm run demo    # real app + PGlite + CSV source
npm test
```

### Against Supabase and Stripe

```bash
cp .env.example .env
# fill in DATABASE_URL and STRIPE_SECRET_KEY
npm run migrate
npm run seed:stripe          # optional: creates test-mode charges
npm run dev
```

```bash
curl -X POST "http://localhost:3000/sync"
curl "http://localhost:3000/revenue/summary?from=2026-07-01&to=2026-08-01"
curl "http://localhost:3000/revenue/daily?from=2026-07-01&to=2026-08-01"
curl "http://localhost:3000/revenue/unmapped?from=2026-07-01&to=2026-08-01"
```

Stripe is optional at boot: without a key the service still starts and serves revenue for already-synced sources, and `/sync?source=stripe` returns 400.

### Environment

| Variable | Notes |
| --- | --- |
| `PORT` | Render injects this |
| `DATABASE_URL` | **Supabase connection POOLER string** — see below |
| `STRIPE_SECRET_KEY` | Test-mode only; the app refuses a live key |
| `LOG_LEVEL` | default `info` |
| `PG_POOL_MAX` | default `3` |

---

## Database schema

```sql
transactions
  id                    BIGSERIAL PK
  source                TEXT        -- 'stripe' | 'ledger-csv' | …
  external_id           TEXT        -- unique only WITHIN a source
  amount_minor          BIGINT      -- integer cents; never float, never NUMERIC
  amount_refunded_minor BIGINT
  currency              TEXT        -- ISO 4217, lowercase, CHECK-enforced
  raw_status            TEXT        -- exactly what the provider said
  canonical_status      TEXT        -- CanonicalStatus, incl. 'UNKNOWN'
  occurred_at           TIMESTAMPTZ -- provider event time
  synced_at             TIMESTAMPTZ
  UNIQUE (source, external_id)

quarantined_transactions   -- unnormalizable records + reason, deduped via a
                           -- generated key, with first_seen/last_seen/seen_count
sync_state                 -- per-source watermark
schema_migrations
```

`UNIQUE (source, external_id)` is what makes sync idempotent. `external_id` alone would not do: two providers can both issue `inv_1001`.

CHECK constraints reject negative amounts, refunds exceeding the amount, and non-ISO currencies at the database boundary, so a bug in an adapter cannot quietly produce impossible rows.

Migrations run automatically at boot (`CREATE ... IF NOT EXISTS`, tracked in `schema_migrations`), which keeps a Render free-tier deploy to one step.

---

## Deployment (Render free tier)

`render.yaml` is a Blueprint — point Render at the repo, then set `DATABASE_URL` and `STRIPE_SECRET_KEY` in the dashboard.

Free-tier realities this is built around:

- **Use the Supabase connection pooler.** `DATABASE_URL` must be the `aws-0-<region>.pooler.supabase.com` string, **not** `db.<ref>.supabase.co`. Render's free egress cannot reliably reach the direct host over IPv6, and the failure looks like a generic connection timeout. This is the most likely thing to cost you an hour.
- **Small pool.** `PG_POOL_MAX=3`. The Supabase pooler plus a free Render instance will not tolerate more.
- **Cold starts.** The instance spins down when idle; the first request takes ~50s. `/health` is a cheap warm-up.
- **`/sync` is incremental and page-capped** (10 pages default) so it finishes well inside Render's request timeout instead of trying to backfill all history in one HTTP call.
- **Supabase pauses a free project after ~7 days idle.** If `/health` reports `"db": "unavailable"`, un-pause it in the Supabase dashboard.

---

## Tradeoffs

**Partial refunds are not netted.** `amount_refunded_minor` is stored, so the data supports it; the calculation doesn't do it in v1. Netting changes what the number means, and I'd rather state the definition than quietly pick one.

**No FX conversion.** Revenue is per-currency. A blended total needs a rate source and a rate-as-of policy — more drift surface than this problem calls for, and a wrong blended number is worse than three right ones.

**`canonical_status` is materialized at ingest.** This buys exact SQL-side aggregation in a single query path. It costs flexibility: changing a mapping requires a backfill (`UPDATE transactions SET canonical_status = … WHERE source = … AND raw_status = …`). The vocabulary snapshot test makes such a change deliberate.

**UTC only, no per-tenant timezone.** Making the bucketing timezone a parameter is a clean extension, but the agreement guarantee only holds if both views receive the same value — so it would have to be threaded through `parseRange`, not added at the query.

**The second source is fixture-backed, not a second live sandbox.** It demonstrates vocabulary normalization — the actual requirement — without a second account's setup cost, and it lets the fixture be deliberately hostile (mixed casing, an amount above `Number.MAX_SAFE_INTEGER`, an unmappable status, a row that must be quarantined). The adapter interface is identical, so a real provider is a drop-in.

**`occurred_at` is provider-reported, not ingest time.** Correct for a revenue metric — a charge belongs to the day it happened — but it means late-arriving data changes historical totals. The number is not append-only, and that is the right call for accuracy over stability.

**Tests use PGlite rather than a Postgres container.** The repository's SQL runs unmodified, so `date_trunc`, `ANY($1::text[])`, `BIGINT` arithmetic and the CHECK constraints are genuinely exercised with no Docker and no credentials in CI. The gap: PGlite is single-connection, so it does not exercise real pooler behaviour or concurrency.

**No auth.** Out of scope for the assignment; `/sync` is an unauthenticated mutating endpoint and would need a token before this went anywhere real.

**`SUM` over `BIGINT` returns `NUMERIC` in Postgres**, cast to `TEXT` and parsed as `BigInt`. It cannot overflow at realistic volumes; a single `amount_minor` near the `BIGINT` ceiling summed many times could, and would surface as a `BigInt` parse error rather than a wrong number.

---

## Sources & references

- [Stripe API — Charges](https://docs.stripe.com/api/charges) — chose Charges over PaymentIntents for the richer status vocabulary; `amount` is already integer minor units
- [Stripe API — pagination](https://docs.stripe.com/api/pagination) — `has_more` / `starting_after`; list endpoints return 10 records without it
- [Stripe — test cards and tokens](https://docs.stripe.com/testing) — `tok_visa`, `tok_chargeDeclined` for deterministic seed outcomes
- [Stripe — refunds](https://docs.stripe.com/api/refunds) — confirmed a fully refunded charge keeps `status: "succeeded"`, which drove the effective-status handling
- [Supabase — connecting to your database](https://supabase.com/docs/guides/database/connecting-to-postgres) — pooler vs direct connection; the IPv6 constraint on platforms like Render
- [Render — free tier / spin-down behaviour](https://render.com/docs/free) and [Blueprints](https://render.com/docs/infrastructure-as-code)
- [node-postgres — data types](https://node-postgres.com/features/types) — why `INT8` arrives as a string and needs an explicit type parser
- [PostgreSQL — `date_trunc` and `AT TIME ZONE`](https://www.postgresql.org/docs/current/functions-datetime.html) and [generated columns](https://www.postgresql.org/docs/current/ddl-generated-columns.html) (quarantine dedupe key)
- [PostgreSQL — `INSERT ... ON CONFLICT`](https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT) — also the reason inserted/updated aren't reported separately (the `xmax` trick adds fragility for no analytic value)
- [PGlite](https://pglite.dev/docs/) — real Postgres in WASM, for credential-free tests
- Libraries: `express`, `pg`, `stripe`, `zod`, `pino` / `pino-http`, `vitest`, `tsx`, `typescript`

---

## AI usage

This project was built with **Claude (Claude Code)**, used heavily and throughout.

**How it was used.** I wrote the problem statement and an initial plan, then had Claude critique the plan before any code existed. That review is where most of the value was: it caught that multi-source support had been demoted to a stretch goal when it's the premise of the assignment; that "one implementation, one source of truth" was an intention with no enforcement mechanism; that `NUMERIC` + JavaScript summing would drift and that `pg` returns `NUMERIC` as a string; that summing across currencies produces a meaningless number; that timezone-naive timestamps would let the two views disagree at day boundaries; and that putting `GROUP BY` in the repository while filtering statuses in the service would put the allow-list in two places — the exact drift the assignment is about. The plan was rewritten against those findings, then implemented.

**How output was reviewed.** Everything was checked by running it. Two defects surfaced that way and were fixed:

1. The drift guard's first version flagged the source adapters, because mapping `paid → COLLECTED` matched a rule meant to catch second implementations. The rules were split so adapters may *declare* vocabulary but nothing may *read* the allow-list — the distinction the guard actually cares about.
2. Sync was idempotent for transactions but **not** for quarantine: re-running duplicated `quarantined_transactions` rows unboundedly. Caught by reading the demo output, not by a test. Fixed with a generated dedupe key plus `seen_count`, and a regression test added.

A first-draft assertion also claimed `Number(x)` would preserve a value above `Number.MAX_SAFE_INTEGER`; it wouldn't, and the test now asserts the collapse explicitly to demonstrate why the `BigInt` comparison is the meaningful one.

**Chat history:** _(paste your Claude conversation share link here)_
