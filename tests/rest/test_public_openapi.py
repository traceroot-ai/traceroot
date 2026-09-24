"""Tests for the public-only OpenAPI schema generation + drift guard."""

import json
from copy import deepcopy
from pathlib import Path

import pytest

import rest.openapi_public as openapi_public
from rest.main import app
from rest.openapi_public import PUBLIC_PREFIX, _apply_tool_curation, build_public_schema, render

ARTIFACT = Path(__file__).resolve().parents[2] / "backend" / "rest" / "openapi" / "public.json"


def _schema():
    return build_public_schema(app)


def test_includes_required_public_paths():
    paths = _schema()["paths"]
    assert "/api/v1/public/whoami" in paths
    assert "get" in paths["/api/v1/public/whoami"]
    assert "get" in paths["/api/v1/public/traces"]
    assert "get" in paths["/api/v1/public/traces/{trace_id}"]
    assert "get" in paths["/api/v1/public/traces/{trace_id}/export"]


def test_includes_public_ingestion_route():
    # The public API contract is the /api/v1/public/* prefix, which includes the
    # API-key-authed SDK ingestion endpoint.
    paths = _schema()["paths"]
    assert "post" in paths["/api/v1/public/traces"]


def test_excludes_internal_session_and_project_routes():
    paths = _schema()["paths"]
    assert all(p.startswith(PUBLIC_PREFIX) for p in paths), paths
    assert not any(p.startswith("/api/v1/internal/") for p in paths)
    assert not any(p.startswith("/api/v1/projects/") for p in paths)
    assert "/health" not in paths


def test_export_response_model_present_and_referenced():
    schema = _schema()
    export_op = schema["paths"]["/api/v1/public/traces/{trace_id}/export"]["get"]
    ref = export_op["responses"]["200"]["content"]["application/json"]["schema"]["$ref"]
    assert ref.endswith("/PublicTraceExportResponse")
    components = schema["components"]["schemas"]
    # the export model and its nested V1 bundle pieces are pulled in transitively
    assert "PublicTraceExportResponse" in components
    for nested in ("ExportManifest", "GitContext", "GitSource", "PublicTraceDetailResponse"):
        assert nested in components


def test_components_are_pruned_to_public_only():
    components = _schema()["components"]["schemas"]
    # ingestion's response model is public (referenced by the public ingest route)
    assert "IngestResponse" in components
    # internal-only models must not leak into the public schema
    assert "HealthResponse" not in components


def test_build_does_not_mutate_cached_app_schema():
    """build_public_schema must not mutate FastAPI's cached full OpenAPI schema.

    app.openapi() returns a cached document whose path-item/operation dicts are
    shared; the public contract must be applied to copies, not those originals.
    """
    # Force a pristine cache: earlier tests may have already built the schema.
    app.openapi_schema = None
    before = deepcopy(app.openapi())

    public = build_public_schema(app)

    after = app.openapi()
    assert after == before, "build_public_schema mutated FastAPI's cached schema"
    # Sanity: the public schema still applies its contract (filtering + stripping).
    assert all(p.startswith(PUBLIC_PREFIX) for p in public["paths"])
    whoami = public["paths"]["/api/v1/public/whoami"]["get"]
    assert whoami["security"] == [{"BearerAuth": []}]
    # And the full schema's same operation is untouched (no leaked bearer security).
    full_whoami = after["paths"]["/api/v1/public/whoami"]["get"]
    assert "security" not in full_whoami


def test_render_is_deterministic():
    assert render(_schema()) == render(_schema())


def test_committed_artifact_matches_generated():
    """Drift guard: regenerate with `python scripts/sync_public_openapi.py`."""
    assert ARTIFACT.exists(), f"missing artifact: {ARTIFACT}"
    assert ARTIFACT.read_text(encoding="utf-8") == render(_schema())


def test_drift_is_detectable():
    """A changed artifact must not compare equal (the guard is sensitive)."""
    generated = render(_schema())
    tampered = json.loads(generated)
    tampered["info"]["title"] = "Tampered"
    assert render(tampered) != generated


def test_ingestion_documents_protobuf_request_body():
    post = _schema()["paths"]["/api/v1/public/traces"]["post"]
    assert "requestBody" in post
    content = post["requestBody"]["content"]
    assert "application/x-protobuf" in content
    assert content["application/x-protobuf"]["schema"] == {"type": "string", "format": "binary"}


def test_ingestion_documents_runtime_error_responses():
    # The ingest route raises 400 (bad/empty/undecodable body), 402 (plan limit),
    # 415 (wrong Content-Type) and 500 (S3 storage failure) at runtime.
    post = _schema()["paths"]["/api/v1/public/traces"]["post"]
    for code in ("400", "402", "415", "500"):
        assert code in post["responses"], code
    # existing responses are preserved
    assert set(post["responses"]) >= {"200", "401", "422", "400", "402", "415", "500"}


def _public_operations(schema):
    for item in schema["paths"].values():
        for method, op in item.items():
            if method in {"get", "post", "put", "patch", "delete"}:
                yield op


def test_all_public_ops_document_503():
    # Every public op depends on the shared auth dependency, which raises 503 when
    # the auth service is unavailable — so the contract must document 503.
    for op in _public_operations(_schema()):
        assert "503" in op["responses"]


def test_all_public_ops_require_bearer_auth():
    schema = _schema()
    assert schema["components"]["securitySchemes"]["BearerAuth"] == {
        "type": "http",
        "scheme": "bearer",
    }
    for op in _public_operations(schema):
        assert op.get("security") == [{"BearerAuth": []}]
        # the misleading optional Authorization header param is gone
        header_names = [p.get("name", "").lower() for p in op.get("parameters", [])]
        assert "authorization" not in header_names
        assert "401" in op["responses"]


def test_read_endpoints_document_error_responses():
    paths = _schema()["paths"]
    assert set(paths["/api/v1/public/traces"]["get"]["responses"]) >= {"200", "401", "500"}
    for p in ("/api/v1/public/traces/{trace_id}", "/api/v1/public/traces/{trace_id}/export"):
        responses = paths[p]["get"]["responses"]
        assert set(responses) >= {"200", "401", "404", "500"}
        assert responses["404"]["description"] == "Trace not found"


