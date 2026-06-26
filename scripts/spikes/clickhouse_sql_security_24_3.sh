#!/usr/bin/env bash
# clickhouse_sql_security_24_3.sh
#
# Re-runnable spike: ClickHouse 24.3 SQL SECURITY / DEFINER + parameterized views.
# Idempotent: drops and recreates the `spike` database, users, and profiles on each run.
#
# Prerequisites:
#   docker container named `ch_sql_spike` running clickhouse/clickhouse-server:24.3
#   Ports: HTTP localhost:18123, native localhost:19000
#
# Usage:
#   bash scripts/spikes/clickhouse_sql_security_24_3.sh

set -euo pipefail

CH="docker exec ch_sql_spike clickhouse-client"

sep() { echo; echo "===================================================="; echo "  $*"; echo "===================================================="; }

# --- Assertion helpers: a security spike must FAIL LOUDLY, never print PASS unconditionally ---

# expect_deny "label" <cmd...> : PASS only if the command exits non-zero (access denied / error).
# Fails the whole script (exit 1) if the command unexpectedly SUCCEEDS.
expect_deny() {
  local label="$1"; shift
  local out
  if out=$("$@" 2>&1); then
    echo "FAIL [$label]: command unexpectedly SUCCEEDED (expected access-denied):"
    printf '%s\n' "$out" | head -3
    exit 1
  fi
  echo "PASS [$label]: denied as expected -> $(printf '%s' "$out" | head -1)"
}

# expect_timeout "label" <cmd...> : PASS only if the command fails specifically with a timeout.
# Fails if the query succeeds (cap did not fire) OR fails for some other reason.
expect_timeout() {
  local label="$1"; shift
  local out
  if out=$("$@" 2>&1); then
    echo "FAIL [$label]: query unexpectedly SUCCEEDED — resource cap did NOT fire:"
    printf '%s\n' "$out" | head -3
    exit 1
  fi
  if ! printf '%s' "$out" | grep -qiE 'TIMEOUT_EXCEEDED|Code: 159'; then
    echo "FAIL [$label]: failed but NOT with a timeout (cap may not be the cause):"
    printf '%s\n' "$out" | head -3
    exit 1
  fi
  echo "PASS [$label]: cap fired -> $(printf '%s' "$out" | grep -iE 'TIMEOUT_EXCEEDED|Code: 159' | head -1)"
}

# expect_empty "label" <cmd...> : PASS only if the command succeeds AND returns no rows.
# Fails if it errors, or if it returns any output (possible tenant leak).
expect_empty() {
  local label="$1"; shift
  local out
  if ! out=$("$@" 2>&1); then
    echo "FAIL [$label]: command errored unexpectedly:"
    printf '%s\n' "$out" | head -3
    exit 1
  fi
  if [ -n "$out" ]; then
    echo "FAIL [$label]: expected 0 rows but got output (possible leak):"
    printf '%s\n' "$out" | head -3
    exit 1
  fi
  echo "PASS [$label]: returned 0 rows as expected"
}

# expect_eq "label" "expected" <cmd...> : PASS only if the command's trimmed stdout equals expected.
expect_eq() {
  local label="$1" expected="$2"; shift 2
  local out
  if ! out=$("$@" 2>&1); then
    echo "FAIL [$label]: command errored unexpectedly:"
    printf '%s\n' "$out" | head -3
    exit 1
  fi
  if [ "$out" != "$expected" ]; then
    echo "FAIL [$label]: expected '$expected' but got '$out'"
    exit 1
  fi
  echo "PASS [$label]: got '$out' as expected"
}

# ---------------------------------------------------------------------------
# SETUP — idempotent teardown + recreate
# ---------------------------------------------------------------------------
sep "SETUP: drop and recreate spike database, users, profiles"

