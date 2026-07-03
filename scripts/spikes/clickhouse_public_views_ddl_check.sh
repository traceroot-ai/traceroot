#!/usr/bin/env bash
# clickhouse_public_views_ddl_check.sh
#
# Reproducible verification that migration 006 (public SQL gateway views) applies
# AS WRITTEN on ClickHouse 24.3, what SHOW CREATE VIEW reports for
# `SQL SECURITY DEFINER` with no explicit DEFINER, and that a read-only user with
# SELECT on the views only can read the views but NOT the physical tables.
#
# This is a disposable spike check (uses a throwaway `pubviews` database/user), not
# the full live security matrix. Prereq: a running container `ch_sql_spike` on
# clickhouse/clickhouse-server:24.3.
#
# Usage: bash scripts/spikes/clickhouse_public_views_ddl_check.sh

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
MIG="$ROOT/backend/db/clickhouse/migrations/006_create_public_sql_views.sql"

ch() { docker exec ch_sql_spike clickhouse-client "$@"; }
ch_ro() { docker exec ch_sql_spike clickhouse-client --user pubviews_ro "$@"; }

echo "== version =="; ch --query "SELECT version()"

echo "== teardown + setup disposable db =="
ch --query "DROP DATABASE IF EXISTS pubviews"
ch --query "DROP USER IF EXISTS pubviews_ro" || true
ch --query "DROP USER IF EXISTS sql_gateway_writer" || true
ch --query "DROP SETTINGS PROFILE IF EXISTS pubviews_ro_profile" || true
ch --query "CREATE DATABASE pubviews"

ch --query "CREATE TABLE pubviews.spans (span_id String, trace_id String, parent_span_id Nullable(String), project_id String, span_start_time DateTime64(3), span_end_time Nullable(DateTime64(3)), name String, span_kind String, status String DEFAULT 'OK', status_message Nullable(String), model_name Nullable(String), cost Nullable(Decimal64(9)), input_tokens Nullable(Int64), output_tokens Nullable(Int64), total_tokens Nullable(Int64), input Nullable(String), output Nullable(String), metadata Nullable(String), git_source_file Nullable(String), git_source_line Nullable(Int32), git_source_function Nullable(String), ch_create_time DateTime64(3) DEFAULT now64(3), ch_update_time DateTime64(3) DEFAULT now64(3), environment Nullable(String), usage_details Map(LowCardinality(String), Int64)) ENGINE=ReplacingMergeTree(ch_update_time) ORDER BY (project_id, span_kind, toDate(span_start_time), span_id)"
ch --query "CREATE TABLE pubviews.traces (trace_id String, project_id String, trace_start_time DateTime64(3), name String, user_id Nullable(String), session_id Nullable(String), git_ref Nullable(String), git_repo Nullable(String), input Nullable(String), output Nullable(String), metadata Nullable(String), ch_create_time DateTime64(3) DEFAULT now64(3), ch_update_time DateTime64(3) DEFAULT now64(3), environment Nullable(String)) ENGINE=ReplacingMergeTree(ch_update_time) ORDER BY (project_id, toDate(trace_start_time), trace_id)"

echo "== provision the scoped writer (view DEFINER) — MUST exist before the migration =="
ch --query "CREATE USER IF NOT EXISTS sql_gateway_writer IDENTIFIED WITH no_password"
ch --query "GRANT SELECT ON pubviews.spans  TO sql_gateway_writer"
ch --query "GRANT SELECT ON pubviews.traces TO sql_gateway_writer"

echo "== apply migration 006 Up section AS WRITTEN (DEFINER = sql_gateway_writer) =="
awk '/-- \+goose Up/{f=1;next} /-- \+goose Down/{f=0} f' "$MIG" \
  | docker exec -i ch_sql_spike clickhouse-client --database pubviews --multiquery
echo "migration 006 Up applied OK"

