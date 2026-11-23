-- SQL Gateway read-only account provisioning, for compose.
--
-- Run by clickhouse-init after sql_gateway_users.sql, and only when CLICKHOUSE_RO_PASSWORD
-- is set. This is the account the API authenticates as to run customer SQL, so unlike the
-- writer it needs a real password and is not generated: an unset password means the
-- gateway is not in use, so the account is not created and an existing one is dropped. The API treats a
-- read-only user with no password as unconfigured, so it does not try to log in as one.
--
-- `__RO_HASH__` and `__DB__` are substituted by clickhouse-init exactly as in
-- sql_gateway_users.sql: a SHA-256 hash, never the raw password, and a database name
-- already validated as a plain identifier. Grants are name-based, so this also runs
-- before migration 012 has created the views.

-- 1) Read-only caps as CONST (immutable; a readonly=1 user cannot change them).
CREATE SETTINGS PROFILE IF NOT EXISTS sql_readonly_profile SETTINGS
    readonly = 1,
    max_execution_time = 30 CONST,
    max_result_rows = 100000 CONST,
    max_result_bytes = 536870912 CONST,
    max_memory_usage = 4294967296 CONST;

-- 2) Read-only gateway user: reads the curated views ONLY (never the physical tables).
CREATE USER IF NOT EXISTS sql_gateway_ro
    IDENTIFIED WITH sha256_hash BY '__RO_HASH__'
    SETTINGS PROFILE 'sql_readonly_profile';
ALTER USER sql_gateway_ro
    IDENTIFIED WITH sha256_hash BY '__RO_HASH__'
    SETTINGS PROFILE 'sql_readonly_profile';
GRANT SELECT ON __DB__.spans_public_v1  TO sql_gateway_ro;
GRANT SELECT ON __DB__.traces_public_v1 TO sql_gateway_ro;
