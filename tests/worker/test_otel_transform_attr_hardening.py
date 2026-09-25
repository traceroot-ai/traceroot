"""OTLP attribute values are typed, and a wrong type must not destroy an export.

Every attribute here reaches a typed ClickHouse column. A value of the wrong type
raises inside the transform or is rejected by the column, and on the public path
that happens AFTER the route returned 200 — the celery task then retries and drops
the whole S3 export, every trace in it, not just the offending span. These pin the
coercions that keep one malformed span from doing that.
"""

import base64
import json
from pathlib import Path

import pytest

from worker.otel_transform import (
    _MAX_PLAUSIBLE_TOKENS,
    first_present_number,
    get_span_kind,
    int32_or_none,
    int_or_zero,
    str_or_none,
    transform_otel_to_clickhouse,
)

# Seed for the `standard_model_prices` rows the pricing cache reads at runtime. The
# runtime source is Postgres, so this is the closest checked-in stand-in — a price
# added to the product arrives here first.
_PRICE_CATALOG = "frontend/packages/core/src/standard-model-prices.json"


@pytest.mark.parametrize("value", [7, True, ["chat"], 1.5, {"a": 1}])
def test_wrong_typed_span_kind_attributes_do_not_raise(value):
    """The three case-folded lookups previously raised AttributeError on non-str."""
    for key in ("traceroot.span.type", "openinference.span.kind", "gen_ai.operation.name"):
        assert get_span_kind({key: value}, None) == "SPAN"


@pytest.mark.parametrize(
    ("value", "expected"),
    [("llm", "LLM"), ("LLM", "LLM"), ("Llm", "LLM"), ("agent", "AGENT"), ("", "SPAN")],
)
def test_string_classification_is_unchanged_by_coercion(value, expected):
    """Coercion must not alter how real string values classify."""
    assert get_span_kind({"traceroot.span.type": value}, None) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [(12345, "12345"), (True, "True"), (["a"], "['a']"), ("kept", "kept"), (None, None)],
)
def test_string_column_attributes_are_coerced(value, expected):
    """user.id / session.id / git.* land in Nullable(String); an int fails the insert."""
    assert str_or_none(value) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (100, 100),
        (-500, 0),  # negative usage would subtract from dashboard sums
        (2**63 - 1, 0),  # Int64max: dropped, not clamped
        (10**16, 0),
        (_MAX_PLAUSIBLE_TOKENS, _MAX_PLAUSIBLE_TOKENS),  # the bound itself is kept
        (_MAX_PLAUSIBLE_TOKENS + 1, 0),
        ("abc", 0),
        (None, 0),
        ("", 0),
    ],
)
def test_token_values_outside_the_plausible_range_resolve_to_zero(value, expected):
    """Dropped rather than clamped: a clamped count is still priced and stored, so it
    would land an implausible nine-figure row in the customer's cost aggregates."""
    assert int_or_zero(value) == expected


def test_the_bound_survives_pricing_into_the_cost_column():
    """The bound is sized by `cost`, not by the Int64 token columns.

    `cost` is Decimal64(9) — Decimal(18,9), nine integer digits — so it holds strictly
    less than $10**9, the same ceiling `rest/services/filters/translate.py` derives for
    that type. A count that prices past it fails the INSERT, and on the public path the
    INSERT carries the whole batch. The worst-case rate is read from the seeded price
    catalog rather than hardcoded, so adding an expensive model fails this test instead
    of silently re-arming the overflow.
    """
    catalog = json.loads((Path(__file__).resolve().parents[2] / _PRICE_CATALOG).read_text())
    # A single span is priced across disjoint buckets, so the worst case is one model's
    # summed per-token rate, taking the dearer of the two mutually exclusive cache-write
    # tiers — not any one rate, and not a rate multiplied by the field count.
    # `or 0`, not a get() default: entries carry explicit nulls for tiers they lack.
    worst_rate = max(
        (p.get("input") or 0)
        + (p.get("output") or 0)
        + (p.get("cacheRead") or 0)
        + max(p.get("cacheWrite") or 0, p.get("cacheWrite1h") or 0)
        for p in (m["prices"] for m in catalog)
    )
    decimal64_9_ceiling = 10**9
    assert _MAX_PLAUSIBLE_TOKENS * worst_rate < decimal64_9_ceiling


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (42, 42),
        ("42", 42),
        (12.7, 12),
        ("not-a-line", None),
        (2**31, None),
        (-(2**31) - 1, None),
        ("", None),
        (None, None),
    ],
)
def test_int32_column_attributes_are_coerced_or_dropped(value, expected):
    """git.source_line lands in Nullable(Int32); a string or an out-of-range value
    is rejected by the column and takes the batch with it."""
    assert int32_or_none(value) == expected


# =============================================================================
# End-to-end: the coercion must be pinned AT ITS CALL SITES, not just as helpers.
# Testing the helpers alone leaves every call site free to regress silently --
# existing transform tests keep the lines covered, so the diff-coverage gate stays
# green while the fix is gone. These drive real OTLP payloads through the whole
# transform and assert the record field types the INSERT actually enforces.
# =============================================================================


