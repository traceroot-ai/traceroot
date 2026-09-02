"""Public read ops that also bind to internal project-scoped routes (the in-app
agent's dispatch path) must accept a parameter superset there, so one registry
definition serves both surfaces. Mirrors the internal-bindings table in the
frontend tools package — update both together.
"""

import pytest
from fastapi.routing import APIRoute

from rest.main import app

BINDINGS = {
    "/api/v1/public/traces": "/api/v1/projects/{project_id}/traces",
    "/api/v1/public/sessions": "/api/v1/projects/{project_id}/sessions",
    "/api/v1/public/sessions/{session_id}": "/api/v1/projects/{project_id}/sessions/{session_id}",
    "/api/v1/public/detectors": "/api/v1/projects/{project_id}/detectors",
    "/api/v1/public/detectors/findings": "/api/v1/projects/{project_id}/detectors/findings",
    "/api/v1/public/detectors/findings/{finding_id}": (
        "/api/v1/projects/{project_id}/detectors/findings/{finding_id}"
    ),
    "/api/v1/public/detectors/traces/{trace_id}/finding": (
        "/api/v1/projects/{project_id}/detectors/traces/{trace_id}/finding"
    ),
    "/api/v1/public/detectors/{detector_id}": (
        "/api/v1/projects/{project_id}/detectors/{detector_id}"
    ),
    # The dashboard mirror is service-to-service only, so it lives on the
    # /internal prefix the ingress drops (unlike the pre-existing read twins).
    "/api/v1/public/dashboards": "/api/v1/internal/projects/{project_id}/dashboards",
    "/api/v1/public/dashboards/{dashboard_id}": (
        "/api/v1/internal/projects/{project_id}/dashboards/{dashboard_id}"
    ),
}


def _get_route(path: str) -> APIRoute:
    """Find the GET APIRoute at ``path``.

    Args:
        path (str): Exact route path template.

    Returns:
        APIRoute: The matching route.
    """
    for route in app.routes:
        if isinstance(route, APIRoute) and route.path == path and "GET" in route.methods:
            return route
    raise AssertionError(f"no GET route at {path}")


def _param_names(route: APIRoute) -> set[str]:
    """Collect the route's query and path parameter names.

    Args:
        route (APIRoute): Route to inspect.

    Returns:
        set[str]: Names of declared query + path parameters.
    """
    dependant = route.dependant
    return {p.name for p in dependant.query_params} | {p.name for p in dependant.path_params}


@pytest.mark.parametrize(("public_path", "internal_path"), sorted(BINDINGS.items()))
def test_public_params_are_subset_of_internal(public_path: str, internal_path: str):
    """Every public param on a registry-bound read exists on its internal twin.

    Args:
        public_path (str): Public route path template.
        internal_path (str): Internal project-scoped route path template.
    """
    public_params = _param_names(_get_route(public_path))
    internal_params = _param_names(_get_route(internal_path))
    missing = public_params - internal_params
    assert not missing, (
        f"{public_path} exposes params the internal binding {internal_path} lacks: "
        f"{sorted(missing)} — lift them internally or drop them publicly"
    )