$CH --query "DROP DATABASE IF EXISTS spike"
$CH --query "DROP USER IF EXISTS spike_ro"          || true
$CH --query "DROP USER IF EXISTS spike_writer"      || true
$CH --query "DROP USER IF EXISTS spike_tiny_cap"    || true
$CH --query "DROP USER IF EXISTS spike_http_test"   || true
$CH --query "DROP SETTINGS PROFILE IF EXISTS spike_ro_profile"       || true
$CH --query "DROP SETTINGS PROFILE IF EXISTS spike_tiny_cap_profile" || true

$CH --query "CREATE DATABASE spike"

$CH --query "CREATE TABLE spike.spans_phys (
  project_id String, span_id String, trace_id String, name String,
  ch_update_time DateTime64(3) DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(ch_update_time)
ORDER BY (project_id, span_id)"

$CH --query "INSERT INTO spike.spans_phys (project_id,span_id,trace_id,name) VALUES
 ('proj_A','sA1','tA1','a-one'),('proj_A','sA2','tA2','a-two'),('proj_B','sB1','tB1','b-one')"

echo "SETUP OK"

# ---------------------------------------------------------------------------
# TEST 0 — Environment
# ---------------------------------------------------------------------------
sep "TEST 0: version + image"
echo "version:"
$CH --query "SELECT version()"
echo "image digest (host): sha256:85b97f63dcfff47790d26bb5d5801637aaddb2b93e5e9aee27a686c2fb2b9916"
echo "image tag: clickhouse/clickhouse-server:24.3"

# ---------------------------------------------------------------------------
# TEST 1 — Parameterized view, literal arg
# ---------------------------------------------------------------------------
sep "TEST 1: parameterized view — literal arg"

$CH --query "CREATE VIEW spike.spans_public_v1 AS
SELECT span_id, trace_id, name FROM (
  SELECT * FROM spike.spans_phys WHERE project_id = {project_id:String}
  ORDER BY ch_update_time DESC LIMIT 1 BY span_id
)"

echo "Query (expect sA1, sA2 — no sB1):"
$CH --query "SELECT span_id FROM spike.spans_public_v1(project_id = 'proj_A') ORDER BY span_id"

# ---------------------------------------------------------------------------
# TEST 2 — Bound parameter inside the view call
# ---------------------------------------------------------------------------
sep "TEST 2: bound parameter inside view call (--param_ form)"

echo "Query with --param_scope_project_id=proj_A (expect sA1, sA2):"
docker exec ch_sql_spike clickhouse-client \
  --param_scope_project_id=proj_A \
  --query "SELECT span_id FROM spike.spans_public_v1(project_id = {scope_project_id:String}) ORDER BY span_id"

# ---------------------------------------------------------------------------
# TEST 3 — SQL SECURITY DEFINER + parameterized view
# ---------------------------------------------------------------------------
sep "TEST 3: SQL SECURITY DEFINER on parameterized view"

$CH --query "CREATE VIEW spike.spans_definer_v1
  DEFINER = default SQL SECURITY DEFINER AS
SELECT span_id, trace_id, name FROM (
  SELECT * FROM spike.spans_phys WHERE project_id = {project_id:String}
  ORDER BY ch_update_time DESC LIMIT 1 BY span_id
)"

echo "SHOW CREATE VIEW (expect DEFINER = default SQL SECURITY DEFINER in output):"
$CH --query "SHOW CREATE VIEW spike.spans_definer_v1"

# ---------------------------------------------------------------------------
# TEST 4 — Read-only user + grants (hardened model)
# ---------------------------------------------------------------------------
sep "TEST 4: read-only user, settings profile, grants"

$CH --query "CREATE SETTINGS PROFILE spike_ro_profile SETTINGS
  readonly = 1,
  max_execution_time = 30 CONST,
  max_result_rows = 100000 CONST,
  max_result_bytes = 536870912 CONST,
  max_memory_usage = 4294967296 CONST"

$CH --query "CREATE USER spike_ro IDENTIFIED WITH no_password SETTINGS PROFILE 'spike_ro_profile'"

$CH --query "GRANT SELECT ON spike.spans_definer_v1 TO spike_ro"

