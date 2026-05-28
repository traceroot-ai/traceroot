"""Export a public-only OpenAPI spec for the docs site.

Generates the FastAPI OpenAPI document offline (no running backend required),
filters it down to the public SDK surface, prunes unreferenced component
schemas, and writes the result to ``docs/api-reference/openapi.json``.

Run via the Makefile target so imports resolve against ``backend``:

    make export-openapi
"""

import json
from pathlib import Path
from typing import Any

from rest.main import app

# Only these paths are part of the public, externally-documented API.
PUBLIC_PATHS = {"/api/v1/public/traces", "/health"}

# Friendly metadata for the generated reference (overrides the live app's
# internal title/description without affecting runtime behavior).
INFO_TITLE = "TraceRoot Public API"
INFO_DESCRIPTION = "Public REST API for ingesting OpenTelemetry traces into TraceRoot."

SERVERS = [
    {"url": "https://app.traceroot.ai", "description": "TraceRoot Cloud"},
    {"url": "http://localhost:8000", "description": "Self-hosted backend"},
]

REPO_ROOT = Path(__file__).resolve().parents[2]
OUTPUT_PATH = REPO_ROOT / "docs" / "api-reference" / "openapi.json"


def _collect_refs(node: Any, refs: set[str]) -> None:
    """Recursively collect ``#/components/schemas/<name>`` references."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "$ref" and isinstance(value, str):
                prefix = "#/components/schemas/"
                if value.startswith(prefix):
                    refs.add(value[len(prefix) :])
            else:
                _collect_refs(value, refs)
    elif isinstance(node, list):
        for item in node:
            _collect_refs(item, refs)


def _reachable_schemas(paths: dict[str, Any], all_schemas: dict[str, Any]) -> set[str]:
    """Return the transitive closure of schemas referenced from ``paths``."""
    reachable: set[str] = set()
    _collect_refs(paths, reachable)

    frontier = set(reachable)
    while frontier:
        name = frontier.pop()
        schema = all_schemas.get(name)
        if schema is None:
            continue
        nested: set[str] = set()
        _collect_refs(schema, nested)
        new = nested - reachable
        reachable |= new
        frontier |= new

    return reachable


def build_public_spec() -> dict[str, Any]:
    spec = app.openapi()

    paths = {path: item for path, item in spec.get("paths", {}).items() if path in PUBLIC_PATHS}

    missing = PUBLIC_PATHS - set(paths)
    if missing:
        raise SystemExit(f"Expected public paths missing from OpenAPI spec: {sorted(missing)}")

    all_schemas = spec.get("components", {}).get("schemas", {})
    keep = _reachable_schemas(paths, all_schemas)
    schemas = {name: all_schemas[name] for name in sorted(keep) if name in all_schemas}

    public_spec: dict[str, Any] = {
        "openapi": spec["openapi"],
        "info": {
            **spec.get("info", {}),
            "title": INFO_TITLE,
            "description": INFO_DESCRIPTION,
        },
        "servers": SERVERS,
        "paths": paths,
    }
    if schemas:
        public_spec["components"] = {"schemas": schemas}

    return public_spec


def main() -> None:
    public_spec = build_public_spec()
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(public_spec, indent=2) + "\n")
    print(f"Wrote {OUTPUT_PATH.relative_to(REPO_ROOT)} ({len(public_spec['paths'])} paths)")


if __name__ == "__main__":
    main()
