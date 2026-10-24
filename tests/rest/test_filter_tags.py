"""The Tags filter (#1748): "trace has a span carrying any of these tags".

``spans.tags`` is an array, so the membership question is ``hasAny``, not ``IN``. One
predicate with several values is ANY-match; two Tags predicates are two semi-joins ANDed
together, which gives ALL-match across predicates (Langfuse's ``?tags=`` semantics).
"""

import json
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from rest.services.filters.columns import (
    FilterLevel,
    FilterOperator,
    FilterType,
    ValueSource,
    get_column,
)
from rest.services.filters.translate import (
    MAX_VALUE_LENGTH,
    SPAN_TIME_BOUND_LOOKBACK_HOURS,
    Predicate,
    build_conditions,
    parse_filters_param,
)

# --- registry ----------------------------------------------------------------


def test_tags_is_an_array_membership_categorical():
    col = get_column("tags")
    assert col is not None
    assert col.level is FilterLevel.SPAN_ARRAY_MEMBERSHIP
    assert col.type is FilterType.CATEGORICAL
    assert col.operators == (FilterOperator.IN,)
    assert col.value_source is ValueSource.DISTINCT_QUERY
    # The element type: the parameter binds as Array(String).
    assert col.ch_type == "String"
    assert col.requires_key is False


def test_tags_is_not_a_detector_trigger_in_v1():
    """The detector evaluator does not fetch tags (#811 owns that), so offering the field
    as a trigger would build a condition that can never match."""
    assert get_column("tags").detector_trigger is False


# --- lowering ----------------------------------------------------------------


def test_tags_predicate_lowers_to_has_any_over_the_deduped_span_scan():
    params = {"project_id": "p1", "start_after": "2026-06-01 00:00:00"}
    (cond,) = build_conditions([Predicate(field="tags", op="in", value=["prod", "v2"])], params)

    assert cond.startswith("t.trace_id IN (")
    assert "FROM spans" in cond
    assert "project_id = {project_id:String}" in cond
    assert "LIMIT 1 BY project_id, trace_id, span_id" in cond
    assert (
        f"span_start_time >= {{start_after:DateTime64(3)}} - INTERVAL "
        f"{SPAN_TIME_BOUND_LOOKBACK_HOURS} HOUR" in cond
    )
    assert "WHERE hasAny(tags, {f_tags_0:Array(String)})" in cond
    # The dedup runs before the predicate, so a superseded span version cannot match.
    assert cond.index("LIMIT 1 BY") < cond.index("hasAny(")
    # Bound, never interpolated.
    assert params["f_tags_0"] == ["prod", "v2"]
    assert "prod" not in cond


def test_tags_predicate_never_uses_scalar_in():
    """`tags IN (...)` compares the whole array to strings and is a type error at
    ClickHouse; only the array lowering is correct."""
    (cond,) = build_conditions(
        [Predicate(field="tags", op="in", value=["prod"])], {"project_id": "p1"}
    )
    assert "tags IN" not in cond


def test_two_tags_predicates_are_two_semijoins_so_both_tags_are_required():
    params = {"project_id": "p1"}
    conditions = build_conditions(
        [
            Predicate(field="tags", op="in", value=["prod"]),
            Predicate(field="tags", op="in", value=["v2"]),
        ],
        params,
    )

    assert len(conditions) == 2
    assert "{f_tags_0:Array(String)}" in conditions[0]
    assert "{f_tags_1:Array(String)}" in conditions[1]
    assert params["f_tags_0"] == ["prod"]
    assert params["f_tags_1"] == ["v2"]


def test_tags_and_another_membership_field_stay_independent():
    params = {"project_id": "p1"}
    conditions = build_conditions(
        [
            Predicate(field="tags", op="in", value=["prod"]),
            Predicate(field="model_name", op="in", value=["gpt-4"]),
        ],
        params,
    )

    assert len(conditions) == 2
    assert "hasAny(tags" in conditions[0] and "model_name" not in conditions[0]
    assert "model_name IN" in conditions[1] and "tags" not in conditions[1]


# --- validation ----------------------------------------------------------------


@pytest.mark.parametrize("value", [[], "prod", [1], ["prod", None]])
def test_tags_value_must_be_a_non_empty_list_of_strings(value):
    with pytest.raises(ValueError, match="requires a non-empty list of strings"):
        build_conditions([Predicate(field="tags", op="in", value=value)], {"project_id": "p1"})


def test_tags_value_elements_are_length_capped():
    ok = "x" * MAX_VALUE_LENGTH
    build_conditions([Predicate(field="tags", op="in", value=[ok])], {"project_id": "p1"})
    with pytest.raises(ValueError):
        build_conditions([Predicate(field="tags", op="in", value=[ok + "x"])], {"project_id": "p1"})


@pytest.mark.parametrize("op", ["eq", "contains", "gt"])
def test_tags_takes_only_the_in_operator(op):
    with pytest.raises(ValueError, match="not allowed for field 'tags'"):
        build_conditions([Predicate(field="tags", op=op, value="prod")], {"project_id": "p1"})


def test_tags_round_trips_through_the_filters_param():
    (pred,) = parse_filters_param(json.dumps([{"field": "tags", "op": "in", "value": ["prod"]}]))
    assert (pred.field, pred.op, pred.value) == ("tags", "in", ["prod"])


# --- distinct values for the picker ---------------------------------------------


def _discovery_service(rows):
    from rest.services.trace_discovery import TraceDiscoveryService

    client = MagicMock()
    client.query.return_value = SimpleNamespace(result_rows=rows)
    with patch("rest.services.trace_discovery.get_clickhouse_client", return_value=client):
        service = TraceDiscoveryService()
    return service, client


def _reader_service(rows):
    from rest.services.trace_reader import TraceReaderService

    client = MagicMock()
    client.query.return_value = SimpleNamespace(result_rows=rows)
    with patch("rest.services.trace_reader.get_clickhouse_client", return_value=client):
        service = TraceReaderService()
    return service, client


# The internal dashboard router reads trace_discovery; the public router reads trace_reader.
# Both enumerate span columns, so both must unnest the array.
_SERVICES = {"discovery": _discovery_service, "reader": _reader_service}


@pytest.mark.parametrize("which", sorted(_SERVICES))
def test_tag_values_are_unnested_after_the_span_dedup(which):
    service, client = _SERVICES[which]([("prod", 3), ("v2", 1)])

    values = service.get_distinct_span_values(
        project_id="p1", column="tags", start_after=datetime(2026, 6, 1)
    )

    assert values == [{"value": "prod", "count": 3}, {"value": "v2", "count": 1}]
    query = " ".join(client.query.call_args.args[0].split())
    assert "ARRAY JOIN value" in query
    # Unnesting before LIMIT 1 BY would keep one tag per span and drop the rest.
    assert query.index("LIMIT 1 BY") < query.index("ARRAY JOIN value")


@pytest.mark.parametrize("which", sorted(_SERVICES))
def test_only_the_array_column_is_unnested(which):
    service, client = _SERVICES[which]([("x", 2)])

    service.get_distinct_span_values(
        project_id="p1", column="model_name", start_after=datetime(2026, 6, 1)
    )
    scalar_query = client.query.call_args.args[0]
    service.get_distinct_span_values(
        project_id="p1", column="tags", start_after=datetime(2026, 6, 1)
    )
    tags_query = client.query.call_args.args[0]

    assert "ARRAY JOIN" not in scalar_query
    assert "ARRAY JOIN" in tags_query
