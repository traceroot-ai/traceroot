"""Generate or verify the committed public OpenAPI artifact.

  uv run python scripts/dump_public_openapi.py            # write the artifact
  uv run python scripts/dump_public_openapi.py --check    # exit 1 if it drifts
  uv run python scripts/dump_public_openapi.py <path>     # write to a custom path

The schema-building logic lives in `rest.openapi_public` so it is importable and
testable; this file is just the CLI + the canonical artifact location.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from rest.main import app  # noqa: E402
from rest.openapi_public import build_public_schema, render  # noqa: E402

ARTIFACT = ROOT / "backend" / "rest" / "openapi" / "public.json"


def main(argv: list[str]) -> int:
    check = "--check" in argv
    positional = [a for a in argv if not a.startswith("-")]
    rendered = render(build_public_schema(app))

    if check:
        if not ARTIFACT.exists():
            print(f"Missing public OpenAPI artifact: {ARTIFACT}", file=sys.stderr)
            return 1
        if ARTIFACT.read_text(encoding="utf-8") != rendered:
            print(
                "Public OpenAPI artifact is stale. Regenerate with "
                "`uv run python scripts/dump_public_openapi.py`.",
                file=sys.stderr,
            )
            return 1
        print("Public OpenAPI artifact is up to date.", file=sys.stderr)
        return 0

    out = Path(positional[0]) if positional else ARTIFACT
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(rendered, encoding="utf-8")
    print(f"Wrote {len(build_public_schema(app)['paths'])} public paths to {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