def test_detectors_list_route_documents_error_responses():
    paths = _schema()["paths"]
    assert "get" in paths["/api/v1/public/detectors"]
    responses = paths["/api/v1/public/detectors"]["get"]["responses"]
    assert set(responses) >= {"200", "401", "500"}


def test_detector_detail_route_documents_error_responses():
    responses = _schema()["paths"]["/api/v1/public/detectors/{detector_id}"]["get"]["responses"]
    assert set(responses) >= {"200", "401", "404", "500"}
    assert responses["404"]["description"] == "Detector not found"
    assert responses["500"]["description"] == "Failed to read detector"


# --- Phase-4 evaluation reporting routes ------------------------------------


def test_eval_reporting_routes_are_published():
    """The three typed reporting endpoints appear as explicit POST operations."""
    paths = _schema()["paths"]
    assert "post" in paths["/api/v1/public/evaluation-runs"]
    assert "post" in paths["/api/v1/public/evaluation-runs/{run_id}/results"]
    assert "post" in paths["/api/v1/public/evaluation-runs/{run_id}/complete"]


def test_eval_reporting_routes_document_request_and_response_schemas():
    schema = _schema()
    paths = schema["paths"]
    components = schema["components"]["schemas"]
    cases = {
        "/api/v1/public/evaluation-runs": ("RegisterRunRequest", "RegisterRunResponse", "201"),
        "/api/v1/public/evaluation-runs/{run_id}/results": (
            "UpsertResultRequest",
            "UpsertResultResponse",
            "200",
        ),
        "/api/v1/public/evaluation-runs/{run_id}/complete": (
            "CompleteRunRequest",
            "CompleteRunResponse",
            "200",
        ),
    }
    for path, (req_model, resp_model, ok) in cases.items():
        op = paths[path]["post"]
        req_ref = op["requestBody"]["content"]["application/json"]["schema"]["$ref"]
        assert req_ref.endswith(f"/{req_model}"), (path, req_ref)
        resp_ref = op["responses"][ok]["content"]["application/json"]["schema"]["$ref"]
        assert resp_ref.endswith(f"/{resp_model}"), (path, resp_ref)
        assert req_model in components
        assert resp_model in components
    # Nested request models are pulled in transitively.
    for nested in ("ScorerRef", "ScoreInput"):
        assert nested in components


def test_eval_reporting_routes_document_path_params():
    paths = _schema()["paths"]
    for path in (
        "/api/v1/public/evaluation-runs/{run_id}/results",
        "/api/v1/public/evaluation-runs/{run_id}/complete",
    ):
        params = paths[path]["post"].get("parameters", [])
        run_id = next((p for p in params if p.get("name") == "run_id"), None)
        assert run_id is not None, path
        assert run_id["in"] == "path"
        assert run_id["required"] is True
    # The collection endpoint has no path parameter.
    assert paths["/api/v1/public/evaluation-runs"]["post"].get("parameters", []) == []


def test_eval_reporting_routes_document_error_and_auth_contract():
    paths = _schema()["paths"]
    for path in (
        "/api/v1/public/evaluation-runs",
        "/api/v1/public/evaluation-runs/{run_id}/results",
        "/api/v1/public/evaluation-runs/{run_id}/complete",
    ):
        op = paths[path]["post"]
        # Validation (422), domain 400/404, plus the shared auth 401/503.
        assert set(op["responses"]) >= {"400", "404", "422", "401", "503"}
        assert op["security"] == [{"BearerAuth": []}]
        # Error bodies use the canonical {detail} envelope.
        for code in ("400", "404"):
            ref = op["responses"][code]["content"]["application/json"]["schema"]["$ref"]
            assert ref.endswith("/ErrorResponse")


def test_untyped_dataset_catch_alls_stay_hidden():
    """The dataset READS are typed and published; the WRITES stay on hidden catch-alls.

    The three GETs are published so a client — including the tool registry — can be
    generated from them. No policy decision has been made for dataset WRITES, and
    publishing one would be the first step toward handing it to an agent, so the
    upsert/patch/publish shapes stay unpublished and the catch-alls keep serving them.
    """
    paths = _schema()["paths"]
    dataset_paths = {
        p: set(item) & _METHODS
        for p, item in paths.items()
        if p.startswith("/api/v1/public/datasets")
        or p.startswith("/api/v1/public/dataset-versions")
    }
    assert dataset_paths == {
        "/api/v1/public/datasets": {"get"},
        "/api/v1/public/datasets/{dataset_id}": {"get"},
        "/api/v1/public/datasets/{dataset_id}/versions": {"get"},
        "/api/v1/public/dataset-versions/{version_id}": {"get"},
    }, dataset_paths
    # The additive per-scorer scores / human-score run subpaths also stay hidden:
    # only the three explicit reporting paths are published under evaluation-runs.
    eval_paths = {p for p in paths if p.startswith("/api/v1/public/evaluation-runs")}
    assert eval_paths == {
        "/api/v1/public/evaluation-runs",
        "/api/v1/public/evaluation-runs/{run_id}/results",
        "/api/v1/public/evaluation-runs/{run_id}/complete",
    }


def test_dataset_reads_document_the_errors_a_read_can_return():
    """A read can be refused for a project the caller can't see (403) or rate-limited
    (429). It takes no body, so a 413 would be a false promise."""
    paths = _schema()["paths"]
    for path in (
        "/api/v1/public/datasets",
        "/api/v1/public/datasets/{dataset_id}",
        "/api/v1/public/datasets/{dataset_id}/versions",
        "/api/v1/public/dataset-versions/{version_id}",
    ):
        responses = paths[path]["get"]["responses"]
        assert {"401", "403", "404", "422", "429", "503"} <= set(responses), path
        assert "413" not in responses, path


def test_session_read_routes_document_error_responses():
    paths = _schema()["paths"]
    assert set(paths["/api/v1/public/sessions"]["get"]["responses"]) >= {"200", "401", "500"}
    responses = paths["/api/v1/public/sessions/{session_id}"]["get"]["responses"]
    assert set(responses) >= {"200", "401", "404", "500"}
    assert responses["404"]["description"] == "Session not found"


def test_dashboard_read_routes_document_error_responses():
    paths = _schema()["paths"]
    assert set(paths["/api/v1/public/dashboards"]["get"]["responses"]) >= {"200", "401", "503"}
    responses = paths["/api/v1/public/dashboards/{dashboard_id}"]["get"]["responses"]
    assert set(responses) >= {"200", "401", "404", "503"}
    assert responses["404"]["description"] == "Dashboard not found"


