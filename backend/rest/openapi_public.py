"""Build a deterministic, public-only OpenAPI schema for the CLI to codegen from.

The public API surface is defined by a single path prefix (`/api/v1/public/*`) —
everything the project-API-key contract exposes, including SDK ingestion. Internal
(`/api/v1/internal/*`), user-session, and project-scoped (`/api/v1/projects/*`)
routes plus `/health` are excluded. Output is rendered with sorted keys so the
committed artifact diffs cleanly and a drift check is meaningful.
"""

import json
from typing import Any

PUBLIC_PREFIX = "/api/v1/public/"
TITLE = "TraceRoot Public API"


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
    paths = {p: item for p, item in full["paths"].items() if p.startswith(PUBLIC_PREFIX)}

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
        components["schemas"] = {n: all_schemas[n] for n in referenced if n in all_schemas}

    return {
        "openapi": full["openapi"],
        "info": {"title": TITLE, "version": full["info"]["version"]},
        "paths": paths,
        "components": components,
    }


def render(schema: dict[str, Any]) -> str:
    """Deterministic serialization (sorted keys) for stable diffs / drift checks."""
    return json.dumps(schema, indent=2, sort_keys=True) + "\n"
