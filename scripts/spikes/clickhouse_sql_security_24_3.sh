#!/usr/bin/env bash
# clickhouse_sql_security_24_3.sh
#
# Re-runnable spike: ClickHouse SQL SECURITY / DEFINER + parameterized views.
#
# Proven on:
#   24.3.18.7   (clickhouse/clickhouse-server:24.3)             -- the original baseline
#   25.2.1.3085 (bitnamilegacy/clickhouse:25.2.1-debian-12-r0)  -- the build staging deploys
#
# 31 assertions, 0 failures on both, with the version and image digest pinned per run.
#
# The version and image digest are asserted rather than assumed, so every run records
# which server proved the model. Pass EXPECTED_VERSION / EXPECTED_DIGEST to prove it on
# another build; the failure message prints the values to pin.
# Idempotent: drops and recreates the `spike` database, users, and profiles on each run.
#
# Prerequisites:
#   A running container named by CH_CONTAINER (default `ch_sql_spike`), or set
#   CH_IMAGE and this script starts and tears down its own disposable server.
#
# Usage:
#   bash scripts/spikes/clickhouse_sql_security_24_3.sh
#   CH_IMAGE=clickhouse/clickhouse-server:24.3 EXPECTED_VERSION=24.3.18.7 bash ...
#   CH_IMAGE=bitnamilegacy/clickhouse:25.2.1-debian-12-r0 \\
#     EXPECTED_VERSION=25.2.1.3085 \\
#     EXPECTED_DIGEST=sha256:3c1f49548968dce24832ea2487647fe80dcfbd832d2dbb2e9e735629d7c7fc31 bash ...
#
#   EXPECTED_DIGEST is required for any image other than the default: it defaults to the
#   24.3 pin, so omitting it makes test 0 fail against a different build.
#
# EXPECTED_VERSION is asserted, so a run always records which server proved the model.

set -euo pipefail

CH_CONTAINER="${CH_CONTAINER:-ch_sql_spike}"
CH_IMAGE="${CH_IMAGE:-}"
if [ -n "$CH_IMAGE" ]; then
  docker rm -f "$CH_CONTAINER" >/dev/null 2>&1 || true
  # Ports are published because the companion bound-parameter test
  # (clickhouse_connect_bound_param.py) connects over HTTP from the host, and it runs
  # AFTER this script against the users and views this script creates. Teardown is
  # therefore skippable: set CH_KEEP=1 to leave the server up for it.
  #
  # They are bound to loopback only. This server runs with ALLOW_EMPTY_PASSWORD and
  # creates spike accounts with no password, so publishing on 0.0.0.0 would let anything
  # that can route to this host read the physical tables directly and bypass the
  # view-only scoping the spike exists to demonstrate.
  docker run -d --name "$CH_CONTAINER" -e ALLOW_EMPTY_PASSWORD=yes \
    -p "127.0.0.1:${CH_HTTP_PORT:-18123}:8123" \
    -p "127.0.0.1:${CH_NATIVE_PORT:-19000}:9000" "$CH_IMAGE" >/dev/null
  if [ -z "${CH_KEEP:-}" ]; then
    trap 'docker rm -f "$CH_CONTAINER" >/dev/null 2>&1 || true' EXIT
  fi
  for _ in $(seq 1 50); do
    docker exec "$CH_CONTAINER" clickhouse-client --query "SELECT 1" >/dev/null 2>&1 && break
    sleep 3
  done
else
  # Existing-container mode: this script did not choose how that container publishes its
  # ports, so the loopback guarantee above does not carry over. It seeds no-password accounts
  # (spike_ro is deliberately not host-restricted so the companion HTTP test can log in), so
  # refuse to create them on a server that is reachable off-box.
  if ! docker inspect "$CH_CONTAINER" >/dev/null 2>&1; then
    echo "FATAL: container '$CH_CONTAINER' not found. Set CH_IMAGE to have this script start one." >&2
    exit 1
  fi
  _bad=""
  for _binding in $(docker inspect \
      -f '{{range $p, $c := .NetworkSettings.Ports}}{{range $c}}{{$p}}@{{.HostIp}} {{end}}{{end}}' \
      "$CH_CONTAINER" 2>/dev/null); do
    case "${_binding#*@}" in
      127.0.0.1|::1|localhost) ;;
      *) _bad="$_bad $_binding" ;;
    esac
  done
  if [ -n "$_bad" ]; then
    echo "FATAL: '$CH_CONTAINER' publishes ports on non-loopback addresses:$_bad" >&2
    echo "       This spike creates no-password accounts, so it will not seed them into a" >&2
    echo "       server that is reachable off-box. Republish those ports on 127.0.0.1," >&2
    echo "       or unset CH_CONTAINER and set CH_IMAGE to let this script start its own." >&2
    exit 1
  fi