echo ""
echo "--- 4a: spike_ro reads definer view (expect sA1, sA2 — DEFINER lets view body read physical table) ---"
docker exec ch_sql_spike clickhouse-client --user spike_ro \
  --query "SELECT span_id FROM spike.spans_definer_v1(project_id = 'proj_A') ORDER BY span_id"

echo ""
expect_deny "4b: spike_ro reads physical table" \
  docker exec ch_sql_spike clickhouse-client --user spike_ro \
  --query "SELECT * FROM spike.spans_phys LIMIT 1"

echo ""
expect_deny "4c: spike_ro INSERT into physical table" \
  docker exec ch_sql_spike clickhouse-client --user spike_ro \
  --query "INSERT INTO spike.spans_phys (project_id,span_id,trace_id,name) VALUES ('proj_C','sC1','tC1','c-one')"

echo ""
echo "--- 4d: spike_ro system.tables (expect only granted objects visible) ---"
docker exec ch_sql_spike clickhouse-client --user spike_ro \
  --query "SELECT database, name FROM system.tables ORDER BY database, name"

echo ""
expect_deny "4d: spike_ro system.clusters" \
  docker exec ch_sql_spike clickhouse-client --user spike_ro \
  --query "SELECT * FROM system.clusters LIMIT 1"

# ---------------------------------------------------------------------------
# TEST 5 — Tenant isolation
# ---------------------------------------------------------------------------
sep "TEST 5: tenant isolation"

echo "--- 5a: flat query proj_A (expect only sA1, sA2) ---"
docker exec ch_sql_spike clickhouse-client --user spike_ro \
  --query "SELECT span_id FROM spike.spans_definer_v1(project_id = 'proj_A') ORDER BY span_id"

echo ""
echo "--- 5b: CTE query proj_A (expect only sA1, sA2) ---"
docker exec ch_sql_spike clickhouse-client --user spike_ro \
  --query "WITH v AS (SELECT span_id FROM spike.spans_definer_v1(project_id = 'proj_A'))
           SELECT span_id FROM v ORDER BY span_id"

echo ""
expect_empty "5c: forged quote injection returns no rows (no proj_B leak)" \
  docker exec ch_sql_spike clickhouse-client \
  --param_pid="proj_A' OR project_id='proj_B" \
  --query "SELECT span_id FROM spike.spans_definer_v1(project_id = {pid:String}) ORDER BY span_id"

echo ""
expect_empty "5d: forged semicolon-DROP injection returns no rows" \
  docker exec ch_sql_spike clickhouse-client \
  --param_pid="proj_A'); DROP TABLE spike.spans_phys; --" \
  --query "SELECT span_id FROM spike.spans_definer_v1(project_id = {pid:String}) ORDER BY span_id"

echo ""
expect_eq "5d: physical table survived injection attempt" "3" \
  docker exec ch_sql_spike clickhouse-client --query "SELECT count(*) FROM spike.spans_phys"

# ---------------------------------------------------------------------------
# TEST 6 — Resource caps / profile
# ---------------------------------------------------------------------------
sep "TEST 6: resource caps / readonly profile"

expect_deny "6a: spike_ro raises max_execution_time (readonly blocks it)" \
  docker exec ch_sql_spike clickhouse-client --user spike_ro \
  --query "SELECT span_id FROM spike.spans_definer_v1(project_id = 'proj_A') ORDER BY span_id SETTINGS max_execution_time = 99999"

echo ""
expect_deny "6b: spike_ro sets more-restrictive max_result_rows (readonly blocks any SETTINGS)" \
  docker exec ch_sql_spike clickhouse-client --user spike_ro \
  --query "SELECT span_id FROM spike.spans_definer_v1(project_id = 'proj_A') ORDER BY span_id SETTINGS max_result_rows = 1"

echo ""
echo "--- 6c: CONST cap fires in practice (spike_tiny_cap: max_execution_time=0.001) ---"
$CH --query "CREATE SETTINGS PROFILE spike_tiny_cap_profile SETTINGS
  readonly = 1, max_execution_time = 0.001 CONST"
