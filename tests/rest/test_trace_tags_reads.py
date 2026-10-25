"""Tags on the read path (#1748): span reads carry the span's own tags, and trace list and
detail reads carry the union over the trace's spans, sorted."""

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from rest.schemas.public import PublicTraceDetailResponse, PublicTraceListItem
from rest.schemas.traces import (
    SpanResponse,
    SpanSkeletonResponse,
    TraceDetailResponse,
    TraceListItem,
)


def _rows(rows):
    return SimpleNamespace(result_rows=rows)


def _make_service(query_side_effect):
    from rest.services.trace_reader import TraceReaderService

    client = MagicMock()
    client.query.side_effect = query_side_effect
    with patch("rest.services.trace_reader.get_clickhouse_client", return_value=client):
        service = TraceReaderService()
    return service, client


# --- schemas -------------------------------------------------------------------


def test_every_read_schema_declares_tags_defaulting_to_empty():
    for model in (
        SpanSkeletonResponse,
        SpanResponse,
        TraceListItem,
        TraceDetailResponse,
        PublicTraceListItem,
        PublicTraceDetailResponse,
    ):
        field = model.model_fields.get("tags")
        assert field is not None, f"{model.__name__} has no tags field"
        assert field.annotation == list[str]
        assert field.default == []


def test_list_item_round_trips_tags():
    item = TraceListItem(
        trace_id="t1",
        project_id="p1",
        name="n",
        trace_start_time=datetime(2026, 6, 1),
        user_id=None,
        session_id=None,
        span_count=1,
        duration_ms=None,
        error_count=0,
        input=None,
        output=None,
        tags=["prod", "v2"],
    )
    assert item.model_dump()["tags"] == ["prod", "v2"]


# --- list ----------------------------------------------------------------------

_LIST_ROW = [
    "t1",
    "p1",
    "trace",
    datetime(2026, 6, 1),
    "u1",
    None,
    3,
    1500,
    0,
    "in",
    "out",
    10,
    20,
    0.5,
    {},
]


def test_list_unions_span_tags_per_trace_in_the_span_aggregate():
    results = iter([_rows([_LIST_ROW + [["prod", "v2"]], _LIST_ROW + [[]]]), _rows([[2]])])
    service, client = _make_service(lambda *a, **kw: next(results))

    result = service.list_traces(project_id="p1")

    assert result["data"][0]["tags"] == ["prod", "v2"]
    assert result["data"][1]["tags"] == []
    query = " ".join(client.query.call_args_list[0].args[0].split())
    agg = query[query.index("span_agg AS (") : query.index("GROUP BY trace_id")]
    assert "arraySlice(arraySort(groupUniqArrayArray(tags)), 1, 200) as tags" in agg
    # Read from the deduped span rows, so a superseded span version adds no stale tag.
    inner = agg[agg.index("FROM (") :]
    assert "tags" in inner[: inner.index("FROM spans")]
    assert "LIMIT 1 BY project_id, trace_id, span_id" in inner


def test_list_row_without_a_span_match_gets_empty_tags():
    """A trace row whose spans have not landed yet joins no span_agg row."""
    results = iter([_rows([_LIST_ROW + [None]]), _rows([[1]])])
    service, _ = _make_service(lambda *a, **kw: next(results))

    assert service.list_traces(project_id="p1")["data"][0]["tags"] == []


# --- detail --------------------------------------------------------------------


def _span_row(span_id, tags):
    return (
        span_id,
        "abc123",
        None,
        "s",
        "SPAN",
        datetime(2024, 1, 1),
        datetime(2024, 1, 1),
        "OK",
        None,
        None,
        None,
        None,
        None,
        None,
        {},
        None,
        None,
        None,
        None,
        "",
        tags,
    )


def test_detail_carries_span_tags_and_their_sorted_union():
    def side_effect(query, parameters=None):
        if "FROM traces" in query and "FROM spans" not in query:
            return _rows([("abc123", "proj", "t", datetime(2024, 1, 1)) + (None,) * 7])
        return _rows(
            [
                _span_row("span-1", ["v2", "prod"]),
                _span_row("span-2", ["beta", "prod"]),
                _span_row("span-3", []),
            ]
        )

    service, client = _make_service(side_effect)
    trace = service.get_trace("proj", "abc123")

    assert [s["tags"] for s in trace["spans"]] == [["v2", "prod"], ["beta", "prod"], []]
    assert trace["tags"] == ["beta", "prod", "v2"]
    spans_query = client.query.call_args_list[1].args[0]
    assert "error_type, tags" in " ".join(spans_query.split())
    detail = TraceDetailResponse.model_validate(trace)
    assert detail.tags == ["beta", "prod", "v2"]
    assert detail.spans[0].tags == ["v2", "prod"]


def test_detail_of_an_untagged_trace_has_empty_tags():
    def side_effect(query, parameters=None):
        if "FROM traces" in query and "FROM spans" not in query:
            return _rows([("abc123", "proj", "t", datetime(2024, 1, 1)) + (None,) * 7])
        return _rows([_span_row("span-1", [])])

    service, _ = _make_service(side_effect)
    trace = service.get_trace("proj", "abc123")

    assert trace["tags"] == []
    assert trace["spans"][0]["tags"] == []


def test_trace_tag_union_is_capped_the_same_way_in_list_and_detail():
    """Many spans with distinct tags must not make one trace row unbounded. Both reads
    return the first MAX_TRACE_TAGS tags in sort order, so they agree."""
    from rest.services.trace_reader import MAX_TRACE_TAGS

    assert MAX_TRACE_TAGS == 200
    many = [f"t{i:04d}" for i in range(MAX_TRACE_TAGS + 30)]

    def side_effect(query, parameters=None):
        if "FROM traces" in query and "FROM spans" not in query:
            return _rows([("abc123", "proj", "t", datetime(2024, 1, 1)) + (None,) * 7])
        return _rows([_span_row(f"span-{i}", many[i : i + 10]) for i in range(0, len(many), 10)])

    service, _ = _make_service(side_effect)
    trace = service.get_trace("proj", "abc123")

    assert trace["tags"] == sorted(many)[:MAX_TRACE_TAGS]
