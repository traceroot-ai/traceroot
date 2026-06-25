"""
Test 7: clickhouse-connect bound parameter in parameterized view call.

Connects to localhost:18123 and runs the bound-param view-call form:
  SELECT span_id FROM spike.spans_definer_v1(project_id = {scope_project_id:String})
  ORDER BY span_id
  parameters={"scope_project_id": "proj_A"}

Note: uses spike_ro (no_password, no HOST restriction) because the `default` user
has HOST LOCAL set, which blocks HTTP connections arriving through Docker port-mapping
(the container sees a Docker bridge IP, not 127.0.0.1).  The `spike_ro` user has
SELECT on `spike.spans_definer_v1` and can reach the HTTP port from the host.

PASS  iff rows = ['sA1', 'sA2'] and no exception.
"""

import sys

try:
    import clickhouse_connect
except ImportError as e:
    print(f"SKIP: clickhouse_connect not installed: {e}", file=sys.stderr)
    sys.exit(0)

_ver = getattr(clickhouse_connect.__version__, "version", None) or getattr(
    clickhouse_connect.__version__, "__version__", str(clickhouse_connect.__version__)
)
print(f"clickhouse_connect version: {_ver}", flush=True)

client = clickhouse_connect.get_client(
    host="localhost", port=18123, username="spike_ro", password=""
)

query = (
    "SELECT span_id FROM spike.spans_definer_v1(project_id = {scope_project_id:String})"
    " ORDER BY span_id"
)
params = {"scope_project_id": "proj_A"}

try:
    result = client.query(query, parameters=params)
    rows = [row[0] for row in result.result_rows]
    print(f"Rows returned: {rows}")
    expected = ["sA1", "sA2"]
    if rows == expected:
        print("PASS: bound-param view-call via clickhouse-connect works correctly")
    else:
        print(f"FAIL: expected {expected}, got {rows}")
        sys.exit(1)
except Exception as e:
    print(f"FAIL: exception: {e}", file=sys.stderr)
    sys.exit(1)
finally:
    client.close()