def test_dashboard_data_route_documents_not_found_like_its_sibling():
    """The data read passes the dashboard's 404 through, so its contract says so."""
    paths = _schema()["paths"]
    responses = paths["/api/v1/public/dashboards/{dashboard_id}/data"]["get"]["responses"]
    assert set(responses) >= {"200", "401", "404", "422", "503"}
    assert responses["404"]["description"] == "Dashboard not found"


def test_widget_read_routes_document_not_found_like_the_dashboard_reads():
    """Both widget reads pass the widget's 404 through, so their contracts say so."""
    paths = _schema()["paths"]
    detail = paths["/api/v1/public/widgets/{widget_id}"]["get"]["responses"]
    assert set(detail) >= {"200", "401", "404", "503"}
    assert detail["404"]["description"] == "Widget not found"
    data = paths["/api/v1/public/widgets/{widget_id}/data"]["get"]["responses"]
    assert set(data) >= {"200", "401", "404", "422", "503"}
    assert data["404"]["description"] == "Widget not found"


def test_widget_read_tools_steer_the_model_to_the_saved_widget():
    """get_widget_data is the saved widget answered for a window: the model is
    told to prefer it over an ad hoc run_widget_query when the widget exists,
    that feeds come back skipped, and that every figure names its window."""
    paths = _schema()["paths"]
    get_tool = paths["/api/v1/public/widgets/{widget_id}"]["get"]["x-tool"]
    data_tool = paths["/api/v1/public/widgets/{widget_id}/data"]["get"]["x-tool"]
    assert get_tool["enabled"] and data_tool["enabled"]
    assert "policy" not in get_tool and "policy" not in data_tool
    assert "definition" in get_tool["description"]
    assert "get_widget_data" in get_tool["description"]
    assert "saved" in data_tool["description"]
    assert "run_widget_query" in data_tool["description"]
    assert "list_traces" in data_tool["description"]
    assert "name the window" in data_tool["description"]


def test_dashboard_read_tools_steer_name_resolution():
    """Both dashboard read tools tell the model to resolve a dashboard by
    listing and matching its name — never to guess an id."""
    paths = _schema()["paths"]
    list_tool = paths["/api/v1/public/dashboards"]["get"]["x-tool"]
    get_tool = paths["/api/v1/public/dashboards/{dashboard_id}"]["get"]["x-tool"]
    for tool in (list_tool, get_tool):
        assert tool["enabled"]
        assert "never guess" in tool["description"]
    assert "match its name" in list_tool["description"]
    assert "matching the name" in get_tool["description"]


def test_alert_read_routes_document_error_responses():
    paths = _schema()["paths"]
    assert set(paths["/api/v1/public/alerts"]["get"]["responses"]) >= {"200", "401", "503"}
    # The create documents the cap conflict beside the shared write errors.
    write_responses = paths["/api/v1/public/alerts"]["post"]["responses"]
    assert set(write_responses) >= {"200", "400", "401", "403", "404", "409", "503"}
    assert "alert limit" in write_responses["409"]["description"]
    responses = paths["/api/v1/public/alerts/{alert_id}"]["get"]["responses"]
    assert set(responses) >= {"200", "401", "404", "503"}
    assert responses["404"]["description"] == "Alert not found"


def test_alert_read_tools_steer_name_resolution():
    """Both alert read tools tell the model to resolve an alert by listing
    and matching its name — never to guess an id."""
    paths = _schema()["paths"]
    list_tool = paths["/api/v1/public/alerts"]["get"]["x-tool"]
    get_tool = paths["/api/v1/public/alerts/{alert_id}"]["get"]["x-tool"]
    for tool in (list_tool, get_tool):
        assert tool["enabled"]
        assert "never guess" in tool["description"]
    assert "match its name" in list_tool["description"]
    assert "matching the name" in get_tool["description"]


_METHODS = {"get", "post", "put", "patch", "delete"}

EXPECTED_OPERATION_IDS = {
    "/api/v1/public/projects": {"get": "list_projects", "post": "create_project"},
    "/api/v1/public/projects/{project_id}": {
        "patch": "update_project",
        "delete": "delete_project",
    },
    "/api/v1/public/workspaces": {"get": "list_workspaces", "post": "create_workspace"},
    "/api/v1/public/workspaces/{workspace_id}": {
        "patch": "update_workspace",
        "delete": "delete_workspace",
    },
    "/api/v1/public/dashboards": {"get": "list_dashboards", "post": "create_dashboard"},
    "/api/v1/public/dashboards/{dashboard_id}": {
        "get": "get_dashboard",
        "patch": "update_dashboard",
        "delete": "delete_dashboard",
    },
    "/api/v1/public/dashboards/{dashboard_id}/data": {"get": "get_dashboard_data"},
    "/api/v1/public/alerts": {"get": "list_alerts", "post": "create_alert"},
    "/api/v1/public/alerts/{alert_id}": {
        "get": "get_alert",
        "patch": "update_alert",
        "delete": "delete_alert",
    },
    "/api/v1/public/alerts/{alert_id}/status": {"patch": "set_alert_status"},
    "/api/v1/public/widgets": {"post": "create_widget"},
    "/api/v1/public/widgets/query": {"post": "run_widget_query"},
    "/api/v1/public/widgets/{widget_id}": {
        "get": "get_widget",
        "patch": "update_widget",
        "delete": "delete_widget",
    },
    "/api/v1/public/widgets/{widget_id}/data": {"get": "get_widget_data"},
    "/api/v1/public/detectors": {"get": "list_detectors", "post": "create_detector"},
    "/api/v1/public/detectors/findings": {"get": "list_findings"},
    "/api/v1/public/detectors/findings/{finding_id}": {"get": "get_finding"},
    "/api/v1/public/detectors/traces/{trace_id}/finding": {"get": "get_finding_by_trace"},
    "/api/v1/public/detectors/{detector_id}": {
        "get": "get_detector",
        "patch": "update_detector",
        "delete": "delete_detector",
    },
    "/api/v1/public/sessions": {"get": "list_sessions"},
    "/api/v1/public/sessions/{session_id}": {"get": "get_session"},
    "/api/v1/public/traces": {"get": "list_traces", "post": "ingest_traces"},
    "/api/v1/public/traces/filter-values/{field}": {"get": "list_trace_filter_values"},
    "/api/v1/public/traces/{trace_id}": {"get": "get_trace"},
    "/api/v1/public/traces/{trace_id}/export": {"get": "export_trace"},
    "/api/v1/public/sql": {"post": "run_sql"},
    "/api/v1/public/sql/schema": {"get": "get_sql_schema"},
    "/api/v1/public/whoami": {"get": "whoami"},
    "/api/v1/public/datasets": {"get": "list_datasets"},
    "/api/v1/public/datasets/{dataset_id}": {"get": "get_dataset"},
    "/api/v1/public/datasets/{dataset_id}/versions": {"get": "list_dataset_versions"},
    "/api/v1/public/dataset-versions/{version_id}": {"get": "get_dataset_version"},
    "/api/v1/public/evaluation-runs": {"post": "register_run"},
    "/api/v1/public/evaluation-runs/{run_id}/results": {"post": "upsert_result"},
    "/api/v1/public/evaluation-runs/{run_id}/complete": {"post": "complete_run"},
}


