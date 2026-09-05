"""Drift test between the two pricing lookups' gateway-prefix lists.

Pricing resolution is implemented twice — ``worker.tokens.pricing`` prices spans at
ingest, ``frontend/packages/core/src/model-pricing/lookup.ts`` prices agent and
chat calls — with no shared contract between them (#1597). Both now normalize
gateway/router prefixes before matching, and neither side can import the other, so
a prefix added to one list and not the other silently reinstates #1556 on the half
that was missed: the model prices correctly in one surface and reads $0 in the
other, which looks like flaky cost rendering rather than a lookup gap.

The parse below asserts what it found. A regex that silently matched nothing would
make the comparison vacuous — two empty sets are always equal — which reads as
coverage while protecting nothing.
"""

import re
from pathlib import Path

import pytest

from worker.tokens.types import GATEWAY_PREFIXES

_REPO_ROOT = Path(__file__).resolve().parents[3]

LOOKUP_TS = _REPO_ROOT / "frontend" / "packages" / "core" / "src" / "model-pricing" / "lookup.ts"

requires_frontend = pytest.mark.skipif(
    not LOOKUP_TS.exists(),
    reason="frontend sources not present in this checkout",
)

# Deliberately permissive: a class like [a-z0-9_]+ silently drops any prefix
# carrying a hyphen, dot or capital, so a real drift ("vertex-ai" added to one
# side only) would vanish from the comparison instead of failing it — the exact
# silent hole this file exists to close. Everything quoted inside the
# declaration is compared, and an ill-formed entry fails loudly below.
_PREFIX_RE = re.compile(r'"([^"\n]+)"')


def _parse_ts_prefixes() -> set[str]:
    """The prefixes the TypeScript lookup strips.

    Raises ValueError when the declaration is gone, which is the loud failure a
    renamed or moved constant deserves: a soft "no match" would leave the
    comparison below asserting nothing.
    """
    source = LOOKUP_TS.read_text(encoding="utf-8")
    start = source.index("export const GATEWAY_PREFIXES")
    end = source.index("]);", start)
    return set(_PREFIX_RE.findall(source[start:end]))


@requires_frontend
def test_declaration_is_parseable():
    """Guards the guard: the parse must find a non-trivial list."""
    assert len(_parse_ts_prefixes()) > 5


@requires_frontend
def test_python_and_typescript_strip_the_same_prefixes():
    ts_prefixes = _parse_ts_prefixes()

    missing_in_ts = set(GATEWAY_PREFIXES) - ts_prefixes
    missing_in_python = ts_prefixes - set(GATEWAY_PREFIXES)

    assert not missing_in_ts, (
        f"{sorted(missing_in_ts)} are stripped by the worker but not by lookup.ts — "
        "these models will price at ingest and read $0 on the agent side"
    )
    assert not missing_in_python, (
        f"{sorted(missing_in_python)} are stripped by lookup.ts but not by the worker — "
        "these models will price for the agent and be left unpriced at ingest"
    )


@requires_frontend
def test_parse_would_see_a_prefix_that_is_not_plain_lowercase():
    """A narrower character class would drop such an entry from the comparison
    entirely, so a one-sided "vertex-ai" would read as agreement."""
    block = """export const GATEWAY_PREFIXES = new Set(["vertex-ai", "Azure", "a.b"]);"""
    assert set(_PREFIX_RE.findall(block)) == {"vertex-ai", "Azure", "a.b"}


@requires_frontend
def test_prefixes_are_lowercase_and_bare():
    """Both sides compare a lowercased path segment, so a stored prefix carrying a
    slash or capital could never match."""
    for prefix in set(GATEWAY_PREFIXES) | _parse_ts_prefixes():
        assert prefix == prefix.lower()
        assert "/" not in prefix
