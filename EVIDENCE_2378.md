# Issue #2378 — Local Deployment Verification Report

**Date:** 2026-09-28
**Engineer:** Raviteja (verification executed by Muse, local sandbox)
**Scope:** TraceRoot.AI `traceroot` repo — ingest-time `error_type` extraction for dashboard error breakdowns

---

## 1. Environment (how a real dev setup was reproduced)

Docker **was** brought up in this sandbox (static binaries, v27.3.1, daemon running —
`docker info` reports Server Version 27.3.1). Two hard sandbox limits stopped a full
`docker compose up`:
- **Registry pulls fail:** the daemon does not honor the sandbox's egress proxy, so
  `docker pull` times out on TLS handshake to `registry-1.docker.io`. No upstream
  image (postgres, redis, minio) could be fetched.
- **Container execution is blocked:** the sandbox kernel denies the `sysfs` mount
  that `runc` requires for *every* container (`docker run` and build `RUN` steps
  both fail with `operation not permitted`). `COPY`-only builds work — and one was
  done: **`local-clickhouse:26.10`, built from the exact official ClickHouse
  26.10.1.1 binary used for this verification.**

So the database ran as that same native binary (the precise thing the image
contains) — same code paths, no mocks:

| Component | How it ran |
|---|---|
| ClickHouse 26.10.1.1 | Official standalone binary (`builds.clickhouse.com`), local server on :8123/:9000 |
| Migrations 001–013 | Repo's own goose SQL files, applied with a small runner that splits `-- +goose Up` and feeds it to `clickhouse-client --multiquery` |
| Bootstrap | `sql_gateway_writer` user provisioned from `backend/db/clickhouse/bootstrap/sql_gateway_users.sql` (required before migration 012, per the file's own docs) |
| Ingest path | **Real code, not stubs:** `transform_otel_to_clickhouse` → `ClickHouseClient.insert_spans_batch` via `clickhouse_connect`, from the repo's `uv sync` venv |
| BEFORE code | Pristine upstream files extracted from the release tarball, loaded via importlib (the venv's editable installs would otherwise shadow `sys.path` — documented gotcha) |
| AFTER code | Working tree with the fix |

Test data: 10 OTLP spans per run — 3× `ValueError`, 2× `TypeError`, 1× ERROR with no exception event, 4× OK.

---

## 2. Root-cause analysis — why this issue happened in the first place

**The data was discarded at the ingest boundary, and that is the only place it ever existed.**

1. **OTel records exceptions as span *events*, not attributes.** When an exception is
   raised, every OTel SDK appends a span event named `"exception"` carrying
   `exception.type` (the class name) and `exception.message`. It does *not* put the
   exception type in the span's attributes or status fields.
2. **TraceRoot's transform is an attribute→column mapper that never looked at events.**
   Verified against pristine upstream code: `backend/worker/otel_transform.py`
   (1,305 lines) contains **zero** references to span events — it maps attributes,
   status, kind, and resource attributes to columns, and silently drops the
   `events` array. So `exception.type` was thrown away at the exact choke point
   where it was still available. Once the row is written, the information is gone
   forever — no query, widget, or frontend change can recover it.
3. **The dashboard is strictly column-bound.** The widget registry only permits
   grouping/filtering on real ClickHouse columns. `status` (OK/ERROR) was the only
   error signal ever columnized, so the dashboard could *count* errors but never
   *classify* them. This is why the issue is an ingest/schema problem, not a UI
   problem.

**Why the fix addresses the root cause instead of papering over it:**

- It captures the exception type **at the ingest boundary** — the single place the
  event data still exists. Any fix applied later in the pipeline is impossible by
  construction.
- It records the SDK-provided exception type verbatim at write time (plain
  `String` column, stored unnormalized — e.g. `builtins.ValueError` stays
  fully qualified. `LowCardinality(String)` was tried first, but the SQL
  Gateway contract check in CI requires `String`, matching `status`; there is
  no `LowCardinality` anywhere else in the spans table. A reply confirming
  the change was posted to the review thread), so dashboards never enumerate
  raw error strings at query time. This follows the repo's own established
  patterns (migrations 006/008 for additive columns, in-place projection
  rebuild).
- It flows through the **standard widget path** — transform → insert client →
  migration → widget registry → filter columns → OpenAPI → regenerated frontend
  snapshot. The dashboard needs zero special-casing: `breakdown: "error_type"` is
  just another dimension, groupable and filterable like `status`.
- **Alternatives considered and rejected:** parsing `status_message` (free-text,
  inconsistent across SDKs, unbounded cardinality); stuffing the type into
  `metadata` (stringly-typed, not groupable through the registry); query-time
  extraction (impossible — the data was never stored).
- The `"unknown"` bucket for ERROR spans with no exception event is deliberate: it
  keeps the error-rate total and the by-type total in agreement (6 == 3+2+1), which
  is the spec's key invariant.

---

## 3. BEFORE (migrations 001–012, pristine code)

**Schema:** `error_type` does not exist (`system.columns` → 0 rows).

**Ingest:** 10 rows inserted. Transform emitted no `error_type` key — the OTel `exception` events were discarded at ingest, exactly as the issue states.

**Dashboard capability:**
- Error breakdown query → **fails**: `Code: 47. UNKNOWN_IDENTIFIER — Unknown expression identifier 'error_type'`
- The only thing the dashboard could show: error *rate* via `status` → `6 errors / 10 total = 60%`

Conclusion: issue reproduced end-to-end against real infrastructure. A widget could show *how often* errors happen, never *what kind*.

---

## 4. AFTER (migration 013 applied, fixed code)

**Migration:** applied cleanly, instant (metadata-only, empty-table instant; production tables get the same property because the column stays out of ORDER BY / PARTITION BY).

**Schema:** `error_type String DEFAULT ''` (plain `String`, per the SQL Gateway
contract — see note in §2). Projection `spans_no_io_by_start_time` rebuilt in
place — `error_type` added to its SELECT, ORDER BY untouched
(`project_id, span_start_time, trace_id, span_id`).

**Backfill:** the 10 pre-existing rows read back as `''` — no rewrite, no nulls, per spec.

**Ingest:** transform emitted `['ValueError', 'ValueError', 'ValueError', 'TypeError', 'TypeError', 'unknown']` for the six error spans; `''` for the four OK spans.

**Dashboard capability — the widget query now works:**
```
ValueError    3
TypeError     2
unknown       1
```

**Consistency (the spec's key invariant):** error-rate total (6) == by-type total (3+2+1 = 6). ✅

**Real widget path:** rendered the actual `_SPANS_BASE` SQL from `widget_registry.py` (with `customer_traffic_only()` and bound params) + `GROUP BY error_type` — returned the breakdown correctly.

**Projection eligibility:** `EXPLAIN` on the time-window aggregate shows `error_type` queries behave identically to `status` queries (both `Read type: Default` at this 20-row scale — the optimizer correctly skips projections on tiny tables). No regression; `error_type` is carried by the projection so eligibility is preserved by construction.

**Rollback:** migration Down applied cleanly — column dropped, projection restored to the 008 definition, breakdown query fails again with `UNKNOWN_IDENTIFIER` (proving the Down is a true inverse). Up re-applied afterwards.

**Test suites:** 729 passed, 0 failed (`tests/worker`, widget registry + parity, migration guards). `ruff check` and `ruff format --check` clean. `sync_public_openapi.py --check` confirms `public.json` and the frontend registry snapshot are in sync.

---

## 5. Live API before/after — the exact endpoint the dashboard calls

Two real FastAPI servers (repo's `uvicorn` app, JWT auth, same ClickHouse, same
10-span fixture), served side by side — **BEFORE = pristine upstream code**
(`:8101`), **AFTER = patched code** (`:8102`). Same project, same time window.

| Request | BEFORE (pristine) | AFTER (patched) |
|---|---|---|
| `GET …/widgets/schema` | 200 — `spans` view fields have **no** `error_type` | 200 — fields **include** `error_type` |
| `POST …/widgets/query` `{breakdown: "error_type"}` | **422** — `Unknown field 'error_type'` (the exact user-facing error) | **200** — `rows: [["ValueError",3],["TypeError",2],["unknown",1]]` |
| `POST …/widgets/query` (total count, no breakdown) | 200 — `[[10]]` | 200 — `[[10]]` (totals unchanged by the fix) |

Visual: `evidence/before_after_2378.png` — both panels hit the real widget-query
endpoint; the bar chart is rendered directly from the live 200 OK response rows.
Cross-check: 3 + 2 + 1 = 6 errors, matching the total error count the old
dashboard could already show — the fix adds the breakdown without changing totals.

---

## 6. What the work changed (for the PR)

| File | Change |
|---|---|
| `backend/worker/otel_transform.py` | New `_extract_error_type()`: reads span `events`, takes `exception.type` from the first `exception` event; ERROR w/o event → `"unknown"`; OK → `""` |
| `backend/db/clickhouse/client.py` | `error_type` added to `insert_spans_batch` row values + explicit `column_names` (without this the transform change never reaches the table — found only by reading the real code) |
| `backend/db/clickhouse/migrations/013_add_error_type_column.sql` | Metadata-only `ADD COLUMN` + in-place projection rebuild; reversible Down |
| `backend/rest/services/widget_registry.py` | `"error_type": _string_dim("Error type")` (groupable, `=`/`contains`); column added to `_SPANS_BASE` inner + outer SELECTs (enforced by drift test) |
| `backend/rest/services/filters/columns.py` | Matching `FilterColumn` (categorical, IN, distinct-value suggestions) |
| `backend/rest/openapi/public.json`, `frontend/.../widget-registry.generated.json` | Regenerated via repo script (no hand-written frontend changes) |
| `tests/worker/test_otel_transform.py`, `tests/fixtures/otel_payloads.py` | 8 new unit tests + `events`/`make_exception_event` fixture support |

---

## 7. Scope for improvement (honest findings from verification)

1. **Empty bucket on historical data.** Pre-013 rows backfill to `''`, so a naive `GROUP BY error_type` widget shows an empty-string bucket for all old errors. Recommend the widget default to `error_type != ''` or the frontend hide empty buckets. Worth one line in the PR description.
2. **`unknown` bucket semantics.** ERROR spans with no exception event land in `"unknown"` — correct per spec and keeps totals consistent, but on SDKs that don't record exception events this bucket could dominate. Worth monitoring after rollout, not a code change.
3. **Only the first exception event is kept.** Chained exceptions (`__cause__` recorded as multiple events) lose the root cause. Spec says first-wins; fine, but flag it if a maintainer asks.
4. **`exception.type` is stored verbatim — SDK-provided and unnormalized.**
   Python OTel sends bare class names (`ValueError`); some SDKs send
   fully-qualified names (`builtins.ValueError`), and `_extract_error_type`
   preserves whatever the SDK sent. A normalization step (e.g. stripping the
   module prefix) could be proposed as follow-up if dashboards look noisy.
5. **Rollback drops data.** `DROP COLUMN` in the Down migration discards all extracted values — inherent to ClickHouse, acceptable, but call it out in the PR so reviewers know rollback is lossy for this column.
6. **Not verified here:** full `docker-compose` stack (daemon runs and a ClickHouse
   image was built, but this sandbox's kernel blocks container execution and its
   egress proxy isn't honored for registry pulls — documented in §1), actual
   dashboard rendering, and the S3 backfill (explicitly out of scope per the issue).

---

## 8. Verdict

The fix is verified working end-to-end against a real ClickHouse with the repo's real ingest code path: exception types now survive ingest, the dashboard can break errors down by type, error-rate and by-type totals agree, the migration is metadata-only and reversible, and no existing tests regress. Ready to PR with the caveats in §7 disclosed.

## §9 Code review (code-review skill, 2026-09-28)

Ran the installed `/code-review` skill: 5 parallel review agents (guideline
compliance, bug hunter, history/context, past-PR concerns, code-comment
guidance). All findings scoring ≥80 were fixed and re-verified:

- **Docstring/implementation mismatch** (`_extract_error_type`): docstring
  promised `"unknown"` only when no *usable* exception event exists, but the
  code returns `"unknown"` at the first typeless event without scanning later
  ones. Tightened the docstring to first-event-wins and added a locking test
  (`test_first_exception_event_wins_even_when_typeless`).
- **Filter-column parity**: new `error_type` column tripped two pinned
  snapshots (`MEMBERSHIP_FIELDS`, detector-trigger exclusion list) — updated
  both; the column intentionally stays out of detector triggers (span-level,
  like `status`/`name`).
- **Positional insert guards**: `test_client.py` pinned 27-wide rows — updated
  to 28 with `error_type` at offset 11, plus a value-flow assertion.
- **SQL Gateway gap (found during review)**: `error_type` was missing from the
  gateway's curated `spans` schema and from the `spans_public_v1` view (explicit
  column list). Added `PublicColumn("error_type", "String")` to `schema.py` and
  extended migration 013 with a `CREATE OR REPLACE VIEW` (Up) / exact 012
  restore (Down, byte-verified). The view-contract test now resolves the
  *effective* view definition across migrations instead of pinning 012's text.
- **Metadata-only guard**: extended the `source` guard pattern to `error_type`
  — 013's `ADD COLUMN ... DEFAULT ''` is pinned, and a new test trips if any
  migration ever puts `error_type` in a sort/partition key.

No implementation bugs found by the bug-hunter agent. Full suite:
**3028 passed, 0 failed** (167 integration skips need live env vars);
`ruff check` and `ruff format --check` clean. Note: the sandbox's proxy env
(`no_proxy` containing `[::1]`) breaks httpx client construction in ~550 auth
tests — unrelated to this change (fails identically on the pristine tree);
the suite runs green with proxy env vars unset.