def _payload(attrs: dict, *, span_name: str = "op", kind: str = "SPAN_KIND_INTERNAL") -> dict:
    """One-span OTLP body with `attrs` applied, shaped as MessageToDict emits it."""
    return {
        "resourceSpans": [
            {
                "scopeSpans": [
                    {
                        "scope": {"name": "test"},
                        "spans": [
                            {
                                "traceId": base64.b64encode(b"\xab" * 16).decode(),
                                "spanId": base64.b64encode(b"\x01" * 8).decode(),
                                "name": span_name,
                                "kind": kind,
                                "startTimeUnixNano": "1700000000000000000",
                                "endTimeUnixNano": "1700000001000000000",
                                "attributes": [{"key": k, "value": v} for k, v in attrs.items()],
                                "status": {"code": "STATUS_CODE_OK"},
                            }
                        ],
                    }
                ]
            }
        ]
    }


# (attribute, wrong-typed OTLP value, record it lands in, field, type the column takes)
_TYPED_SITES = [
    ("user.id", {"intValue": "42"}, "trace", "user_id", str),
    ("session.id", {"boolValue": True}, "trace", "session_id", str),
    ("traceroot.git.ref", {"intValue": "7"}, "trace", "git_ref", str),
    ("traceroot.git.repo", {"intValue": "8"}, "trace", "git_repo", str),
    ("traceroot.git.source_file", {"intValue": "3"}, "span", "git_source_file", str),
    ("traceroot.git.source_function", {"intValue": "4"}, "span", "git_source_function", str),
    ("gen_ai.request.model", {"intValue": "9"}, "span", "model_name", str),
    (
        "llm.model_name",
        {"arrayValue": {"values": [{"stringValue": "m"}]}},
        "span",
        "model_name",
        str,
    ),
    ("traceroot.git.source_line", {"stringValue": "not-a-line"}, "span", "git_source_line", int),
]


@pytest.mark.parametrize(("attr", "value", "record", "field", "column_type"), _TYPED_SITES)
def test_wrongly_typed_attribute_lands_as_the_column_type(attr, value, record, field, column_type):
    """Each typed column's extraction site must coerce; a raw value fails the INSERT."""
    traces, spans = transform_otel_to_clickhouse(_payload({attr: value}), "p1")
    rows = traces if record == "trace" else spans
    assert rows, f"{attr} produced no {record} record"
    got = rows[0].get(field)
    assert got is None or isinstance(got, column_type), (
        f"{attr} -> {field}={got!r} ({type(got).__name__}), column takes {column_type.__name__}"
    )


def test_tool_name_of_the_wrong_type_does_not_reach_the_name_column():
    """`name` is non-nullable String, and TOOL spans source it from an attribute."""
    body = _payload(
        {"traceroot.span.type": {"stringValue": "tool"}, "gen_ai.tool.name": {"intValue": "9"}}
    )
    _, spans = transform_otel_to_clickhouse(body, "p1")
    assert isinstance(spans[0]["name"], str)


def test_span_path_of_the_wrong_type_does_not_reach_the_trace_name_column():
    """The trace name candidate comes from traceroot.span.path[0], also an attribute."""
    body = _payload({"traceroot.span.path": {"arrayValue": {"values": [{"intValue": "7"}]}}})
    traces, _ = transform_otel_to_clickhouse(body, "p1")
    assert isinstance(traces[0]["name"], str)


def test_one_malformed_span_does_not_discard_its_batch_mates():
    """The whole point: the transform raising loses every trace in the S3 export,
    because the route already 200'd and the celery task retries then drops it."""
    bad = _payload({"gen_ai.request.model": {"intValue": "7"}})
    good_span = dict(bad["resourceSpans"][0]["scopeSpans"][0]["spans"][0])
    good_span["traceId"] = base64.b64encode(b"\xcc" * 16).decode()
    good_span["spanId"] = base64.b64encode(b"\x02" * 8).decode()
    good_span["attributes"] = [{"key": "traceroot.span.type", "value": {"stringValue": "llm"}}]
    bad["resourceSpans"][0]["scopeSpans"][0]["spans"].append(good_span)

    _, spans = transform_otel_to_clickhouse(bad, "p1")
    assert any(s["trace_id"] == "cc" * 16 for s in spans), "well-formed batch mate was lost"


def test_the_bound_is_not_tightened_into_a_data_loss_bug():
    """The bound has a floor as well as a ceiling: set too low it silently zeroes
    legitimate long-context spans, which no other assertion here would catch."""
    assert _MAX_PLAUSIBLE_TOKENS >= 10**8


@pytest.mark.parametrize("value", [-5, 10**12, "abc", True])
def test_a_malformed_high_priority_count_does_not_suppress_a_valid_fallback(value):
    """first_present_number and int_or_zero must agree on 'usable', else the bad
    attribute short-circuits the list AND resolves to 0, losing real usage."""
    attrs = {"llm.token_count.prompt": value, "gen_ai.usage.input_tokens": 1200}
    picked = first_present_number(attrs, ["llm.token_count.prompt", "gen_ai.usage.input_tokens"])
    assert int_or_zero(picked) == 1200
