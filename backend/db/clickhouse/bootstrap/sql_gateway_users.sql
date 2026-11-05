-- SQL Gateway writer provisioning, for compose.
--
-- Idempotent. The `clickhouse-init` compose service pipes this through
-- clickhouse-client BEFORE `migrate-clickhouse` runs, because migration 012
-- creates the public views with `DEFINER = sql_gateway_writer`. ClickHouse
-- resolves that DEFINER at CREATE VIEW time, so the user MUST exist first or
-- `goose up` fails with "There is no user 'sql_gateway_writer'".
--
-- Grants here are NAME-BASED: ClickHouse records them even when the target
-- table/view does not exist yet (verified on 24.3.18.7), so this whole script
-- safely runs before the migrations create the physical tables and the views.
--
-- Passwords are substituted by the `clickhouse-init` service as SHA-256 hashes:
-- `__WRITER_HASH__` and `__RO_HASH__` are placeholders, never literal values, and
-- the raw passwords never appear in this file, in the container's command line or
-- in ClickHouse's query_log. The writer holds SELECT on the PHYSICAL tables, so it
-- must never be passwordless: an account with no password there would expose every
-- project's raw rows, including the blobs the curated views deliberately omit.
-- When SQL_GATEWAY_WRITER_PASSWORD is unset, clickhouse-init generates a random one and
-- never stores it. Nothing authenticates as the writer, which exists only because the
-- views name it as their DEFINER, so the value is write-only by construction and the
-- account is still never passwordless.
--
-- The read-only gateway account is in sql_gateway_readonly.sql, provisioned only when
-- CLICKHOUSE_RO_PASSWORD is set. The writer cannot be made optional the same way:
-- migration 012 needs it whether or not anyone uses the gateway.
--
-- The database is substituted as `__DB__` by clickhouse-init from CLICKHOUSE_DATABASE,
-- the same value migrate-clickhouse targets. Hardcoding `default` here meant the grants
-- landed on a different database from the tables whenever that variable was changed.

-- 1) Scoped writer = the view DEFINER. SELECT on the physical tables only; NOT a superuser.
CREATE USER IF NOT EXISTS sql_gateway_writer IDENTIFIED WITH sha256_hash BY '__WRITER_HASH__';
ALTER USER sql_gateway_writer IDENTIFIED WITH sha256_hash BY '__WRITER_HASH__';
GRANT SELECT ON __DB__.spans  TO sql_gateway_writer;
GRANT SELECT ON __DB__.traces TO sql_gateway_writer;
