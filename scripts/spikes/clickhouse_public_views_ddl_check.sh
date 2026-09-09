#!/usr/bin/env bash
# clickhouse_public_views_ddl_check.sh
#
# Reproducible verification that migration 012 (public SQL gateway views) applies
# AS WRITTEN on ClickHouse 24.3: that SHOW CREATE VIEW records the explicit
# DEFINER = sql_gateway_writer (the migration pins it), that parameterization is
# preserved, and that a read-only user with SELECT on the views only can read the
# views but NOT the physical tables.
#
# This is a disposable verification check (uses a throwaway `pubviews` database/user), not
# the full live security matrix. Prereq: a running container named by CH_CONTAINER
# (default `ch_sql_spike`), or set CH_IMAGE to have this script start one, on
# clickhouse/clickhouse-server:24.3. Set CH_IMAGE to have this script start its own
# disposable server on that image (e.g. the build staging deploys); leave it unset to
# use an already-running container named by CH_CONTAINER.
#
# Usage: bash scripts/spikes/clickhouse_public_views_ddl_check.sh

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
MIG="$ROOT/backend/db/clickhouse/migrations/012_create_public_sql_views.sql"

# Starts its own disposable server when CH_IMAGE is set, so the check is
# reproducible against any version; otherwise it uses a container you already run.
CH_IMAGE="${CH_IMAGE:-}"
CH_CONTAINER="${CH_CONTAINER:-ch_sql_spike}"
if [ -n "$CH_IMAGE" ]; then
  docker rm -f "$CH_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CH_CONTAINER" -e ALLOW_EMPTY_PASSWORD=yes "$CH_IMAGE" >/dev/null
  trap 'docker rm -f "$CH_CONTAINER" >/dev/null 2>&1 || true' EXIT
  for _ in $(seq 1 50); do
    docker exec "$CH_CONTAINER" clickhouse-client --query "SELECT 1" >/dev/null 2>&1 && break
    sleep 3
  done
fi

ch() { docker exec "$CH_CONTAINER" clickhouse-client "$@"; }
ch_ro() { docker exec "$CH_CONTAINER" clickhouse-client --user pubviews_ro "$@"; }

echo "== version =="; ch --query "SELECT version()"

echo "== teardown + setup disposable db =="
ch --query "DROP DATABASE IF EXISTS pubviews"
ch --query "DROP USER IF EXISTS pubviews_ro" || true
ch --query "DROP USER IF EXISTS sql_gateway_writer" || true
ch --query "DROP SETTINGS PROFILE IF EXISTS pubviews_ro_profile" || true
ch --query "CREATE DATABASE pubviews"

ch --query "CREATE TABLE pubviews.spans (span_id String, trace_id String, parent_span_id Nullable(String), project_id String, span_start_time DateTime64(3), span_end_time Nullable(DateTime64(3)), name String, span_kind String, status String DEFAULT 'OK', status_message Nullable(String), model_name Nullable(String), cost Nullable(Decimal64(9)), input_tokens Nullable(Int64), output_tokens Nullable(Int64), total_tokens Nullable(Int64), input Nullable(String), output Nullable(String), metadata Nullable(String), git_source_file Nullable(String), git_source_line Nullable(Int32), git_source_function Nullable(String), ch_create_time DateTime64(3) DEFAULT now64(3), ch_update_time DateTime64(3) DEFAULT now64(3), environment Nullable(String), usage_details Map(LowCardinality(String), Int64), source LowCardinality(String) DEFAULT 'user', is_evaluation UInt8 DEFAULT 0, metadata_map Map(LowCardinality(String), String)) ENGINE=ReplacingMergeTree(ch_update_time) ORDER BY (project_id, span_kind, toDate(span_start_time), span_id)"
ch --query "CREATE TABLE pubviews.traces (trace_id String, project_id String, trace_start_time DateTime64(3), name String, user_id Nullable(String), session_id Nullable(String), git_ref Nullable(String), git_repo Nullable(String), input Nullable(String), output Nullable(String), metadata Nullable(String), ch_create_time DateTime64(3) DEFAULT now64(3), ch_update_time DateTime64(3) DEFAULT now64(3), environment Nullable(String), source LowCardinality(String) DEFAULT 'user', is_evaluation UInt8 DEFAULT 0, metadata_map Map(LowCardinality(String), String)) ENGINE=ReplacingMergeTree(ch_update_time) ORDER BY (project_id, toDate(trace_start_time), trace_id)"