def test_operation_ids_are_clean_tool_names():
    """Public operationIds are short snake_case names, not path-mangled defaults."""
    schema = _schema()
    actual = {
        path: {m: op["operationId"] for m, op in item.items() if m in _METHODS}
        for path, item in schema["paths"].items()
    }
    assert actual == EXPECTED_OPERATION_IDS


def test_no_autogenerated_operation_ids_survive():
    """Every public operation must carry an explicit snake_case id."""
    schema = _schema()
    for path, item in schema["paths"].items():
        for method, op in item.items():
            if method not in _METHODS:
                continue
            assert "_api_v1_" not in op["operationId"], (
                f"{method.upper()} {path}: autogenerated operationId "
                f"{op['operationId']!r} — add operation_id= to the decorator"
            )


def test_every_public_op_has_x_tool():
    schema = _schema()
    for path, item in schema["paths"].items():
        for method, op in item.items():
            if method not in _METHODS:
                continue
            assert "x-tool" in op, f"{method.upper()} {path} missing x-tool"


def test_x_tool_enabled_set_and_shape():
    schema = _schema()
    enabled, disabled = {}, set()
    for item in schema["paths"].values():
        for method, op in item.items():
            if method not in _METHODS:
                continue
            tool = op["x-tool"]
            if tool["enabled"]:
                enabled[tool["name"]] = tool
            else:
                disabled.add(op["operationId"])
    assert disabled == {
        "ingest_traces",
        "register_run",
        "upsert_result",
        "complete_run",
    }
    assert set(enabled) == {
        "whoami",
        "list_traces",
        "list_trace_filter_values",
        "get_trace",
        "export_trace",
        "list_sessions",
        "get_session",
        "list_detectors",
        "get_detector",
        "list_findings",
        "get_finding",
        "get_finding_by_trace",
        "list_dashboards",
        "get_dashboard",
        "list_alerts",
        "get_alert",
        "list_workspaces",
        "list_projects",
        "create_workspace",
        "create_project",
        "create_detector",
        "create_dashboard",
        "create_widget",
        "create_alert",
        "run_widget_query",
        "get_dashboard_data",
        "run_sql",
        "get_sql_schema",
        "get_widget",
        "get_widget_data",
        "update_workspace",
        "update_project",
        "update_detector",
        "update_dashboard",
        "update_widget",
        "update_alert",
        "set_alert_status",
        "delete_workspace",
        "delete_project",
        "delete_detector",
        "delete_dashboard",
        "delete_widget",
        "delete_alert",
        "get_dataset",
        "get_dataset_version",
        "list_dataset_versions",
        "list_datasets",
    }
    for name, tool in enabled.items():
        assert tool["description"], f"{name} needs an agent-facing description"


# The project-scoped read ops depend on the dual-credential auth, which adds an
# optional `project_id` query param (required under a user credential, absent-or-
# matching under an API key). Ingestion and whoami stay key-only and must not.
_PROJECT_ID_READ_OPS = [
    "/api/v1/public/traces",
    "/api/v1/public/traces/{trace_id}",
    "/api/v1/public/traces/{trace_id}/export",
    "/api/v1/public/traces/filter-values/{field}",
    "/api/v1/public/sessions",
    "/api/v1/public/sessions/{session_id}",
    "/api/v1/public/detectors",
    "/api/v1/public/detectors/findings",
    "/api/v1/public/detectors/findings/{finding_id}",
    "/api/v1/public/detectors/traces/{trace_id}/finding",
    "/api/v1/public/dashboards",
    "/api/v1/public/dashboards/{dashboard_id}",
    "/api/v1/public/dashboards/{dashboard_id}/data",
    "/api/v1/public/widgets/{widget_id}",
    "/api/v1/public/widgets/{widget_id}/data",
    "/api/v1/public/alerts",
    "/api/v1/public/alerts/{alert_id}",
    "/api/v1/public/datasets",
    "/api/v1/public/datasets/{dataset_id}",
    "/api/v1/public/datasets/{dataset_id}/versions",
    "/api/v1/public/dataset-versions/{version_id}",
]


def test_dual_credential_reads_expose_described_project_id_query_param():
    paths = _schema()["paths"]
    for p in _PROJECT_ID_READ_OPS:
        params = paths[p]["get"].get("parameters", [])
        matches = [q for q in params if q["name"] == "project_id" and q["in"] == "query"]
        assert len(matches) == 1, p
        assert matches[0].get("required") is not True, p
        assert matches[0].get("description"), p


def test_key_only_ops_have_no_project_id_param():
    paths = _schema()["paths"]
    # whoami stays on the key-only stamped auth (a later task handles account scope).
    whoami_params = paths["/api/v1/public/whoami"]["get"].get("parameters", [])
    assert not [q for q in whoami_params if q["name"] == "project_id"]
    # ingestion is key-only and unchanged.
    post_params = paths["/api/v1/public/traces"]["post"].get("parameters", [])
    assert not [q for q in post_params if q["name"] == "project_id"]
    # So is evaluation reporting: the SDK reports with its API key, never a user login.
    for path in (
        "/api/v1/public/evaluation-runs",
        "/api/v1/public/evaluation-runs/{run_id}/results",
        "/api/v1/public/evaluation-runs/{run_id}/complete",
    ):
        params = paths[path]["post"].get("parameters", [])
        assert not [q for q in params if q["name"] == "project_id"], path


