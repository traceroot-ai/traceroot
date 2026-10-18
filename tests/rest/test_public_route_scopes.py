"""The credential and scope every public route requires, pinned as one table.

#2416 is not that a route is under-protected today — it is that the Python
service had no way to *say* a route needs more than an ``ingest`` key, so the
next administrative route would ship without one and a review would have nothing
to notice. A dependency that nobody is obliged to reach for does not fix that on
its own. This does: every operation under ``/api/v1/public`` appears below with
the credential it accepts and the key scope it requires, read off the live
dependency graph rather than from source text. Adding a route, or changing what
one accepts, fails here until the table says so — which is the point where
someone has to state the scope out loud.

The two columns are independent, and both are read from the route:

* **credential** — which of the three stamped annotations the route depends on.
  ``key`` is API-key-only, ``key-or-user`` takes either, ``user`` rejects API
  keys outright with a 403 before scope is ever consulted.
* **scope** — the key scope the route requires: ``ingest`` (any valid key) or
  ``admin``. It is ``n/a`` on a ``user`` route, where no key arrives to scope.

The three key-management routes require ``admin``. Every other key-reachable
route requires only ``ingest``, and that is a decision rather than an omission:
ingestion and ``whoami`` are what an application's credential exists to do; the
project-scoped reads are what an ``ingest`` key is defined to allow; and the
evaluation reporting writes are performed by the SDK with the very key it sends
telemetry with, so requiring ``admin`` there would break every project whose keys
were minted after the scope default changed, while hardening nothing.

The key-management routes are proxies to the control plane, which requires the
same scope and re-validates independently, so the requirement recorded here is
the local half of two checks rather than the only one.
"""

from fastapi.routing import APIRoute

from rest.main import app

PUBLIC_PREFIX = "/api/v1/public"

# Stamped auth dependency → the credential label used in the table below.
_CREDENTIALS = {
    "authenticate_and_stamp_identity": "key",
    "authenticate_and_stamp_public_caller": "key-or-user",
    "authenticate_and_stamp_account_caller": "user",
}

# Dependencies that raise the scope requirement above the ``ingest`` floor.
_ADMIN_SCOPE_DEPENDENCIES = {"require_admin_key_scope", "require_admin_scope"}

