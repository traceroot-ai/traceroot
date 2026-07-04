"""Tests for the public-only OpenAPI schema generation + drift guard."""

import json
from copy import deepcopy
from pathlib import Path

from rest.main import app
from rest.openapi_public import PUBLIC_PREFIX, build_public_schema, render

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