def _filters_param(schema):
    params = schema["paths"]["/api/v1/public/traces"]["get"]["parameters"]
    matches = [p for p in params if p["name"] == "filters"]
    assert len(matches) == 1
    return matches[0]


def test_filters_param_is_json_content_with_registry_variants():
    """The filters param schema is generated from the filter-field registry."""
    from rest.services.filters.columns import FILTER_COLUMNS

    param = _filters_param(_schema())
    assert param["in"] == "query"
    assert param.get("required") is not True
    inner = param["content"]["application/json"]["schema"]
    assert inner["type"] == "array"
    from rest.services.filters.translate import MAX_FILTERS

    # The runtime bounds the predicate count; the contract declares the same cap.
    assert inner["maxItems"] == MAX_FILTERS
    variants = inner["items"]["anyOf"]
    assert len(variants) == len(FILTER_COLUMNS)
    by_field = {v["properties"]["field"]["const"]: v for v in variants}
    assert set(by_field) == {c.name for c in FILTER_COLUMNS}
    from rest.services.filters.translate import MAX_KEY_LENGTH

    for col in FILTER_COLUMNS:
        v = by_field[col.name]
        assert v["properties"]["op"]["enum"] == [str(o) for o in col.operators]
        assert v["additionalProperties"] is False
        if col.requires_key:
            # A keyed field carries the map key, mirroring the runtime validator.
            assert v["required"] == ["field", "key", "op", "value"]
            key_schema = v["properties"]["key"]
            assert key_schema["type"] == "string"
            assert key_schema["minLength"] == 1
            assert key_schema["maxLength"] == MAX_KEY_LENGTH
        else:
            assert v["required"] == ["field", "op", "value"]
            assert "key" not in v["properties"]


def test_filters_param_properties_all_declare_a_type():
    """Every predicate property carries an explicit ``type``.

    ``const``/``enum`` alone are valid JSON Schema, but the registry feeds
    model tool schemas and some providers reject properties without a type.
    """
    param = _filters_param(_schema())
    variants = param["content"]["application/json"]["schema"]["items"]["anyOf"]
    for v in variants:
        field = v["properties"]["field"]["const"]
        for name, prop in v["properties"].items():
            assert prop.get("type"), f"{field}.{name} declares no type"
        assert v["properties"]["field"]["type"] == "string"
        assert v["properties"]["op"]["type"] == "string"


def test_filters_param_value_types_match_field_kinds():
    from rest.services.filters.translate import MAX_VALUE_LENGTH

    param = _filters_param(_schema())
    variants = param["content"]["application/json"]["schema"]["items"]["anyOf"]
    by_field = {v["properties"]["field"]["const"]: v for v in variants}
    # categorical: non-empty array of strings, each element length-capped
    assert by_field["model_name"]["properties"]["value"] == {
        "type": "array",
        "items": {"type": "string", "maxLength": MAX_VALUE_LENGTH},
        "minItems": 1,
    }
    # numeric: number
    # numeric: non-negative, per-column-type inclusive maximum; integer
    # columns additionally reject fractions
    assert by_field["duration_ms"]["properties"]["value"] == {
        "type": "integer",
        "minimum": 0,
        "maximum": 2**63 - 1,
    }
    assert by_field["errors"]["properties"]["value"] == {
        "type": "integer",
        "minimum": 0,
        "maximum": 2**64 - 1,
    }
    assert by_field["cost"]["properties"]["value"] == {
        "type": "number",
        "minimum": 0,
        "maximum": 10**9 - 1,
    }
    # text: the validator rejects empty strings and caps the length
    assert by_field["trace_id"]["properties"]["value"] == {
        "type": "string",
        "minLength": 1,
        "maxLength": MAX_VALUE_LENGTH,
    }
    # categorical items carry no minLength: the runtime validator permits empty
    # strings inside an 'in' list, and the schema must mirror, not exceed, it
    assert "minLength" not in by_field["model_name"]["properties"]["value"]["items"]


def test_uncurated_public_op_fails_build():
    fake = {"paths": {"/api/v1/public/new": {"get": {"operationId": "brand_new_op"}}}}
    with pytest.raises(ValueError, match="brand_new_op"):
        _apply_tool_curation(fake)


def test_stale_curation_entry_fails_build():
    # A curation entry whose operation was renamed/removed must fail the build,
    # so the map stays exactly the public operation set.
    fake = {"paths": {"/api/v1/public/whoami": {"get": {"operationId": "whoami"}}}}
    with pytest.raises(ValueError, match=r"stale _TOOL_CURATION.*list_traces"):
        _apply_tool_curation(fake)


# --- Write-tool policy curation ----------------------------------------------

_VALID_WRITE_POLICY = {"approvalClass": "none", "minRole": "MEMBER", "tenancy": "workspace"}


def test_enabled_write_entry_missing_policy_fails_build(monkeypatch):
    monkeypatch.setitem(
        openapi_public._TOOL_CURATION,
        "create_project",
        {"name": "create_project", "description": "Create a project.", "enabled": True},
    )
    with pytest.raises(ValueError, match=r"create_project.*policy"):
        build_public_schema(app)


def test_enabled_write_entry_illegal_approval_class_fails_build(monkeypatch):
    monkeypatch.setitem(
        openapi_public._TOOL_CURATION,
        "create_project",
        {
            "name": "create_project",
            "description": "Create a project.",
            "enabled": True,
            "policy": {**_VALID_WRITE_POLICY, "approvalClass": "auto"},
        },
    )
    with pytest.raises(ValueError, match=r"create_project.*policy"):
        build_public_schema(app)


@pytest.mark.parametrize("approval_class", ["none", "confirm", "approval"])
def test_enabled_write_entry_accepts_every_legal_approval_class(monkeypatch, approval_class):
    monkeypatch.setitem(
        openapi_public._TOOL_CURATION,
        "create_project",
        {
            "name": "create_project",
            "description": "Create a project.",
            "enabled": True,
            "policy": {**_VALID_WRITE_POLICY, "approvalClass": approval_class},
        },
    )
    schema = build_public_schema(app)
    tool = schema["paths"]["/api/v1/public/projects"]["post"]["x-tool"]
    assert tool["policy"]["approvalClass"] == approval_class