# (method, path, credential, scope). Sorted by path, then method, then row.
#
# ``GET /api/v1/public/datasets`` appears twice on purpose: the dataset read and
# the evaluation gateway's forwarding route are both registered on it, and the
# read is declared first so it is the one that matches. The table records what is
# registered, not what wins, so a reordering that changed the answer shows up as
# a reordering here too. Both require the same scope, so neither order is a hole.
EXPECTED_ROUTE_SCOPES = (
    ("GET", "/api/v1/public/alerts", "key-or-user", "ingest"),
    ("POST", "/api/v1/public/alerts", "user", "n/a"),
    ("DELETE", "/api/v1/public/alerts/{alert_id}", "user", "n/a"),
    ("GET", "/api/v1/public/alerts/{alert_id}", "key-or-user", "ingest"),
    ("PATCH", "/api/v1/public/alerts/{alert_id}", "user", "n/a"),
    ("PATCH", "/api/v1/public/alerts/{alert_id}/status", "user", "n/a"),
    ("GET", "/api/v1/public/api-keys", "key", "admin"),
    ("POST", "/api/v1/public/api-keys", "key", "admin"),
    ("DELETE", "/api/v1/public/api-keys/{key_id}", "key", "admin"),
    ("GET", "/api/v1/public/dashboards", "key-or-user", "ingest"),
    ("POST", "/api/v1/public/dashboards", "user", "n/a"),
    ("DELETE", "/api/v1/public/dashboards/{dashboard_id}", "user", "n/a"),
    ("GET", "/api/v1/public/dashboards/{dashboard_id}", "key-or-user", "ingest"),
    ("PATCH", "/api/v1/public/dashboards/{dashboard_id}", "user", "n/a"),
    ("GET", "/api/v1/public/dashboards/{dashboard_id}/data", "key-or-user", "ingest"),
    ("GET", "/api/v1/public/dataset-versions/{subpath:path}", "key", "ingest"),
    ("GET", "/api/v1/public/dataset-versions/{version_id}", "key-or-user", "ingest"),
    ("GET", "/api/v1/public/datasets", "key", "ingest"),
    ("GET", "/api/v1/public/datasets", "key-or-user", "ingest"),
    ("POST", "/api/v1/public/datasets", "key", "ingest"),
    ("GET", "/api/v1/public/datasets/{dataset_id}", "key-or-user", "ingest"),
    ("GET", "/api/v1/public/datasets/{dataset_id}/versions", "key-or-user", "ingest"),
    ("GET", "/api/v1/public/datasets/{subpath:path}", "key", "ingest"),
    ("PATCH", "/api/v1/public/datasets/{subpath:path}", "key", "ingest"),
    ("POST", "/api/v1/public/datasets/{subpath:path}", "key", "ingest"),
    ("GET", "/api/v1/public/detectors", "key-or-user", "ingest"),
    ("POST", "/api/v1/public/detectors", "user", "n/a"),
    ("GET", "/api/v1/public/detectors/findings", "key-or-user", "ingest"),
    ("GET", "/api/v1/public/detectors/findings/{finding_id}", "key-or-user", "ingest"),
    ("GET", "/api/v1/public/detectors/traces/{trace_id}/finding", "key-or-user", "ingest"),
    ("DELETE", "/api/v1/public/detectors/{detector_id}", "user", "n/a"),
    ("GET", "/api/v1/public/detectors/{detector_id}", "key-or-user", "ingest"),
    ("PATCH", "/api/v1/public/detectors/{detector_id}", "user", "n/a"),
    ("GET", "/api/v1/public/evaluation-runs", "key-or-user", "ingest"),
    ("POST", "/api/v1/public/evaluation-runs", "key", "ingest"),
    ("GET", "/api/v1/public/evaluation-runs/{run_id}", "key-or-user", "ingest"),
    ("POST", "/api/v1/public/evaluation-runs/{run_id}/complete", "key", "ingest"),
    ("POST", "/api/v1/public/evaluation-runs/{run_id}/results", "key", "ingest"),
    ("POST", "/api/v1/public/evaluation-runs/{subpath:path}", "key", "ingest"),
    ("GET", "/api/v1/public/evaluations", "key-or-user", "ingest"),
    ("GET", "/api/v1/public/projects", "user", "n/a"),
    ("POST", "/api/v1/public/projects", "user", "n/a"),
    ("DELETE", "/api/v1/public/projects/{project_id}", "user", "n/a"),
    ("PATCH", "/api/v1/public/projects/{project_id}", "user", "n/a"),
    ("POST", "/api/v1/public/projects/{project_id}/api-keys", "user", "n/a"),
    ("DELETE", "/api/v1/public/projects/{project_id}/api-keys/{key_id}", "user", "n/a"),
    ("GET", "/api/v1/public/sessions", "key-or-user", "ingest"),
    ("GET", "/api/v1/public/sessions/{session_id}", "key-or-user", "ingest"),
    ("POST", "/api/v1/public/sql", "key-or-user", "ingest"),
    ("GET", "/api/v1/public/sql/schema", "key-or-user", "ingest"),
    ("GET", "/api/v1/public/traces", "key-or-user", "ingest"),
    ("POST", "/api/v1/public/traces", "key", "ingest"),
    ("GET", "/api/v1/public/traces/filter-values/{field}", "key-or-user", "ingest"),
    ("GET", "/api/v1/public/traces/{trace_id}", "key-or-user", "ingest"),
    ("GET", "/api/v1/public/traces/{trace_id}/export", "key-or-user", "ingest"),
    ("GET", "/api/v1/public/whoami", "key", "ingest"),
    ("POST", "/api/v1/public/widgets", "user", "n/a"),
    ("POST", "/api/v1/public/widgets/query", "key-or-user", "ingest"),
    ("DELETE", "/api/v1/public/widgets/{widget_id}", "user", "n/a"),
    ("GET", "/api/v1/public/widgets/{widget_id}", "key-or-user", "ingest"),
    ("PATCH", "/api/v1/public/widgets/{widget_id}", "user", "n/a"),
    ("GET", "/api/v1/public/widgets/{widget_id}/data", "key-or-user", "ingest"),
    ("GET", "/api/v1/public/workspaces", "user", "n/a"),
    ("POST", "/api/v1/public/workspaces", "user", "n/a"),
    ("DELETE", "/api/v1/public/workspaces/{workspace_id}", "user", "n/a"),
    ("PATCH", "/api/v1/public/workspaces/{workspace_id}", "user", "n/a"),
)