$CH --query "CREATE USER spike_tiny_cap IDENTIFIED WITH no_password SETTINGS PROFILE 'spike_tiny_cap_profile'"
$CH --query "GRANT SELECT ON spike.spans_definer_v1 TO spike_tiny_cap"

expect_timeout "6c: tiny-cap profile aborts the query" \
  docker exec ch_sql_spike clickhouse-client --user spike_tiny_cap \
  --query "SELECT span_id FROM spike.spans_definer_v1(project_id = 'proj_A') ORDER BY span_id"

# ---------------------------------------------------------------------------
# TEST 8 — DEFINER with a SCOPED (non-superuser) writer user
# ---------------------------------------------------------------------------
sep "TEST 8: DEFINER = scoped writer user (not superuser)"
$CH --query "CREATE USER IF NOT EXISTS spike_writer IDENTIFIED WITH no_password"
$CH --query "GRANT SELECT ON spike.spans_phys TO spike_writer"   # writer scoped to the physical table only
$CH --query "CREATE OR REPLACE VIEW spike.spans_definer_scoped_v1 DEFINER = spike_writer SQL SECURITY DEFINER AS
SELECT span_id, trace_id, name FROM (
  SELECT * FROM spike.spans_phys WHERE project_id = {project_id:String}
  ORDER BY ch_update_time DESC LIMIT 1 BY span_id )"
$CH --query "GRANT SELECT ON spike.spans_definer_scoped_v1 TO spike_ro"
echo "RO reads scoped-writer DEFINER view (expect sA1, sA2):"
docker exec ch_sql_spike clickhouse-client --user spike_ro \
  --query "SELECT span_id FROM spike.spans_definer_scoped_v1(project_id = 'proj_A') ORDER BY span_id"
expect_deny "8: scoped writer denied system.clusters" \
  docker exec ch_sql_spike clickhouse-client --user spike_writer \
  --query "SELECT count() FROM system.clusters"

# ---------------------------------------------------------------------------
# TEST 9 — Cross-tenant view call has NO DB-layer deny (gateway-only isolation)
# ---------------------------------------------------------------------------
sep "TEST 9: RO calls view with FOREIGN project_id (DB has no deny — proves gateway-only isolation)"
echo "RO calls spans_definer_v1(project_id='proj_B') — returns sB1 (NO DB backstop):"
docker exec ch_sql_spike clickhouse-client --user spike_ro \
  --query "SELECT span_id FROM spike.spans_definer_v1(project_id = 'proj_B') ORDER BY span_id"
echo "(sB1 above = expected: tenant isolation is enforced by the gateway rewriter, not the DB)"

# ---------------------------------------------------------------------------
# TEST 10 — Broader system.* sweep as RO (establish validator coverage)
# ---------------------------------------------------------------------------
sep "TEST 10: system.* readability as RO (validator must reject all of these)"
for t in processes query_log text_log settings functions databases users grants merges parts; do
  echo "--- system.$t (count, or EXPECTED-DENY) ---"
  { docker exec ch_sql_spike clickhouse-client --user spike_ro \
      --query "SELECT count() FROM system.$t" 2>&1 | head -1; } || true
done

# ---------------------------------------------------------------------------
# TEST 11 — View chaining / nested DEFINER + parameterized view
# ---------------------------------------------------------------------------
sep "TEST 11: nested DEFINER view selecting from another parameterized view"
$CH --query "CREATE OR REPLACE VIEW spike.spans_chain_v1 DEFINER = default SQL SECURITY DEFINER AS
SELECT span_id FROM spike.spans_definer_v1(project_id = {project_id:String})"
$CH --query "GRANT SELECT ON spike.spans_chain_v1 TO spike_ro"
echo "RO reads chained view (expect sA1, sA2 — param passes through the chain):"
docker exec ch_sql_spike clickhouse-client --user spike_ro \
  --query "SELECT span_id FROM spike.spans_chain_v1(project_id = 'proj_A') ORDER BY span_id"

sep "ALL TESTS COMPLETE"
