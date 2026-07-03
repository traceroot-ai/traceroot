# Public SQL Gateway — ClickHouse operational runbook

Provisioning for the read-only SQL gateway DB layer (Issue 4). Commands below are the
forms proven against the pinned ClickHouse **24.3.18.7** during the Issue 0 spike.

> **Tenant isolation is application-enforced.** DB grants do **not** restrict which
> `project_id` a caller passes to a curated view — a holder of the view grant can call
> `spans_public_v1(project_id = '<any>')`. The application MUST bind the *authenticated*
> `project_id` into the view call. At the DB layer the read-only user is denied the raw
> physical tables, other application databases, and — via access-management grants — most
> `system.*` tables. But ClickHouse still exposes some system metadata (e.g. `system.settings`,
> `system.functions`, `system.databases`) to any user for query processing, so the gateway's
> SQL validator must reject **all** `system.*` references (the SQL validator, Issue 2); do not
> rely on DB grants alone to hide `system.*`.

## Components

1. **Curated views** `spans_public_v1` / `traces_public_v1` — created by migration
   `006_create_public_sql_views.sql`. Parameterized on `{project_id:String}`, `SQL SECURITY
   DEFINER`, deduped after the project filter. They project curated analytical columns only
   (never `project_id`, `ch_create_time`, `ch_update_time`, or `input`/`output`/`metadata`).
2. **Scoped writer user** — the view DEFINER. Holds `SELECT` on the physical `spans`/`traces`
   tables only. NOT a superuser.
3. **Read-only user** — the identity the backend uses to run user SQL, granted `SELECT` on the
   curated views **only**. Called `sql_gateway_ro` in the examples below; set the backend's
   `CLICKHOUSE_RO_USER` / `CLICKHOUSE_RO_PASSWORD` to this user's credentials.
4. **Settings profile** — enforces the resource caps as immutable (`CONST`) settings.

## Provisioning order (run once, with an admin client)

```sql
-- 1) Scoped writer user = the view DEFINER. SELECT on the physical tables only; NOT a superuser.
--    Use a REAL secret — never no_password: this account can read raw tenant data.
CREATE USER IF NOT EXISTS sql_gateway_writer
    IDENTIFIED WITH sha256_password BY '<writer-secret>';
GRANT SELECT ON <database>.spans  TO sql_gateway_writer;
GRANT SELECT ON <database>.traces TO sql_gateway_writer;

-- 2) Apply migration 006 — it creates spans_public_v1 / traces_public_v1 with
--    DEFINER = sql_gateway_writer. MUST run AFTER step 1, or the CREATE VIEW fails
--    ("There is no user 'sql_gateway_writer'"). May be applied by an admin/deploy user
--    (it does not have to run AS the writer); the stored definer is sql_gateway_writer.
--    e.g.  goose -dir backend/db/clickhouse/migrations clickhouse "<dsn>" up

-- 3) Settings profile — caps as CONST (immutable; a readonly=1 user cannot change them).
CREATE SETTINGS PROFILE IF NOT EXISTS sql_readonly_profile SETTINGS
    readonly = 1,
    max_execution_time = 30 CONST,
    max_result_rows = 100000 CONST,
    max_result_bytes = 536870912 CONST,
    max_memory_usage = 4294967296 CONST;

-- 4) Read-only user used by the backend for user SQL (set CLICKHOUSE_RO_USER=sql_gateway_ro).
CREATE USER IF NOT EXISTS sql_gateway_ro
    IDENTIFIED WITH sha256_password BY '<ro-secret>'
    SETTINGS PROFILE 'sql_readonly_profile';

-- 5) Grant the RO user SELECT on the curated views ONLY (never the physical tables).
GRANT SELECT ON <database>.spans_public_v1  TO sql_gateway_ro;
GRANT SELECT ON <database>.traces_public_v1 TO sql_gateway_ro;
```

## DEFINER: explicit scoped writer

Migration 006 sets the view definer **explicitly** to `sql_gateway_writer`:

```sql
CREATE OR REPLACE VIEW spans_public_v1
    DEFINER = sql_gateway_writer SQL SECURITY DEFINER AS ...
```

- **`sql_gateway_writer` MUST exist before migration 006 runs** (provisioning step 1). If it
  does not, `CREATE VIEW` fails with `There is no user 'sql_gateway_writer'`. This makes the
  security dependency explicit and enforced instead of silently defaulting to whoever applies
  the migration.
- The migration **may be applied by an admin/deploy user** — it does not have to run *as*
  `sql_gateway_writer` — provided that user has permission to create a view with a different
  definer (admins do). The stored definer is `sql_gateway_writer` regardless of who runs the DDL.
- `sql_gateway_writer` is a **dedicated, non-superuser role** holding only `SELECT` on the
  physical `spans`/`traces` tables. `sql_gateway_ro` holds `SELECT` on the curated
  `*_public_v1` views **only** (never the physical tables); it reads the views because the
  view body runs under the writer's privileges.

Verify:

```sql
SHOW CREATE VIEW <database>.spans_public_v1;
--   expect: DEFINER = sql_gateway_writer SQL SECURITY DEFINER
-- RO user can read the view but NOT the physical table:
--   SELECT 1 FROM <database>.spans_public_v1(project_id = 'x')   -> ok
--   SELECT 1 FROM <database>.spans                               -> ACCESS_DENIED (Code 497)
```

> **Verified on ClickHouse 24.3.18.7** (`scripts/spikes/clickhouse_public_views_ddl_check.sh`):
> after creating `sql_gateway_writer` (SELECT on physical tables), applying migration 006's
> `Up` DDL stores `DEFINER = sql_gateway_writer SQL SECURITY DEFINER`; parameterization
> (`WHERE project_id = {project_id:String}`) is preserved; the RO user reads the view but is
> denied the physical table (Code 497); and a foreign `project_id` returns that project's rows
> — the DB has no tenant-choice backstop, so the application must bind the authenticated
> `project_id`.

## Backend behavior

- Set `CLICKHOUSE_RO_USER` / `CLICKHOUSE_RO_PASSWORD`. `get_readonly_clickhouse_client()` uses
  them. If unset: **fatal in cloud** (`ENABLE_BILLING` != `false`); **warn + fall back to the
  default client** on local/dev/self-host.
- Under `readonly = 1`, the RO user cannot apply per-query `SETTINGS`. `SqlQueryService`
  (Issue 5) therefore relies on the profile for caps and applies row limits via a `LIMIT`
  wrapper in the SQL text, never via per-query settings.