fi

CH="docker exec $CH_CONTAINER clickhouse-client"

sep() { echo; echo "===================================================="; echo "  $*"; echo "===================================================="; }

# --- Assertion helpers: a security spike must FAIL LOUDLY, never print PASS unconditionally ---

# expect_deny "label" <cmd...> : PASS only if the SERVER refused the query.
# Fails the whole script (exit 1) if the command unexpectedly SUCCEEDS, and also if it
# failed without ever reaching the server. A login or connection failure exits non-zero
# too, so accepting any non-zero exit would let an unreachable account masquerade as a
# denied one -- the assertion would still print PASS while testing nothing.
expect_deny() {
  local label="$1"; shift
  local out
  if out=$("$@" 2>&1); then
    echo "FAIL [$label]: command unexpectedly SUCCEEDED (expected access-denied):"
    printf '%s\n' "$out" | head -3
    exit 1
  fi
  if printf '%s' "$out" | grep -qiE 'AUTHENTICATION_FAILED|Code: 516|Code: 210|NETWORK_ERROR|Connection refused|Cannot connect|Timeout exceeded while connecting|Error response from daemon|No such container|is not running|OCI runtime exec failed|Cannot connect to the Docker daemon'; then
    echo "FAIL [$label]: failed BEFORE the server could refuse it (login/connection/container error, not a denial):"
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

# expect_count "label" <cmd...> : PASS only if the command succeeds AND returns a non-negative integer.
expect_count() {
  local label="$1"; shift
  local out
  if ! out=$("$@" 2>&1); then
    echo "FAIL [$label]: expected readable but command errored:"
    printf '%s\n' "$out" | head -3
    exit 1
  fi
  if ! printf '%s' "$out" | grep -qE '^[0-9]+$'; then
    echo "FAIL [$label]: expected a numeric count but got '$out'"
    exit 1
  fi
  echo "PASS [$label]: readable (count=$out)"
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
sep "TEST 0: version + image (verified against the pinned baseline)"
EXPECTED_VERSION="${EXPECTED_VERSION:-24.3.18.7}"
# Pinned per image. Overridable so the same matrix can be proven on another build,
# but never silently skipped: a security spike that cannot say which image it ran
# against is not evidence of anything.
EXPECTED_DIGEST="${EXPECTED_DIGEST:-sha256:85b97f63dcfff47790d26bb5d5801637aaddb2b93e5e9aee27a686c2fb2b9916}"

expect_eq "0: ClickHouse version matches the pinned baseline" "$EXPECTED_VERSION" \
  docker exec "$CH_CONTAINER" clickhouse-client --query "SELECT version()"

# Verify the RUNNING container's image repo-digest against the pinned baseline (drift detection),
# rather than echoing a hardcoded value.
IMG_ID=$(docker inspect --format '{{.Image}}' "$CH_CONTAINER")

# Resolving the repository has been wrong three times, so this does it once, properly.
# The three failure modes, all real:
#   - a hardcoded repo yields an EMPTY digest on any other image, failing as <none>
#     rather than as a mismatch, which is a drift check that cannot detect drift;
#   - matching any repo lets an image carrying several digests compare against an
#     unrelated one;
#   - `.Config.Image` is the reference as given, which is an image ID (sha256:...)
#     whenever the container was started by ID rather than by tag.
# CH_IMAGE is authoritative when set, because it is what we asked Docker to run.
if [ -n "$CH_IMAGE" ]; then
  IMG_REPO="$CH_IMAGE"
else
  IMG_REPO=$(docker inspect --format '{{.Config.Image}}' "$CH_CONTAINER")
  case "$IMG_REPO" in
    sha256:*) IMG_REPO=$(docker image inspect "$IMG_ID" --format '{{if .RepoTags}}{{index .RepoTags 0}}{{end}}') ;;
  esac
fi
IMG_REPO="${IMG_REPO%%@*}"   # drop any @sha256:... suffix
# Strip a tag, but only a tag. A registry may carry a port ("registry:5000/foo"), and
# blindly cutting at the last colon turned that into "registry". A colon is only a tag
# separator when it appears in the LAST path segment.
case "${IMG_REPO##*/}" in
  *:*) IMG_REPO="${IMG_REPO%:*}" ;;
