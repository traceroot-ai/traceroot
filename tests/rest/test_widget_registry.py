"""Tests for the widget field registry.

These tests verify the contracts that the compiler and frontend depend on,
not the internal shape of individual fields.
"""

import json
import re
from pathlib import Path

from rest.services.trace_reader import customer_traffic_only
from rest.services.widget_registry import REGISTRY, registry_schema, render_registry_snapshot

# The checked-in registry snapshot the frontend write service validates specs
# against; kept in lockstep with `registry_schema()` by the drift test below.
SNAPSHOT = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "ui"
    / "src"
    / "features"
    / "dashboards"
    / "widget-registry.generated.json"
)

# ── helpers ──────────────────────────────────────────────────────────────────

_REQUIRED_PARAMS = ["{project_id:String}", "{start_time:DateTime64(3)}", "{end_time:DateTime64(3)}"]


def _exposed_in_base_sql(expr: str, base_sql: str) -> bool:
    """Return True if `expr` appears as an alias or a bare selected column token."""
    if expr == "*":
        return True  # sentinel for count(*); compiler special-cases it
    # Matches " AS expr" (alias) or "expr" as a standalone token in the SELECT list
    return bool(re.search(rf"\bAS {re.escape(expr)}\b", base_sql)) or bool(
        re.search(rf"(?<![.\w]){re.escape(expr)}(?![.\w])", base_sql)
    )


# ── invariant tests ───────────────────────────────────────────────────────────


def test_every_field_expr_is_reachable_in_base_sql():
    """Each field's expr must be an alias or column token exposed by the view's base_sql."""
    for view_name, view in REGISTRY.items():
        for fname, fdef in view.fields.items():
            assert _exposed_in_base_sql(fdef.expr, view.base_sql), (
                f"{view_name}.{fname}: expr={fdef.expr!r} not found in base_sql"
            )


def test_every_base_sql_has_required_params_and_event_time():
    """Every base_sql must be scoped by the three query params and expose AS event_time."""
    for view_name, view in REGISTRY.items():
        for param in _REQUIRED_PARAMS:
            assert param in view.base_sql, f"{view_name}: missing {param}"
        assert "AS event_time" in view.base_sql, f"{view_name}: missing AS event_time"


def test_registry_schema_round_trips_as_json():
    """registry_schema() must be JSON-serialisable (no tuples, dataclasses, etc.)."""
    schema = registry_schema()
    serialised = json.dumps(schema)
    assert json.loads(serialised) == schema


def test_registry_schema_omits_expr():
    """registry_schema() must never expose internal SQL expressions to clients."""
    schema = registry_schema()
    for view_name, view_schema in schema.items():
        for fname, fschema in view_schema["fields"].items():
            assert "expr" not in fschema, f"{view_name}.{fname}: expr leaked into schema"


def test_each_view_has_count_field_and_structural_requirements():
    """Every view needs a count field, at least one groupable string dim, and one aggregatable measure."""
    for view_name, view in REGISTRY.items():
        # count field with aggs=("count",)
        assert "count" in view.fields, f"{view_name}: missing count field"
        assert view.fields["count"].aggs == ("count",), f"{view_name}: count.aggs mismatch"

        # at least one groupable string dimension
        string_dims = [f for f in view.fields.values() if f.groupable and f.type == "string"]
        assert string_dims, f"{view_name}: no groupable string dimension"

        # at least one aggregatable number measure
        number_measures = [
            f for f in view.fields.values() if f.aggs and f.type == "number" and f.expr != "*"
        ]
        assert number_measures, f"{view_name}: no aggregatable number measure"


def test_schema_histogrammable_mirrors_compiler_rule():
    """histogrammable must be true exactly for numeric non-sentinel measures.

    The builder gates its histogram display on this flag; if it drifts from
    the compiler's rule the UI either blocks a valid widget or saves one the
    engine permanently rejects.
    """
    schema = registry_schema()
    for view_name, view in REGISTRY.items():
        for fname, fdef in view.fields.items():
            expected = fdef.type == "number" and fdef.expr != "*"
            actual = schema[view_name]["fields"][fname]["histogrammable"]
            assert actual == expected, f"{view_name}.{fname}: histogrammable={actual}"
    # The concrete case that motivated the flag: count is not histogrammable.
    assert schema["spans"]["fields"]["count"]["histogrammable"] is False
    assert schema["spans"]["fields"]["cost"]["histogrammable"] is True


def test_registry_schema_exposes_cache_tokens():
    """cache_read_tokens and cache_write_tokens must be exposed on both views."""
    schema = registry_schema()
    for view in ["spans", "traces"]:
        fields = schema[view]["fields"]
        assert "cache_read_tokens" in fields, f"{view}: missing cache_read_tokens"
        assert "cache_write_tokens" in fields, f"{view}: missing cache_write_tokens"


def test_token_measures_list_components_before_total():
    """The token measures must end with the total, not wedge it in the middle.

    The builder renders fields in schema order, so the group should read as the
    component measures (input, output, cache read, cache write) followed by the
    total. Cache read/write decompose the gross input rather than adding to it,
    so the total is input + output — listed last as the umbrella figure."""
    for view in ["spans", "traces"]:
        names = list(registry_schema()[view]["fields"])
        token_order = [n for n in names if n.endswith("_tokens")]
        assert token_order == [
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
            "total_tokens",
        ], f"{view}: token measures out of order: {token_order}"


def test_every_base_relation_excludes_detector_self_traces():
    """No widget view may count detector self-traces as customer data.

    Dashboard measures (count, cost, tokens, latency, error_count) are charted as
    customer activity, so a base relation that scans spans or traces without the
    source predicate silently inflates them.

    Asserted per scan site, not as a per-view total: `traces` reads both tables, and
    comparing counts would accept two guards on one subquery and none on the other —
    which still lets detector rows through the unguarded one.
    """
    guard = customer_traffic_only()
    for view_name, view in REGISTRY.items():
        sql = view.base_sql
        # \b so a future `FROM traces_something` CTE can't be mistaken for the table.
        scans = list(re.finditer(r"FROM\s+(spans|traces)\b", sql))
        assert scans, f"{view_name}: no table scan found — has the base relation moved?"
        for scan in scans:
            # A derived table's own WHERE runs from its FROM up to its dedup; a guard
            # past that boundary belongs to a different subquery and doesn't protect
            # this one. Matched via the helper, not a literal, so changing the
            # predicate's spelling doesn't read as a missing guard.
            after = sql[scan.end() :]
            cutoff = after.find("ORDER BY")
            where_clause = after[:cutoff] if cutoff != -1 else after
            assert guard in where_clause, (
                f"{view_name}: the scan of `{scan.group(1)}` at offset {scan.start()} "
                f"has no detector guard in its own WHERE"
            )


def test_snapshot_artifact_matches_registry_schema():
    """Drift guard for the frontend snapshot: regenerate with
    `uv run python scripts/sync_public_openapi.py`."""
    assert SNAPSHOT.exists(), f"missing widget registry snapshot: {SNAPSHOT}"
    assert SNAPSHOT.read_text(encoding="utf-8") == render_registry_snapshot(), (
        "widget registry snapshot is stale — regenerate with "
        "`uv run python scripts/sync_public_openapi.py`"
    )


def test_snapshot_rendering_is_deterministic_json_of_registry_schema():
    """The snapshot is the registry schema itself (no extra envelope), rendered
    like the public OpenAPI artifact (sorted keys) so diffs stay stable."""
    rendered = render_registry_snapshot()
    assert json.loads(rendered) == registry_schema()
    assert rendered == render_registry_snapshot()
    assert rendered.endswith("\n")
