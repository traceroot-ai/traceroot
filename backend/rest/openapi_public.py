"""Build a deterministic, public-only OpenAPI schema for the CLI to codegen from.

The public API surface is defined by a single path prefix (`/api/v1/public/*`) —
everything the project-API-key contract exposes, including SDK ingestion. Internal
(`/api/v1/internal/*`), user-session, and project-scoped (`/api/v1/projects/*`)
routes plus `/health` are excluded. Output is rendered with sorted keys so the
committed artifact diffs cleanly and a drift check is meaningful.
"""

import copy
import json
from typing import Any

PUBLIC_PREFIX = "/api/v1/public/"
TITLE = "TraceRoot Public API"

_HTTP_METHODS = {"get", "post", "put", "patch", "delete"}
_BEARER_SCHEME = {"type": "http", "scheme": "bearer"}
_ERROR_SCHEMA = {"type": "object", "properties": {"detail": {"type": "string"}}}
_ROUTE_ERROR_RESPONSES: dict[str, dict[str, dict[str, str]]] = {
    "/api/v1/public/traces": {
        "post": {
            "400": "Invalid request body",
            "402": "Free plan limit exceeded",
            "415": "Unsupported media type",
            "500": "Storage error",
        },
        "get": {"500": "Failed to list traces"},
    },
    "/api/v1/public/traces/{trace_id}": {
        "get": {
            "400": "Invalid fields parameter",
            "404": "Trace not found",
            "500": "Failed to get trace",
        },
    },
    "/api/v1/public/traces/{trace_id}/export": {
        "get": {
            "400": "Invalid fields parameter",
            "404": "Trace not found",
            "500": "Failed to get trace",
        },
    },
    "/api/v1/public/detectors": {
        "get": {"500": "Failed to list detectors"},
    },
    "/api/v1/public/detectors/findings": {
        "get": {"500": "Failed to list findings"},
    },
    "/api/v1/public/detectors/findings/{finding_id}": {
        "get": {
            "404": "Finding not found",
            "500": "Failed to read finding",
        },
    },
    "/api/v1/public/detectors/traces/{trace_id}/finding": {
        "get": {
            "404": "Finding not found",
            "500": "Failed to read finding",
        },
    },
}


def _error_response(description: str) -> dict[str, Any]:
    return {"description": description, "content": {"application/json": {"schema": _ERROR_SCHEMA}}}


def _apply_route_error_contract(schema: dict[str, Any]) -> None:
    for path, methods in _ROUTE_ERROR_RESPONSES.items():
        path_item = schema["paths"].get(path)
        if path_item is None:
            continue
        for method, errors in methods.items():
            op = path_item.get(method)
            if op is None:
                continue
            responses = op.setdefault("responses", {})
            for code, description in errors.items():
                responses.setdefault(code, _error_response(description))


def _apply_public_contract(schema: dict[str, Any]) -> None:
    """Document contract details FastAPI can't infer from the raw-Request /
    manual-HTTPException public routes: bearer auth (required), the protobuf
    ingestion body, and the real 401/404/500 error responses.
    """
    schema.setdefault("components", {}).setdefault("securitySchemes", {})["BearerAuth"] = (
        _BEARER_SCHEME
    )

    for item in schema["paths"].values():
        for method, op in item.items():
            if method not in _HTTP_METHODS:
                continue
            # Auth is required on every public endpoint: represent it once as a
            # bearer requirement and drop the misleading optional header param.
            op["security"] = [{"BearerAuth": []}]
            params = [
                p
                for p in op.get("parameters", [])
                if not (
                    p.get("in") == "header" and (p.get("name") or "").lower() == "authorization"
                )
            ]
            if params:
                op["parameters"] = params
            else:
                op.pop("parameters", None)
            # Every public op depends on the shared API-key auth dependency, which
            # raises 401 (bad/invalid key) and 503 (auth service unavailable).
            responses = op.setdefault("responses", {})
            responses.setdefault("401", _error_response("Authentication failed"))
            responses.setdefault("503", _error_response("Authentication service unavailable"))

    # Public ingestion accepts an OTLP protobuf body (read from the raw request).
    ingest = schema["paths"].get("/api/v1/public/traces", {}).get("post")
    if ingest is not None:
        ingest["requestBody"] = {
            "required": True,
            "content": {
                "application/x-protobuf": {"schema": {"type": "string", "format": "binary"}}
            },
        }
    _apply_route_error_contract(schema)


def _collect_refs(node: Any, acc: set[str]) -> None:
    """Collect component schema names referenced by `$ref` anywhere under `node`."""
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
            acc.add(ref.rsplit("/", 1)[1])
        for value in node.values():
            _collect_refs(value, acc)
    elif isinstance(node, list):
        for value in node:
            _collect_refs(value, acc)


def build_public_schema(app: Any) -> dict[str, Any]:
    """Return the public-only OpenAPI document for `app`.

    Keeps only `/api/v1/public/*` paths and the component schemas transitively
    referenced by them, so unrelated (internal/session) model changes don't churn
    the public artifact.
    """
    full = app.openapi()
    # app.openapi() returns FastAPI's *cached* document; its path-item and
    # component-schema dicts are shared with it. _apply_public_contract mutates
    # path operations in place, so deep-copy everything that enters (and may be
    # mutated in) the public document to avoid corrupting the cached full schema.
    paths = {
        p: copy.deepcopy(item) for p, item in full["paths"].items() if p.startswith(PUBLIC_PREFIX)
    }

    all_schemas = (full.get("components") or {}).get("schemas", {})
    referenced: set[str] = set()
    _collect_refs(paths, referenced)
    # Transitively pull in nested schema references to a fixpoint.
    changed = True
    while changed:
        changed = False
        for name in list(referenced):
            schema = all_schemas.get(name)
            if schema is None:
                continue
            before = len(referenced)
            _collect_refs(schema, referenced)
            changed = changed or len(referenced) != before

    components: dict[str, Any] = {}
    if referenced:
        components["schemas"] = {
            n: copy.deepcopy(all_schemas[n]) for n in referenced if n in all_schemas
        }

    schema = {
        "openapi": full["openapi"],
        "info": {"title": TITLE, "version": full["info"]["version"]},
        "paths": paths,
        "components": components,
    }
    _apply_public_contract(schema)
    return schema


def render(schema: dict[str, Any]) -> str:
    """Deterministic serialization (sorted keys) for stable diffs / drift checks."""
    return json.dumps(schema, indent=2, sort_keys=True) + "\n"