echo "== SHOW CREATE VIEW pubviews.spans_public_v1 =="
SHOW_OUT="$(ch --query "SHOW CREATE VIEW pubviews.spans_public_v1")"
printf '%s\n' "$SHOW_OUT"
printf '%s' "$SHOW_OUT" | grep -q "SQL SECURITY DEFINER" || { echo "FAIL: SQL SECURITY DEFINER missing"; exit 1; }
printf '%s' "$SHOW_OUT" | grep -q "{project_id:String}" || { echo "FAIL: parameterization lost"; exit 1; }
printf '%s' "$SHOW_OUT" | grep -q "DEFINER = sql_gateway_writer SQL SECURITY DEFINER" \
  || { echo "FAIL: expected DEFINER = sql_gateway_writer SQL SECURITY DEFINER"; exit 1; }
echo "PASS: explicit definer -> DEFINER = sql_gateway_writer SQL SECURITY DEFINER"

echo "== seed two projects =="
ch --query "INSERT INTO pubviews.spans (span_id,trace_id,project_id,span_start_time,span_end_time,name,span_kind) VALUES ('sA','tA','proj_A',toDateTime64('2026-01-01 00:00:00',3),toDateTime64('2026-01-01 00:00:02',3),'a','LLM'), ('sB','tB','proj_B',now64(3),now64(3),'b','LLM')"

echo "== read-only user: profile + view-only grants =="
ch --query "CREATE SETTINGS PROFILE pubviews_ro_profile SETTINGS readonly = 1, max_execution_time = 30 CONST, max_result_rows = 100000 CONST, max_result_bytes = 536870912 CONST, max_memory_usage = 4294967296 CONST"
ch --query "CREATE USER pubviews_ro IDENTIFIED WITH no_password SETTINGS PROFILE 'pubviews_ro_profile'"
ch --query "GRANT SELECT ON pubviews.spans_public_v1 TO pubviews_ro"
ch --query "GRANT SELECT ON pubviews.traces_public_v1 TO pubviews_ro"

echo "== RO reads the view (expect sA + duration_ms=2000) =="
RO_VIEW="$(ch_ro --query "SELECT span_id, duration_ms FROM pubviews.spans_public_v1(project_id='proj_A') ORDER BY span_id")"
printf '%s\n' "$RO_VIEW"
[ "$RO_VIEW" = $'sA\t2000' ] || { echo "FAIL: unexpected RO view result"; exit 1; }
echo "PASS: RO can read the view"

echo "== RO denied on the physical table (EXPECTED access-denied, not just any error) =="
if DENY_OUT="$(ch_ro --query "SELECT count() FROM pubviews.spans" 2>&1)"; then
  echo "FAIL: RO user could read the physical table"; exit 1
fi
printf '%s' "$DENY_OUT" | grep -qE "ACCESS_DENIED|Code: 497" \
  || { echo "FAIL: physical-table read failed but NOT with access-denied: $DENY_OUT"; exit 1; }
echo "PASS: RO denied on physical spans table (ACCESS_DENIED)"

echo "== RO isolation: a foreign project_id returns that project's rows (the DB has no backstop) =="
RO_FOREIGN="$(ch_ro --query "SELECT span_id FROM pubviews.spans_public_v1(project_id='proj_B')")"
printf '%s\n' "$RO_FOREIGN"
[ "$RO_FOREIGN" = "sB" ] || { echo "FAIL: expected proj_B row 'sB'"; exit 1; }
echo "PASS: DB returns whatever project_id is supplied -> the gateway MUST bind the authenticated project_id"

echo "== cleanup =="
ch --query "DROP DATABASE pubviews"
ch --query "DROP USER IF EXISTS pubviews_ro"
ch --query "DROP USER IF EXISTS sql_gateway_writer"
ch --query "DROP SETTINGS PROFILE IF EXISTS pubviews_ro_profile"
echo "ALL DDL CHECKS PASSED"