esac

# Exact prefix comparison rather than a regex: a repository can contain characters
# that are regex metacharacters (a registry host has dots), and matching those
# loosely is how an unrelated repository's digest gets accepted.
ACTUAL_DIGEST=""
while IFS= read -r _rd; do
  [ -n "$_rd" ] || continue
  if [ "${_rd#"${IMG_REPO}@"}" != "$_rd" ]; then
    ACTUAL_DIGEST="${_rd#*@}"
    break
  fi
done <<EOF
$(docker image inspect "$IMG_ID" --format '{{range .RepoDigests}}{{println .}}{{end}}')
EOF

echo "running image: ${CH_IMAGE:-$(docker inspect --format '{{.Config.Image}}' "$CH_CONTAINER")}  repo: $IMG_REPO  digest: ${ACTUAL_DIGEST:-<none>}"
if [ "$ACTUAL_DIGEST" != "$EXPECTED_DIGEST" ]; then
  echo "FAIL [0: image digest matches pinned baseline]: expected $EXPECTED_DIGEST, running image is ${ACTUAL_DIGEST:-<none>}"
  echo "       To prove the matrix on this image, re-run with it pinned:"
  echo "       EXPECTED_DIGEST=${ACTUAL_DIGEST:-<pull the image so it has a repo digest>} \\"
  echo "       EXPECTED_VERSION=<its version> CH_IMAGE=<image> bash $0"
  exit 1
fi
echo "PASS [0: image digest matches pinned baseline]: $ACTUAL_DIGEST"

# ---------------------------------------------------------------------------
# TEST 1 — Parameterized view, literal arg
# ---------------------------------------------------------------------------
sep "TEST 1: parameterized view — literal arg"

$CH --query "CREATE VIEW spike.spans_public_v1 AS
SELECT span_id, trace_id, name FROM (
  SELECT * FROM spike.spans_phys WHERE project_id = {project_id:String}
  ORDER BY ch_update_time DESC LIMIT 1 BY span_id
)"

expect_eq "1: parameterized view returns only proj_A rows" $'sA1\nsA2' \
  docker exec "$CH_CONTAINER" clickhouse-client \
  --query "SELECT span_id FROM spike.spans_public_v1(project_id = 'proj_A') ORDER BY span_id"

# ---------------------------------------------------------------------------
# TEST 2 — Bound parameter inside the view call
# ---------------------------------------------------------------------------
sep "TEST 2: bound parameter inside view call (--param_ form)"

expect_eq "2: bound-param view call returns only proj_A rows" $'sA1\nsA2' \
  docker exec "$CH_CONTAINER" clickhouse-client \
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

# spike_ro is deliberately NOT host-restricted: the companion bound-parameter test
# (clickhouse_connect_bound_param.py) logs in as this user over HTTP from the host, which
# arrives as a Docker bridge IP and would be rejected by HOST LOCAL. It is confined instead
# by the container's ports being loopback-only -- published that way above when this script
# starts the server, and verified above when an existing CH_CONTAINER is supplied.
$CH --query "CREATE USER spike_ro IDENTIFIED WITH no_password SETTINGS PROFILE 'spike_ro_profile'"

$CH --query "GRANT SELECT ON spike.spans_definer_v1 TO spike_ro"

echo ""
expect_eq "4a: spike_ro reads definer view (DEFINER lets body read the physical table)" $'sA1\nsA2' \
  docker exec "$CH_CONTAINER" clickhouse-client --user spike_ro \
  --query "SELECT span_id FROM spike.spans_definer_v1(project_id = 'proj_A') ORDER BY span_id"

echo ""
expect_deny "4b: spike_ro reads physical table" \
  docker exec "$CH_CONTAINER" clickhouse-client --user spike_ro \
  --query "SELECT * FROM spike.spans_phys LIMIT 1"

