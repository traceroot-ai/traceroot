# Public SQL Gateway — ClickHouse operational runbook

Provisioning for the read-only SQL gateway DB layer (Issue 4). Commands below are the
forms proven against the pinned ClickHouse **24.3.18.7** during the Issue 0 spike.

> **Tenant isolation is application-enforced.** DB grants do **not** restrict which
> `project_id` a caller passes to a curated view — a holder of the view grant can call
> `spans_public_v1(project_id = '<any>')`. The application MUST bind the *authenticated*
> `project_id` into the view call. The DB layer only prevents access to the raw physical
> tables and to other databases/`system.*`.

## Components

1. **Curated views** `spans_public_v1` / `traces_public_v1` — created by migration
   `005_create_public_sql_views.sql`. Parameterized on `{project_id:String}`, `SQL SECURITY
   DEFINER`, deduped after the project filter. They project curated analytical columns only
   (never `project_id`, `ch_create_time`, `ch_update_time`, or `input`/`output`/`metadata`).
2. **Scoped writer user** — the view DEFINER. Holds `SELECT` on the physical `spans`/`traces`
   tables only. NOT a superuser.
3. **Read-only user** (`CLICKHOUSE_RO_USER` / `CLICKHOUSE_RO_PASSWORD`) — the identity the
   backend uses to run user SQL. Granted `SELECT` on the curated views **only**.
4. **Settings profile** — enforces the resource caps as immutable (`CONST`) settings.

## Provisioning order (run once, with an admin client)

```sql
-- 1) Scoped writer user = the view DEFINER. SELECT on the physical tables only.
CREATE USER IF NOT EXISTS sql_gateway_writer IDENTIFIED WITH no_password;  -- use a real secret in prod
GRANT SELECT ON <database>.spans  TO sql_gateway_writer;
GRANT SELECT ON <database>.traces TO sql_gateway_writer;
-- so the writer can own the views:
GRANT CREATE VIEW, DROP VIEW ON <database>.* TO sql_gateway_writer;

-- 2) Settings profile — caps as CONST (immutable; a readonly=1 user cannot change them).
CREATE SETTINGS PROFILE IF NOT EXISTS sql_readonly_profile SETTINGS
    readonly = 1,
    max_execution_time = 30 CONST,
    max_result_rows = 100000 CONST,
    max_result_bytes = 536870912 CONST,
    max_memory_usage = 4294967296 CONST;

-- 3) Read-only user used by the backend for user SQL.
CREATE USER IF NOT EXISTS <CLICKHOUSE_RO_USER> IDENTIFIED WITH ...    -- real secret
    SETTINGS PROFILE 'sql_readonly_profile';

-- 4) Grant the RO user SELECT on the curated views ONLY (never the physical tables).
GRANT SELECT ON <database>.spans_public_v1  TO <CLICKHOUSE_RO_USER>;
GRANT SELECT ON <database>.traces_public_v1 TO <CLICKHOUSE_RO_USER>;
```

## DEFINER: make the scoped writer the definer

Migration 005 sets no explicit `DEFINER`, so ClickHouse defaults the view's definer to the
user that applies the migration.

> **Verified on ClickHouse 24.3.18.7** (`scripts/spikes/clickhouse_public_views_ddl_check.sh`):
> applying the migration `Up` DDL as written and running `SHOW CREATE VIEW` reports the
> applying user as an *explicit* definer — e.g. applied as `default` it stores
> `DEFINER = default SQL SECURITY DEFINER`. The parameterization (`WHERE project_id =
> {project_id:String}`) is preserved, and a read-only user granted `SELECT` on the view only
> can read the view but is denied the physical table (Code 497). So **the migration-running
> user becomes the definer** — choose that user deliberately.

For the hardened model, the definer must be the scoped writer (step 1), **not** an
admin/superuser. Two ways:

- **Recommended:** create the writer (step 1) **before** migration 005, then apply migration
  005 as `sql_gateway_writer` (run `goose up` with that user's credentials, or execute the
  `-- +goose Up` DDL directly as that user). `SHOW CREATE VIEW spans_public_v1` should then
  read `DEFINER = sql_gateway_writer SQL SECURITY DEFINER`.
- If migrations must run as an admin user, recreate the two views as `sql_gateway_writer`
  afterward using the exact `-- +goose Up` DDL from migration 005.

Verify:

```sql
SHOW CREATE VIEW <database>.spans_public_v1;   -- expect DEFINER = sql_gateway_writer
-- RO user can read the view but NOT the physical table:
--   SELECT 1 FROM <database>.spans_public_v1(project_id = 'x')   -> ok
--   SELECT 1 FROM <database>.spans                               -> ACCESS_DENIED (Code 497)
```

## Backend behavior

- Set `CLICKHOUSE_RO_USER` / `CLICKHOUSE_RO_PASSWORD`. `get_readonly_clickhouse_client()` uses
  them. If unset: **fatal in cloud** (`ENABLE_BILLING` != `false`); **warn + fall back to the
  default client** on local/dev/self-host.
- Under `readonly = 1`, the RO user cannot apply per-query `SETTINGS`. `SqlQueryService`
  (Issue 5) therefore relies on the profile for caps and applies row limits via a `LIMIT`
  wrapper in the SQL text, never via per-query settings.