def test_enabled_write_entry_extra_policy_key_fails_build(monkeypatch):
    monkeypatch.setitem(
        openapi_public._TOOL_CURATION,
        "create_project",
        {
            "name": "create_project",
            "description": "Create a project.",
            "enabled": True,
            "policy": {**_VALID_WRITE_POLICY, "rateLimit": "write"},
        },
    )
    with pytest.raises(ValueError, match=r"create_project.*policy"):
        build_public_schema(app)


def test_get_entry_carrying_policy_fails_build(monkeypatch):
    # The policy vocabulary is write-only: a read tool carrying one is a
    # curation mistake, not a harmless extra.
    monkeypatch.setitem(
        openapi_public._TOOL_CURATION,
        "whoami",
        {
            "name": "whoami",
            "description": "Identify the credential.",
            "enabled": True,
            "policy": dict(_VALID_WRITE_POLICY),
        },
    )
    with pytest.raises(ValueError, match=r"whoami.*policy"):
        build_public_schema(app)


# --- Agent-hidden write params ------------------------------------------------


def test_create_project_curation_carries_agent_hidden_params():
    # trace_ttl_days stays in the public API/CLI contract; the key tells the
    # agent's tool factory to keep it out of the model-visible schema.
    tool = _schema()["paths"]["/api/v1/public/projects"]["post"]["x-tool"]
    assert tool["agentHiddenParams"] == ["trace_ttl_days"]


def test_agent_hidden_params_stale_name_fails_build(monkeypatch):
    # A hidden name that no longer exists in the request body is a curation
    # mistake (e.g. after a field rename) and must fail the build.
    entry = deepcopy(openapi_public._TOOL_CURATION["create_project"])
    entry["agentHiddenParams"] = ["not_a_body_field"]
    monkeypatch.setitem(openapi_public._TOOL_CURATION, "create_project", entry)
    with pytest.raises(ValueError, match=r"create_project.*not_a_body_field"):
        build_public_schema(app)


def test_agent_hidden_params_on_get_entry_fails_build(monkeypatch):
    entry = deepcopy(openapi_public._TOOL_CURATION["whoami"])
    entry["agentHiddenParams"] = ["anything"]
    monkeypatch.setitem(openapi_public._TOOL_CURATION, "whoami", entry)
    with pytest.raises(ValueError, match=r"whoami.*agentHiddenParams"):
        build_public_schema(app)


def test_agent_hidden_params_on_disabled_entry_fails_build(monkeypatch):
    monkeypatch.setitem(
        openapi_public._TOOL_CURATION,
        "ingest_traces",
        {"enabled": False, "agentHiddenParams": ["anything"]},
    )
    with pytest.raises(ValueError, match=r"ingest_traces.*agentHiddenParams"):
        build_public_schema(app)


@pytest.mark.parametrize("bad_value", [[], ["trace_ttl_days", 3], "trace_ttl_days"])
def test_agent_hidden_params_must_be_nonempty_string_list(monkeypatch, bad_value):
    entry = deepcopy(openapi_public._TOOL_CURATION["create_project"])
    entry["agentHiddenParams"] = bad_value
    monkeypatch.setitem(openapi_public._TOOL_CURATION, "create_project", entry)
    with pytest.raises(ValueError, match=r"create_project.*agentHiddenParams"):
        build_public_schema(app)


# The six public creates, pinned to their exact write-tool policy. approvalClass
# and minRole must match what the write service actually enforces; tenancy names
# the scope the target resource lives in. Creates are "confirm": an attended
# surface shows the proposal and waits for the user's yes.
_CREATE_TOOL_POLICIES = {
    "create_workspace": (
        "/api/v1/public/workspaces",
        {"approvalClass": "confirm", "minRole": "VIEWER", "tenancy": "account"},
    ),
    "create_project": (
        "/api/v1/public/projects",
        {"approvalClass": "confirm", "minRole": "MEMBER", "tenancy": "workspace"},
    ),
    "create_detector": (
        "/api/v1/public/detectors",
        {"approvalClass": "confirm", "minRole": "MEMBER", "tenancy": "project"},
    ),
    "create_dashboard": (
        "/api/v1/public/dashboards",
        {"approvalClass": "confirm", "minRole": "MEMBER", "tenancy": "project"},
    ),
    "create_widget": (
        "/api/v1/public/widgets",
        {"approvalClass": "confirm", "minRole": "MEMBER", "tenancy": "project"},
    ),
    "create_alert": (
        "/api/v1/public/alerts",
        {"approvalClass": "confirm", "minRole": "MEMBER", "tenancy": "project"},
    ),
}


@pytest.mark.parametrize("op_id", sorted(_CREATE_TOOL_POLICIES))
def test_create_ops_are_enabled_tools_with_pinned_policy(op_id):
    path, policy = _CREATE_TOOL_POLICIES[op_id]
    tool = _schema()["paths"][path]["post"]["x-tool"]
    assert tool["enabled"] is True
    assert tool["name"] == op_id
    assert tool["description"], f"{op_id} needs an agent-facing description"
    assert tool["policy"] == policy