echo ""
expect_deny "4c: spike_ro INSERT into physical table" \
  docker exec "$CH_CONTAINER" clickhouse-client --user spike_ro \
  --query "INSERT INTO spike.spans_phys (project_id,span_id,trace_id,name) VALUES ('proj_C','sC1','tC1','c-one')"

echo ""
expect_eq "4d: spike_ro system.tables shows only the granted view" $'spike\tspans_definer_v1' \
  docker exec "$CH_CONTAINER" clickhouse-client --user spike_ro \
  --query "SELECT database, name FROM system.tables ORDER BY database, name"

echo ""
expect_deny "4d: spike_ro system.clusters" \
  docker exec "$CH_CONTAINER" clickhouse-client --user spike_ro \
  --query "SELECT * FROM system.clusters LIMIT 1"

# ---------------------------------------------------------------------------
# TEST 5 — Tenant isolation
# ---------------------------------------------------------------------------
sep "TEST 5: tenant isolation"

expect_eq "5a: flat query returns only proj_A" $'sA1\nsA2' \
  docker exec "$CH_CONTAINER" clickhouse-client --user spike_ro \
  --query "SELECT span_id FROM spike.spans_definer_v1(project_id = 'proj_A') ORDER BY span_id"

echo ""
expect_eq "5b: CTE query returns only proj_A" $'sA1\nsA2' \
  docker exec "$CH_CONTAINER" clickhouse-client --user spike_ro \
  --query "WITH v AS (SELECT span_id FROM spike.spans_definer_v1(project_id = 'proj_A')) SELECT span_id FROM v ORDER BY span_id"

echo ""
expect_empty "5c: forged quote injection returns no rows (no proj_B leak)" \
  docker exec "$CH_CONTAINER" clickhouse-client \
  --param_pid="proj_A' OR project_id='proj_B" \
  --query "SELECT span_id FROM spike.spans_definer_v1(project_id = {pid:String}) ORDER BY span_id"

echo ""
expect_empty "5d: forged semicolon-DROP injection returns no rows" \
  docker exec "$CH_CONTAINER" clickhouse-client \
  --param_pid="proj_A'); DROP TABLE spike.spans_phys; --" \
  --query "SELECT span_id FROM spike.spans_definer_v1(project_id = {pid:String}) ORDER BY span_id"

echo ""
expect_eq "5d: physical table survived injection attempt" "3" \
  docker exec "$CH_CONTAINER" clickhouse-client --query "SELECT count(*) FROM spike.spans_phys"

# ---------------------------------------------------------------------------
# TEST 6 — Resource caps / profile
# ---------------------------------------------------------------------------
sep "TEST 6: resource caps / readonly profile"

expect_deny "6a: spike_ro raises max_execution_time (readonly blocks it)" \
  docker exec "$CH_CONTAINER" clickhouse-client --user spike_ro \
  --query "SELECT span_id FROM spike.spans_definer_v1(project_id = 'proj_A') ORDER BY span_id SETTINGS max_execution_time = 99999"

echo ""
expect_deny "6b: spike_ro sets more-restrictive max_result_rows (readonly blocks any SETTINGS)" \
  docker exec "$CH_CONTAINER" clickhouse-client --user spike_ro \
  --query "SELECT span_id FROM spike.spans_definer_v1(project_id = 'proj_A') ORDER BY span_id SETTINGS max_result_rows = 1"

echo ""
echo "--- 6c: CONST cap fires in practice (spike_tiny_cap: max_execution_time=0.001) ---"
$CH --query "CREATE SETTINGS PROFILE spike_tiny_cap_profile SETTINGS
  readonly = 1, max_execution_time = 0.001 CONST"
$CH --query "CREATE USER spike_tiny_cap IDENTIFIED WITH no_password HOST LOCAL SETTINGS PROFILE 'spike_tiny_cap_profile'"
$CH --query "GRANT SELECT ON spike.spans_definer_v1 TO spike_tiny_cap"

expect_timeout "6c: tiny-cap profile aborts the query" \
  docker exec "$CH_CONTAINER" clickhouse-client --user spike_tiny_cap \
  --query "SELECT span_id FROM spike.spans_definer_v1(project_id = 'proj_A') ORDER BY span_id"