echo "== provision the scoped writer (view DEFINER) — MUST exist before the migration =="
ch --query "CREATE USER IF NOT EXISTS sql_gateway_writer IDENTIFIED WITH no_password"
ch --query "GRANT SELECT ON pubviews.spans  TO sql_gateway_writer"
ch --query "GRANT SELECT ON pubviews.traces TO sql_gateway_writer"

echo "== simulate a stale prior version: pre-create the views WITHOUT the explicit definer =="
echo "   (proves CREATE OR REPLACE re-applies DEFINER = sql_gateway_writer even when the view already exists)"
ch --query "CREATE VIEW pubviews.spans_public_v1 AS SELECT 1 AS stale"
ch --query "CREATE VIEW pubviews.traces_public_v1 AS SELECT 1 AS stale"

echo "== apply migration 012 Up section AS WRITTEN (DEFINER = sql_gateway_writer) =="
awk '/-- \+goose Up/{f=1;next} /-- \+goose Down/{f=0} f' "$MIG" \
  | docker exec -i "$CH_CONTAINER" clickhouse-client --database pubviews --multiquery
echo "migration 012 Up applied OK"

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

ch --query "INSERT INTO pubviews.traces (trace_id,project_id,trace_start_time,name) VALUES ('tA','proj_A',toDateTime64('2026-01-01 00:00:00',3),'a'), ('tB','proj_B',now64(3),'b')"

echo "== RO reads the view (expect sA + duration_ms=2000) =="
RO_VIEW="$(ch_ro --query "SELECT span_id, duration_ms FROM pubviews.spans_public_v1(project_id='proj_A') ORDER BY span_id")"
printf '%s\n' "$RO_VIEW"
[ "$RO_VIEW" = $'sA\t2000' ] || { echo "FAIL: unexpected RO view result"; exit 1; }
echo "PASS: RO can read the view"

echo "== RO reads the traces view too (both views, not just spans) =="
RO_TRACES="$(ch_ro --query "SELECT trace_id FROM pubviews.traces_public_v1(project_id='proj_A')")"
printf '%s\n' "$RO_TRACES"
[ "$RO_TRACES" = "tA" ] || { echo "FAIL: unexpected RO traces view result: $RO_TRACES"; exit 1; }
echo "PASS: RO can read traces_public_v1"

echo "== RO denied on the physical traces table as well as spans =="
if DENY_T="$(ch_ro --query "SELECT count() FROM pubviews.traces" 2>&1)"; then
  echo "FAIL: RO user could read the physical traces table"; exit 1
fi
printf '%s' "$DENY_T" | grep -qE "ACCESS_DENIED|Code: 497" \
  || { echo "FAIL: physical traces read failed but NOT with access-denied: $DENY_T"; exit 1; }
echo "PASS: RO denied on physical traces table (ACCESS_DENIED)"

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

echo "== row curation: internal traffic and evaluation traces are excluded =="
# A detector self-trace, an evaluation trace flagged on the TRACE row, and one flagged
# only on a SPAN row -- the last is the case a per-row is_evaluation check would miss.
ch --query "INSERT INTO pubviews.spans (span_id,trace_id,project_id,span_start_time,span_end_time,name,span_kind,source,is_evaluation) VALUES ('sInt','tInt','proj_A',now64(3),now64(3),'internal','LLM','detector',0), ('sEvalT','tEvalT','proj_A',now64(3),now64(3),'eval-trace','LLM','user',0), ('sEvalS','tEvalS','proj_A',now64(3),now64(3),'eval-span','LLM','user',1)"
ch --query "INSERT INTO pubviews.traces (trace_id,project_id,trace_start_time,name,source,is_evaluation,ch_update_time) VALUES ('tEvalT','proj_A',now64(3),'eval-trace','user',1,toDateTime64('2026-01-01 00:00:00',3))"

CURATED="$(ch_ro --query "SELECT span_id FROM pubviews.spans_public_v1(project_id='proj_A') ORDER BY span_id")"
printf '%s\n' "$CURATED"
[ "$CURATED" = "sA" ] || { echo "FAIL: expected only sA, got: $CURATED"; exit 1; }
echo "PASS: source != 'user' excluded, and evaluation traces excluded whether flagged on the trace or only on a span"

