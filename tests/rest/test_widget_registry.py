"""Tests for the widget field registry.

These tests verify the contracts that the compiler and frontend depend on,
not the internal shape of individual fields.
"""

import json
import re

from rest.services.widget_registry import REGISTRY, registry_schema

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