# ---------------------------------------------------------------------------
# TEST 8 — DEFINER with a SCOPED (non-superuser) writer user
# ---------------------------------------------------------------------------
sep "TEST 8: DEFINER = scoped writer user (not superuser)"
# HOST LOCAL, not HOST NONE: this account is the view's DEFINER *and* test 8 logs in as it
# to prove the grant boundary. HOST NONE would block that login, and since a failed login
# also exits non-zero, test 8 would report PASS while asserting nothing. HOST LOCAL still
# refuses connections arriving through Docker port-mapping, which is the exposure that matters.
$CH --query "CREATE USER IF NOT EXISTS spike_writer IDENTIFIED WITH no_password HOST LOCAL"
$CH --query "GRANT SELECT ON spike.spans_phys TO spike_writer"   # writer scoped to the physical table only
$CH --query "CREATE OR REPLACE VIEW spike.spans_definer_scoped_v1 DEFINER = spike_writer SQL SECURITY DEFINER AS
SELECT span_id, trace_id, name FROM (
  SELECT * FROM spike.spans_phys WHERE project_id = {project_id:String}
  ORDER BY ch_update_time DESC LIMIT 1 BY span_id )"
$CH --query "GRANT SELECT ON spike.spans_definer_scoped_v1 TO spike_ro"
expect_eq "8: RO reads the scoped-writer DEFINER view" $'sA1\nsA2' \
  docker exec "$CH_CONTAINER" clickhouse-client --user spike_ro \
  --query "SELECT span_id FROM spike.spans_definer_scoped_v1(project_id = 'proj_A') ORDER BY span_id"
expect_deny "8: scoped writer denied system.clusters" \
  docker exec "$CH_CONTAINER" clickhouse-client --user spike_writer \
  --query "SELECT count() FROM system.clusters"

# ---------------------------------------------------------------------------
# TEST 9 — Cross-tenant view call has NO DB-layer deny (gateway-only isolation)
# ---------------------------------------------------------------------------
sep "TEST 9: RO calls view with FOREIGN project_id (DB has no deny — proves gateway-only isolation)"
# Expected BY DESIGN: a foreign project_id returns that tenant's row — the DB has NO backstop,
# so tenant isolation MUST be enforced by the gateway binding the authenticated project_id.
expect_eq "9: foreign project_id returns proj_B row (DB has no cross-tenant backstop)" "sB1" \
  docker exec "$CH_CONTAINER" clickhouse-client --user spike_ro \
  --query "SELECT span_id FROM spike.spans_definer_v1(project_id = 'proj_B') ORDER BY span_id"

# ---------------------------------------------------------------------------
# TEST 10 — Broader system.* sweep as RO (establish validator coverage)
# ---------------------------------------------------------------------------
sep "TEST 10: system.* readability as RO (gateway validator must reject all system.* refs)"
# Tables the RO user must NOT be able to read (no grant): assert each is denied.
for t in processes query_log text_log users grants merges parts; do
  expect_deny "10: system.$t denied to RO" \
    docker exec "$CH_CONTAINER" clickhouse-client --user spike_ro \
    --query "SELECT count() FROM system.$t"
done
# Tables that ARE readable on 24.3 (config/function metadata, no tenant data): assert they return a
# count — this is exactly why the gateway validator must reject ALL system.* references.
for t in settings functions databases; do
  expect_count "10: system.$t readable by RO (gateway must still reject it)" \
    docker exec "$CH_CONTAINER" clickhouse-client --user spike_ro \
    --query "SELECT count() FROM system.$t"
done

# ---------------------------------------------------------------------------
# TEST 11 — View chaining / nested DEFINER + parameterized view
# ---------------------------------------------------------------------------
sep "TEST 11: nested DEFINER view selecting from another parameterized view"
$CH --query "CREATE OR REPLACE VIEW spike.spans_chain_v1 DEFINER = default SQL SECURITY DEFINER AS
SELECT span_id FROM spike.spans_definer_v1(project_id = {project_id:String})"
$CH --query "GRANT SELECT ON spike.spans_chain_v1 TO spike_ro"
expect_eq "11: nested DEFINER view propagates the param through the chain" $'sA1\nsA2' \
  docker exec "$CH_CONTAINER" clickhouse-client --user spike_ro \
  --query "SELECT span_id FROM spike.spans_chain_v1(project_id = 'proj_A') ORDER BY span_id"

sep "ALL TESTS COMPLETE"