def _dependency_names(dependant, out: set[str]) -> set[str]:
    """Collect the name of every callable in a route's dependency tree."""
    if dependant.call is not None:
        out.add(getattr(dependant.call, "__name__", str(dependant.call)))
    for sub in dependant.dependencies:
        _dependency_names(sub, out)
    return out


def _actual_route_scopes() -> tuple[tuple[str, str, str, str], ...]:
    """Read the credential and scope of every public operation off the app."""
    rows: set[tuple[str, str, str, str]] = set()
    for route in app.routes:
        if not isinstance(route, APIRoute) or not route.path.startswith(PUBLIC_PREFIX):
            continue
        names = _dependency_names(route.dependant, set())
        credentials = sorted(_CREDENTIALS[name] for name in names & _CREDENTIALS.keys())
        assert len(credentials) == 1, (
            f"{route.path} resolves {len(credentials)} stamped credentials ({credentials}); "
            "a public route must authenticate through exactly one."
        )
        scope = (
            "admin"
            if names & _ADMIN_SCOPE_DEPENDENCIES
            else ("n/a" if credentials[0] == "user" else "ingest")
        )
        for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
            rows.add((method, route.path, credentials[0], scope))
    # Path first so the table reads like the surface, then the whole row, so the
    # two routes registered on `GET /datasets` have one stable order.
    return tuple(sorted(rows, key=lambda row: (row[1], row[0], row[2], row[3])))


def test_every_public_route_has_a_declared_credential_and_scope():
    """The public surface's authorization, route by route.

    A failure here is not a bug in this test. Either a route was added or changed
    and the table has to record its credential and scope, or a route's
    authorization changed without anyone intending it.
    """
    actual = _actual_route_scopes()
    expected = EXPECTED_ROUTE_SCOPES
    added = [row for row in actual if row not in expected]
    removed = [row for row in expected if row not in actual]
    assert actual == expected, (
        "the public surface's credential/scope table is out of date.\n"
        f"not in the table: {added}\n"
        f"no longer on the app: {removed}"
    )


def test_no_key_reachable_route_is_missing_a_scope_decision():
    """Every route a key can reach names a scope — never nothing.

    The guard the issue asks for, stated independently of the table: a route that
    accepts an API key and resolves no scope at all would be the gap, whether or
    not the table happened to be updated.
    """
    undecided = [
        row
        for row in _actual_route_scopes()
        if row[2] != "user" and row[3] not in ("ingest", "admin")
    ]
    assert not undecided, undecided


def test_user_only_routes_are_unreachable_by_any_key():
    """The administrative routes here refuse a key by credential, not by scope.

    This is why no route besides the key-management gateways requires ``admin``:
    the project and workspace writes are user-credential-only, so an ``admin``
    key is refused there exactly as an ``ingest`` one is. Scope is not what
    protects them, and a reader of the table above should not conclude that it
    is.
    """
    user_only = [row for row in _actual_route_scopes() if row[2] == "user"]
    assert user_only, "expected the account/project write surface to be user-only"
    assert all(row[3] == "n/a" for row in user_only)
