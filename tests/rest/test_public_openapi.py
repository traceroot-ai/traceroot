"""Tests for the public-only OpenAPI schema generation + drift guard."""

import json
from copy import deepcopy
from pathlib import Path

import pytest

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


def test_session_read_routes_document_error_responses():
    paths = _schema()["paths"]
    assert set(paths["/api/v1/public/sessions"]["get"]["responses"]) >= {"200", "401", "500"}
    responses = paths["/api/v1/public/sessions/{session_id}"]["get"]["responses"]
    assert set(responses) >= {"200", "401", "404", "500"}
    assert responses["404"]["description"] == "Session not found"


_METHODS = {"get", "post", "put", "patch", "delete"}

EXPECTED_OPERATION_IDS = {
    "/api/v1/public/detectors": {"get": "list_detectors"},
    "/api/v1/public/detectors/findings": {"get": "list_findings"},
    "/api/v1/public/detectors/findings/{finding_id}": {"get": "get_finding"},
    "/api/v1/public/detectors/traces/{trace_id}/finding": {"get": "get_finding_by_trace"},
    "/api/v1/public/sessions": {"get": "list_sessions"},
    "/api/v1/public/sessions/{session_id}": {"get": "get_session"},
    "/api/v1/public/traces": {"get": "list_traces", "post": "ingest_traces"},
    "/api/v1/public/traces/filter-values/{field}": {"get": "list_trace_filter_values"},
    "/api/v1/public/traces/{trace_id}": {"get": "get_trace"},
    "/api/v1/public/traces/{trace_id}/export": {"get": "export_trace"},
    "/api/v1/public/whoami": {"get": "whoami"},
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
    assert disabled == {"ingest_traces"}
    assert set(enabled) == {
        "whoami",
        "list_traces",
        "list_trace_filter_values",
        "get_trace",
        "export_trace",
        "list_sessions",
        "get_session",
        "list_detectors",
        "list_findings",
        "get_finding",
        "get_finding_by_trace",
    }
    for name, tool in enabled.items():
        assert tool["description"], f"{name} needs an agent-facing description"


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
    variants = inner["items"]["anyOf"]
    assert len(variants) == len(FILTER_COLUMNS)
    by_field = {v["properties"]["field"]["const"]: v for v in variants}
    assert set(by_field) == {c.name for c in FILTER_COLUMNS}
    for col in FILTER_COLUMNS:
        v = by_field[col.name]
        assert v["properties"]["op"]["enum"] == [str(o) for o in col.operators]
        assert v["required"] == ["field", "op", "value"]
        assert v["additionalProperties"] is False


def test_filters_param_value_types_match_field_kinds():
    param = _filters_param(_schema())
    variants = param["content"]["application/json"]["schema"]["items"]["anyOf"]
    by_field = {v["properties"]["field"]["const"]: v for v in variants}
    # categorical: non-empty array of strings
    assert by_field["model_name"]["properties"]["value"] == {
        "type": "array",
        "items": {"type": "string"},
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
    # text: string
    # text: the validator rejects empty strings
    assert by_field["trace_id"]["properties"]["value"] == {"type": "string", "minLength": 1}
    # categorical items stay plain strings: the runtime validator permits empty
    # strings inside an 'in' list, and the schema must mirror, not exceed, it
    assert by_field["model_name"]["properties"]["value"]["items"] == {"type": "string"}


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
