-- SQL Gateway user provisioning — compose/dev bootstrap.
--
-- Idempotent. The `clickhouse-init` compose service pipes this through
-- clickhouse-client BEFORE `migrate-clickhouse` runs, because migration 006
-- creates the public views with `DEFINER = sql_gateway_writer`. ClickHouse
-- resolves that DEFINER at CREATE VIEW time, so the user MUST exist first or
-- `goose up` fails with "There is no user 'sql_gateway_writer'".
--
-- Grants here are NAME-BASED: ClickHouse records them even when the target
-- table/view does not exist yet (verified on 24.3.18.7), so this whole script
-- safely runs before the migrations create the physical tables and the views.
--
-- DEV / self-host-compose ONLY: these accounts use `no_password`, matching this
-- stack's posture (the ClickHouse superuser here is also a weak default). REAL
-- deployments (Helm/cloud) MUST provision these with actual secrets via a
-- different mechanism — see backend/db/clickhouse/SQL_GATEWAY_RUNBOOK.md
-- ("Staging / production (Helm)").
--
-- Assumes the compose database `default` (migrate-clickhouse connects to /default).

-- 1) Scoped writer = the view DEFINER. SELECT on the physical tables only; NOT a superuser.
CREATE USER IF NOT EXISTS sql_gateway_writer IDENTIFIED WITH no_password;
GRANT SELECT ON default.spans  TO sql_gateway_writer;
GRANT SELECT ON default.traces TO sql_gateway_writer;

-- 2) Read-only caps as CONST (immutable; a readonly=1 user cannot change them).
CREATE SETTINGS PROFILE IF NOT EXISTS sql_readonly_profile SETTINGS
    readonly = 1,
    max_execution_time = 30 CONST,
    max_result_rows = 100000 CONST,
    max_result_bytes = 536870912 CONST,
    max_memory_usage = 4294967296 CONST;

-- 3) Read-only gateway user: reads the curated views ONLY (never the physical tables).
CREATE USER IF NOT EXISTS sql_gateway_ro
    IDENTIFIED WITH no_password
    SETTINGS PROFILE 'sql_readonly_profile';
GRANT SELECT ON default.spans_public_v1  TO sql_gateway_ro;
GRANT SELECT ON default.traces_public_v1 TO sql_gateway_ro;
