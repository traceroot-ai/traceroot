"""Generate or verify the committed generated artifacts of the public contract:
the public OpenAPI document and the widget field registry snapshot.

  uv run python scripts/sync_public_openapi.py            # write the artifacts
  uv run python scripts/sync_public_openapi.py --check    # exit 1 if any drifts
  uv run python scripts/sync_public_openapi.py <path>     # write the OpenAPI
                                                          # document to a custom
                                                          # path (snapshot skipped)

The schema-building logic lives in `rest.openapi_public` / `rest.services.
widget_registry` so it is importable and testable; this file is just the CLI +
the canonical artifact locations.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from rest.main import app  # noqa: E402
from rest.openapi_public import build_public_schema, render  # noqa: E402
from rest.services.widget_registry import render_registry_snapshot  # noqa: E402

ARTIFACT = ROOT / "backend" / "rest" / "openapi" / "public.json"
# The frontend write service validates widget specs against this snapshot; the
# backend drift test (tests/rest/test_widget_registry.py) keeps it honest.
REGISTRY_SNAPSHOT = (
    ROOT / "frontend" / "ui" / "src" / "features" / "dashboards" / "widget-registry.generated.json"
)


def _check(artifact: Path, rendered: str, regenerate_hint: str) -> int:
    if not artifact.exists():
        print(f"Missing generated artifact: {artifact}", file=sys.stderr)
        return 1
    if artifact.read_text(encoding="utf-8") != rendered:
        print(f"{artifact.name} is stale. Regenerate with `{regenerate_hint}`.", file=sys.stderr)
        return 1
    print(f"{artifact.name} is up to date.", file=sys.stderr)
    return 0


def main(argv: list[str]) -> int:
    check = "--check" in argv
    positional = [a for a in argv if not a.startswith("-")]
    schema = build_public_schema(app)
    rendered = render(schema)
    snapshot = render_registry_snapshot()
    hint = "uv run python scripts/sync_public_openapi.py"

    if check:
        return max(_check(ARTIFACT, rendered, hint), _check(REGISTRY_SNAPSHOT, snapshot, hint))

    out = Path(positional[0]) if positional else ARTIFACT
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(rendered, encoding="utf-8")
    print(f"Wrote {len(schema['paths'])} public paths to {out}", file=sys.stderr)
    if not positional:
        REGISTRY_SNAPSHOT.write_text(snapshot, encoding="utf-8")
        print(f"Wrote widget registry snapshot to {REGISTRY_SNAPSHOT}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