# The thirteen edit operations, pinned to their exact write-tool policy. Role
# floors follow the cookie routes (renaming a workspace or changing a project's
# retention is administrative; the four project resources take MEMBER).
# Updates are "confirm" like the creates; deletes are "approval" — the class
# that parks on a destructive card attended and is blocked unattended.
_CONFIRM = "confirm"
_APPROVAL = "approval"
_EDIT_TOOL_POLICIES = {
    "update_workspace": (
        "patch",
        "/api/v1/public/workspaces/{workspace_id}",
        {"approvalClass": _CONFIRM, "minRole": "ADMIN", "tenancy": "account"},
    ),
    "update_project": (
        "patch",
        "/api/v1/public/projects/{project_id}",
        {"approvalClass": _CONFIRM, "minRole": "ADMIN", "tenancy": "workspace"},
    ),
    "update_detector": (
        "patch",
        "/api/v1/public/detectors/{detector_id}",
        {"approvalClass": _CONFIRM, "minRole": "MEMBER", "tenancy": "project"},
    ),
    "update_dashboard": (
        "patch",
        "/api/v1/public/dashboards/{dashboard_id}",
        {"approvalClass": _CONFIRM, "minRole": "MEMBER", "tenancy": "project"},
    ),
    "update_widget": (
        "patch",
        "/api/v1/public/widgets/{widget_id}",
        {"approvalClass": _CONFIRM, "minRole": "MEMBER", "tenancy": "project"},
    ),
    "update_alert": (
        "patch",
        "/api/v1/public/alerts/{alert_id}",
        {"approvalClass": _CONFIRM, "minRole": "MEMBER", "tenancy": "project"},
    ),
    "set_alert_status": (
        "patch",
        "/api/v1/public/alerts/{alert_id}/status",
        {"approvalClass": _CONFIRM, "minRole": "MEMBER", "tenancy": "project"},
    ),
    "delete_workspace": (
        "delete",
        "/api/v1/public/workspaces/{workspace_id}",
        {"approvalClass": _APPROVAL, "minRole": "ADMIN", "tenancy": "account"},
    ),
    "delete_project": (
        "delete",
        "/api/v1/public/projects/{project_id}",
        {"approvalClass": _APPROVAL, "minRole": "ADMIN", "tenancy": "workspace"},
    ),
    "delete_detector": (
        "delete",
        "/api/v1/public/detectors/{detector_id}",
        {"approvalClass": _APPROVAL, "minRole": "MEMBER", "tenancy": "project"},
    ),
    "delete_dashboard": (
        "delete",
        "/api/v1/public/dashboards/{dashboard_id}",
        {"approvalClass": _APPROVAL, "minRole": "MEMBER", "tenancy": "project"},
    ),
    "delete_widget": (
        "delete",
        "/api/v1/public/widgets/{widget_id}",
        {"approvalClass": _APPROVAL, "minRole": "MEMBER", "tenancy": "project"},
    ),
    "delete_alert": (
        "delete",
        "/api/v1/public/alerts/{alert_id}",
        {"approvalClass": _APPROVAL, "minRole": "MEMBER", "tenancy": "project"},
    ),
}


@pytest.mark.parametrize("op_id", sorted(_EDIT_TOOL_POLICIES))
def test_edit_ops_are_enabled_tools_with_pinned_policy(op_id):
    method, path, policy = _EDIT_TOOL_POLICIES[op_id]
    op = _schema()["paths"][path][method]
    tool = op["x-tool"]
    assert tool["enabled"] is True
    assert tool["name"] == op_id
    assert tool["description"], f"{op_id} needs an agent-facing description"
    assert tool["policy"] == policy
    # The shared write error contract, on top of the bearer/503 every op has.
    assert set(op["responses"]) >= {"200", "400", "401", "403", "404", "422", "503"}


def test_update_project_hides_trace_ttl_days_from_the_agent_like_create():
    tool = _schema()["paths"]["/api/v1/public/projects/{project_id}"]["patch"]["x-tool"]
    assert tool["agentHiddenParams"] == ["trace_ttl_days"]
    assert (
        "agentHiddenParams"
        not in _schema()["paths"]["/api/v1/public/projects/{project_id}"]["delete"]["x-tool"]
    )


@pytest.mark.parametrize(
    ("method", "path", "fragment"),
    [
        ("patch", "/api/v1/public/workspaces/{workspace_id}", "Name already in use"),
        ("patch", "/api/v1/public/projects/{project_id}", "Name already in use"),
        ("patch", "/api/v1/public/detectors/{detector_id}", "Name already in use"),
        ("patch", "/api/v1/public/dashboards/{dashboard_id}", "Name already in use"),
        ("patch", "/api/v1/public/alerts/{alert_id}/status", "parked"),
        ("delete", "/api/v1/public/workspaces/{workspace_id}", "typed name"),
        ("delete", "/api/v1/public/dashboards/{dashboard_id}", "last dashboard"),
    ],
)
def test_edit_ops_document_their_409(method, path, fragment):
    responses = _schema()["paths"][path][method]["responses"]
    assert fragment in responses["409"]["description"]


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("patch", "/api/v1/public/widgets/{widget_id}"),
        ("patch", "/api/v1/public/alerts/{alert_id}"),
        ("delete", "/api/v1/public/projects/{project_id}"),
        ("delete", "/api/v1/public/detectors/{detector_id}"),
        ("delete", "/api/v1/public/widgets/{widget_id}"),
        ("delete", "/api/v1/public/alerts/{alert_id}"),
    ],
)
def test_edit_ops_without_a_conflict_do_not_document_a_409(method, path):
    assert "409" not in _schema()["paths"][path][method]["responses"]


def test_deletes_take_reason_and_tenancy_in_the_query_with_no_body():
    """A DELETE has no request body: the tenancy and the required reason are
    query parameters, which is what the registry generator dispatches."""
    paths = _schema()["paths"]
    expected_query = {
        "/api/v1/public/workspaces/{workspace_id}": {"name", "reason"},
        "/api/v1/public/projects/{project_id}": {"reason"},
        "/api/v1/public/detectors/{detector_id}": {"project_id", "reason"},
        "/api/v1/public/dashboards/{dashboard_id}": {"project_id", "reason"},
        "/api/v1/public/widgets/{widget_id}": {"project_id", "reason"},
        "/api/v1/public/alerts/{alert_id}": {"project_id", "reason"},
    }
    for path, names in expected_query.items():
        op = paths[path]["delete"]
        assert "requestBody" not in op, path
        query = {p["name"]: p for p in op["parameters"] if p["in"] == "query"}
        assert set(query) == names, path
        assert all(p["required"] is True for p in query.values()), path
        reason = query["reason"]["schema"]
        assert reason["minLength"] == 3
        assert reason["maxLength"] == 500


def test_edit_tool_descriptions_state_the_patch_and_delete_semantics():
    paths = _schema()["paths"]
    for path, item in paths.items():
        for method, op in item.items():
            if method not in ("patch", "delete"):
                continue
            tool = op["x-tool"]
            if tool["name"].startswith("update_"):
                assert "untouched" in tool["description"], (method, path)
            if method == "delete":
                assert "reason" in tool["description"], (method, path)
    status = paths["/api/v1/public/alerts/{alert_id}/status"]["patch"]["x-tool"]["description"]
    assert "cold start" in status
    assert "severity" in status
    alert = paths["/api/v1/public/alerts/{alert_id}"]["patch"]["x-tool"]["description"]
    assert "evaluation state" in alert
    assert "page" in alert