echo "== evaluation exclusion survives a ReplacingMergeTree merge =="
# The realistic shape, which an earlier version of this check got wrong by omitting the
# flagged SPAN: ingest derives the trace-level flag FROM eval-kind spans, so a flagged
# trace always has at least one flagged span of its own.
#
# The two halves behave differently under compaction, and that is the whole point of
# building the set from both:
#   traces -- one row per trace in a date bucket, so two versions collapse and the
#             merge physically deletes the flagged one;
#   spans  -- span_id is in the sort key, so distinct spans never collapse into each
#             other, and a span's flag comes from its kind, which does not change
#             between exports. The flagged span row therefore survives.
ch --query "INSERT INTO pubviews.spans (span_id,trace_id,project_id,span_start_time,span_end_time,name,span_kind,source,is_evaluation,ch_update_time) VALUES ('sEvalRoot','tEvalM','proj_A',toDateTime64('2026-01-01 00:00:00',3),toDateTime64('2026-01-01 00:00:01',3),'eval-root','EVALUATION','user',1,toDateTime64('2026-01-01 00:00:00',3))"
ch --query "INSERT INTO pubviews.traces (trace_id,project_id,trace_start_time,name,source,is_evaluation,ch_update_time) VALUES ('tEvalM','proj_A',toDateTime64('2026-01-01 00:00:00',3),'eval-trace','user',1,toDateTime64('2026-01-01 00:00:00',3))"
# a later batch: ordinary child spans, and the trace row rewritten to 0
ch --query "INSERT INTO pubviews.spans (span_id,trace_id,project_id,span_start_time,span_end_time,name,span_kind,source,is_evaluation,ch_update_time) VALUES ('sChild','tEvalM','proj_A',toDateTime64('2026-01-01 00:00:02',3),toDateTime64('2026-01-01 00:00:03',3),'child','LLM','user',0,toDateTime64('2026-06-01 00:00:00',3))"
ch --query "INSERT INTO pubviews.traces (trace_id,project_id,trace_start_time,name,source,is_evaluation,ch_update_time) VALUES ('tEvalM','proj_A',toDateTime64('2026-01-01 00:00:00',3),'eval-trace','user',0,toDateTime64('2026-06-01 00:00:00',3))"

PRE="$(ch_ro --query "SELECT count() FROM pubviews.spans_public_v1(project_id='proj_A') WHERE trace_id = 'tEvalM'")"
[ "$PRE" = "0" ] || { echo "FAIL: evaluation trace visible before any merge"; exit 1; }

ch --query "OPTIMIZE TABLE pubviews.traces FINAL"
ch --query "OPTIMIZE TABLE pubviews.spans FINAL"
TRACE_FLAGGED="$(ch --query "SELECT count() FROM pubviews.traces WHERE trace_id='tEvalM' AND is_evaluation=1")"
SPAN_FLAGGED="$(ch --query "SELECT count() FROM pubviews.spans  WHERE trace_id='tEvalM' AND is_evaluation=1")"
POST="$(ch_ro --query "SELECT count() FROM pubviews.spans_public_v1(project_id='proj_A') WHERE trace_id = 'tEvalM'")"
echo "  after merge: flagged traces rows=$TRACE_FLAGGED  flagged spans rows=$SPAN_FLAGGED"
[ "$TRACE_FLAGGED" = "0" ] || echo "  (note: the traces row did not collapse here; the sort key must have differed)"
[ "$SPAN_FLAGGED" != "0" ] || { echo "FAIL: the flagged span did not survive the merge -- the exclusion has no durable source"; exit 1; }
[ "$POST" = "0" ] || { echo "FAIL: evaluation trace became visible after the merge"; exit 1; }
echo "PASS: the flagged span survives compaction and keeps the trace excluded after the traces row collapses"

echo "== readonly profile: a readonly=1 user cannot override a CONST cap =="
if SET_OUT="$(ch_ro --query "SELECT count() FROM pubviews.spans_public_v1(project_id='proj_A') SETTINGS max_execution_time = 60" 2>&1)"; then
  echo "FAIL: RO user was allowed to override max_execution_time"; exit 1
fi
printf '%s' "$SET_OUT" | grep -qE "READONLY|Cannot modify|Code: 164|Setting .* should not be changed" \
  || { echo "FAIL: per-query SETTINGS refused, but not as a readonly/constraint error: $SET_OUT"; exit 1; }
echo "PASS: per-query SETTINGS rejected under readonly = 1 (caps come from the profile)"

echo "== cleanup =="
ch --query "DROP DATABASE pubviews"
ch --query "DROP USER IF EXISTS pubviews_ro"
ch --query "DROP USER IF EXISTS sql_gateway_writer"
ch --query "DROP SETTINGS PROFILE IF EXISTS pubviews_ro_profile"
echo "ALL DDL CHECKS PASSED"