def test_update_bodies_forbid_unknown_keys_and_carry_no_defaults():
    """Every PATCH body refuses unknown keys (an immutable field is a 422, not
    a silent drop) and its optional fields declare no default, so the
    generated tool schema cannot tempt a model into sending one."""
    components = _schema()["components"]["schemas"]
    for name in (
        "UpdateWorkspaceRequest",
        "UpdateProjectRequest",
        "UpdateDetectorRequest",
        "UpdateDashboardRequest",
        "UpdateWidgetRequest",
        "UpdateAlertRequest",
        "AlertStatusRequest",
    ):
        body = components[name]
        assert body["additionalProperties"] is False, name
        for field, prop in body["properties"].items():
            assert "default" not in prop, (name, field)
    assert "template" not in components["UpdateDetectorRequest"]["properties"]
    assert "type" not in components["UpdateWidgetRequest"]["properties"]
    assert components["UpdateDetectorRequest"]["required"] == ["project_id"]
    assert components["UpdateWorkspaceRequest"].get("required", []) == []


def test_update_bodies_mark_only_the_nullable_fields_as_nullable():
    """The null rule is visible in the schema: a nullable field is
    ``anyOf [T, null]`` and a non-nullable one is a bare ``T``."""
    components = _schema()["components"]["schemas"]

    def nullable(model, field):
        prop = components[model]["properties"][field]
        return any(v.get("type") == "null" for v in prop.get("anyOf", []))

    assert nullable("UpdateProjectRequest", "trace_ttl_days")
    assert not nullable("UpdateProjectRequest", "name")
    for field in ("detection_source", "detection_model", "detection_provider"):
        assert nullable("UpdateDetectorRequest", field), field
    for field in ("name", "prompt", "enabled", "sample_rate", "output_schema"):
        assert not nullable("UpdateDetectorRequest", field), field
    assert nullable("UpdateDashboardRequest", "description")
    assert nullable("UpdateWidgetRequest", "display_config")
    assert not nullable("UpdateWidgetRequest", "spec")
    assert not any(
        nullable("UpdateAlertRequest", f) for f in components["UpdateAlertRequest"]["properties"]
    )


# ── create_widget spec vocabulary (generated from the widget field registry) ──


def _create_widget_spec_variants(schema):
    spec = schema["components"]["schemas"]["CreateWidgetRequest"]["properties"]["spec"]
    return spec["anyOf"]


def test_update_widget_spec_carries_the_same_per_view_variants_as_create():
    """The update body's spec union is specialized from the widget field
    registry exactly like the create's, so both tools show the same vocabulary."""
    schemas = _schema()["components"]["schemas"]
    create = schemas["CreateWidgetRequest"]["properties"]["spec"]["anyOf"]
    update = schemas["UpdateWidgetRequest"]["properties"]["spec"]["anyOf"]
    assert update == create


def test_create_widget_spec_has_per_view_variants_and_trace_feed_ref():
    """The query dialect is one inline variant per registry view (keyed by a
    ``view`` const) plus the untouched trace_feed $ref branch."""
    variants = _create_widget_spec_variants(_schema())
    consts = [
        v["properties"]["view"]["const"]
        for v in variants
        if "properties" in v and "view" in v.get("properties", {})
    ]
    assert consts == ["spans", "traces"]
    refs = [v["$ref"] for v in variants if "$ref" in v]
    assert refs == ["#/components/schemas/TraceFeedSpec"]
    assert len(variants) == 3


def test_create_widget_spec_variants_carry_registry_enums():
    """Measure, breakdown, and filter-field enums come from the widget field
    registry, per view — never hand-listed."""
    from rest.services.widget_registry import registry_schema

    variants = _create_widget_spec_variants(_schema())
    by_view = {
        v["properties"]["view"]["const"]: v for v in variants if "view" in v.get("properties", {})
    }
    reg = registry_schema()
    assert set(by_view) == set(reg)
    for view_name, variant in by_view.items():
        fields = reg[view_name]["fields"]
        props = variant["properties"]
        measures = [n for n, f in fields.items() if f["aggs"]]
        assert props["metric"]["properties"]["measure"]["enum"] == measures
        groupables = [n for n, f in fields.items() if f["groupable"]]
        assert props["breakdown"]["enum"] == [*groupables, None]
        filterables = [n for n, f in fields.items() if f["filterOps"]]
        assert props["filters"]["items"]["properties"]["field"]["enum"] == filterables
    # The enums must genuinely differ per view (error_count is traces-only), or
    # the variants would be decoration rather than vocabulary.
    spans_measures = by_view["spans"]["properties"]["metric"]["properties"]["measure"]["enum"]
    traces_measures = by_view["traces"]["properties"]["metric"]["properties"]["measure"]["enum"]
    assert "error_count" in traces_measures and "error_count" not in spans_measures


def test_create_widget_spec_variants_declare_types_and_no_refs():
    """The inline variants feed model tool schemas: every property carries an
    explicit ``type`` and no ``$ref`` survives inside them."""

    def walk_properties(node, path, missing):
        for name, prop in (node.get("properties") or {}).items():
            if not prop.get("type"):
                missing.append(f"{path}.{name}")
            walk_properties(prop, f"{path}.{name}", missing)
            if isinstance(prop.get("items"), dict):
                walk_properties(prop["items"], f"{path}.{name}.items", missing)

    def contains_ref(node):
        if isinstance(node, dict):
            return "$ref" in node or any(contains_ref(v) for v in node.values())
        if isinstance(node, list):
            return any(contains_ref(v) for v in node)
        return False

    variants = _create_widget_spec_variants(_schema())
    inline = [v for v in variants if "$ref" not in v]
    assert len(inline) == 2
    for variant in inline:
        assert variant["type"] == "object"
        assert variant["additionalProperties"] is False
        assert not contains_ref(variant), "inline spec variant still contains a $ref"
        missing: list[str] = []
        walk_properties(variant, variant["properties"]["view"]["const"], missing)
        assert missing == [], f"properties without a type: {missing}"


def test_create_widget_spec_keeps_widget_spec_component_for_parity():
    """The WidgetSpec component stays in the document even though the spec
    union no longer references it: the frontend widget-spec-parity test anchors
    on it to guard the pydantic/zod mirror."""
    components = _schema()["components"]["schemas"]
    for name in ("WidgetSpec", "WidgetFilter", "WidgetMetric", "WidgetDisplay"):
        assert name in components
