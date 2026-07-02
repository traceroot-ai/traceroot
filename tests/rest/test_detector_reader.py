"""Unit tests for the detector findings reader service.

ClickHouse is faked (dispatches by SQL content) and the Postgres boundary
(`_pg_rows`) is monkeypatched, so these run with no live databases.
"""

import json
from datetime import datetime
from unittest.mock import MagicMock

import pytest


def _ch_result(rows):
    r = MagicMock()
    r.result_rows = rows
    return r


class FakeCH:
    """Fake ClickHouse client: count queries get count_rows, others get rows."""

    def __init__(self):
        self.calls: list[tuple] = []
        self.count_rows = [(0,)]
        self.rows: list[tuple] = []

    def query(self, query, parameters=None):
        self.calls.append((query, parameters))
        if "count(" in query.lower():
            return _ch_result(self.count_rows)
        return _ch_result(self.rows)


@pytest.fixture()
def reader(monkeypatch):
    import rest.services.detector_reader as mod

    fake = FakeCH()
    monkeypatch.setattr(mod, "get_clickhouse_client", lambda: fake)
    svc = mod.DetectorReaderService()
    return svc


def test_list_findings_parses_payload_into_summaries(reader):
    payload = json.dumps(
        [
            {
                "detectorId": "d1",
                "detectorName": "hallucination",
                "summary": "s1",
                "data": {"a": 1},
            },
            {"detectorId": "d2", "detectorName": "logic", "summary": "s2", "data": None},
        ]
    )
    reader._client.rows = [("f1", "p1", "t1", "combined", payload, datetime(2026, 6, 29, 10, 42))]
    reader._client.count_rows = [(1,)]

    items, total = reader.list_findings(
        project_id="p1", limit=50, start_after=None, end_before=None, detector=None, trace_id=None
    )

    assert total == 1
    assert len(items) == 1
    assert items[0].finding_id == "f1"
    assert items[0].detectors == ["hallucination", "logic"]
    # every query is project-scoped
    assert all(p and p.get("project_id") == "p1" for _, p in reader._client.calls)


def test_list_findings_detector_filter_includes_token_and_resolved_names(reader, monkeypatch):
    reader._client.rows = []
    reader._client.count_rows = [(0,)]
    captured = {}

    def fake_pg(sql, params):
        if "from detectors" in sql.lower():
            captured["params"] = params
            return [("My Hallucination Detector",)]
        return []

    monkeypatch.setattr(reader, "_pg_rows", fake_pg)

    reader.list_findings(
        project_id="p1",
        limit=50,
        start_after=None,
        end_before=None,
        detector="hallucination",
        trace_id=None,
    )

    name_params = [
        p["detector_names"] for _, p in reader._client.calls if p and "detector_names" in p
    ]
    assert name_params, "expected detector_names passed to ClickHouse"
    names = name_params[0]
    assert "hallucination" in names  # raw token always included
    assert "My Hallucination Detector" in names  # resolved via Postgres
    assert "p1" in captured["params"]  # resolution scoped to the project


def test_list_findings_detector_filter_matches_detector_id_without_resolution(reader, monkeypatch):
    reader._client.rows = []
    reader._client.count_rows = [(0,)]
    monkeypatch.setattr(reader, "_pg_rows", lambda sql, params: [])  # Postgres resolves nothing

    reader.list_findings(
        project_id="p1",
        limit=50,
        start_after=None,
        end_before=None,
        detector="d1",
        trace_id=None,
    )

    # The raw token is the only resolved name, and the predicate checks detectorId too,
    # so `detector=d1` can match a payload entry whose detectorId is "d1".
    queries_with_names = [q for q, p in reader._client.calls if p and "detector_names" in p]
    assert queries_with_names
    assert "detectorId" in queries_with_names[0]
    names = next(
        p["detector_names"] for _, p in reader._client.calls if p and "detector_names" in p
    )
    assert names == ["d1"]


def test_list_findings_deduplicates_before_version_sensitive_filters(reader, monkeypatch):
    reader._client.rows = []
    reader._client.count_rows = [(0,)]
    monkeypatch.setattr(reader, "_pg_rows", lambda sql, params: [])

    reader.list_findings(
        project_id="p1",
        limit=50,
        start_after=datetime(2026, 6, 1),
        end_before=None,
        detector="hallucination",
        trace_id=None,
    )

    # The version-sensitive filters (timestamp window + payload predicate) must be
    # applied to the deduped subquery, i.e. AFTER `LIMIT 1 BY finding_id` — otherwise
    # a stale finding version could be surfaced on a ReplacingMergeTree table.
    for query, _ in reader._client.calls:
        assert "LIMIT 1 BY finding_id" in query
        assert query.index("LIMIT 1 BY finding_id") < query.index("arrayExists")
        assert query.index("LIMIT 1 BY finding_id") < query.index("timestamp >=")


def test_get_finding_normalizes_results_and_attaches_rca(reader, monkeypatch):
    payload = json.dumps(
        [{"detectorId": "d1", "detectorName": "hallucination", "summary": "s", "data": {"x": 1}}]
    )
    reader._client.rows = [("f1", "p1", "t1", "sum", payload, datetime(2026, 6, 29))]

    def fake_pg(sql, params):
        s = sql.lower()
        if "from detectors" in s:
            return [("d1", "hallucination")]  # id, template
        if "from detector_rcas" in s:
            return [("done", "root cause text")]  # status, result
        return []

    monkeypatch.setattr(reader, "_pg_rows", fake_pg)

    detail = reader.get_finding("p1", "f1")

    assert detail is not None
    item = detail.results[0]
    assert (item.detector_id, item.detector_name) == ("d1", "hallucination")
    assert item.template == "hallucination"
    assert item.identified is True
    assert item.data == {"x": 1}
    assert detail.detectors == ["hallucination"]
    assert detail.rca.status == "done"
    assert detail.rca.result == "root cause text"


def test_get_finding_returns_none_when_missing(reader):
    reader._client.rows = []
    assert reader.get_finding("p1", "missing") is None


def test_get_finding_absent_rca_yields_none(reader, monkeypatch):
    payload = json.dumps([{"detectorId": "d1", "detectorName": "x", "summary": "s", "data": None}])
    reader._client.rows = [("f1", "p1", "t1", "sum", payload, datetime(2026, 6, 29))]
    monkeypatch.setattr(reader, "_pg_rows", lambda sql, params: [])

    detail = reader.get_finding("p1", "f1")

    assert detail.rca is None
    assert detail.results[0].template is None


def test_get_finding_rca_lookup_failure_still_returns_finding(reader, monkeypatch):
    payload = json.dumps([{"detectorId": "d1", "detectorName": "x", "summary": "s", "data": None}])
    reader._client.rows = [("f1", "p1", "t1", "sum", payload, datetime(2026, 6, 29))]

    def boom(sql, params):
        raise RuntimeError("postgres down")

    monkeypatch.setattr(reader, "_pg_rows", boom)

    detail = reader.get_finding("p1", "f1")  # must not raise

    assert detail is not None
    assert detail.rca is None
    assert detail.results[0].template is None


def test_get_finding_by_trace_is_project_and_trace_scoped(reader, monkeypatch):
    payload = json.dumps([{"detectorId": "d1", "detectorName": "x", "summary": "s", "data": None}])
    reader._client.rows = [("f1", "p1", "t9", "sum", payload, datetime(2026, 6, 29))]
    monkeypatch.setattr(reader, "_pg_rows", lambda sql, params: [])

    detail = reader.get_finding_by_trace("p1", "t9")

    assert detail.trace_id == "t9"
    _, params = reader._client.calls[-1]
    assert params["project_id"] == "p1"
    assert params["trace_id"] == "t9"


def test_list_detectors_returns_items_and_total(reader, monkeypatch):
    def fake_pg(sql, params):
        if "count(" in sql.lower():
            return [(2,)]
        return [
            (
                "d1",
                "My Hallucination Detector",
                "hallucination",
                True,
                datetime(2026, 6, 29, 10, 42),
            ),
            ("d2", "Failure Watch", "failure", False, datetime(2026, 6, 28, 9, 0)),
        ]

    monkeypatch.setattr(reader, "_pg_rows", fake_pg)

    items, total = reader.list_detectors(project_id="p1", limit=50)

    assert total == 2
    assert [i.detector_id for i in items] == ["d1", "d2"]
    assert items[0].name == "My Hallucination Detector"
    assert items[0].template == "hallucination"
    assert items[0].enabled is True
    assert items[1].enabled is False


def test_list_detectors_is_project_scoped_limited_and_newest_first(reader, monkeypatch):
    captured: list[tuple] = []

    def fake_pg(sql, params):
        captured.append((sql, params))
        return [(0,)] if "count(" in sql.lower() else []

    monkeypatch.setattr(reader, "_pg_rows", fake_pg)

    reader.list_detectors(project_id="p1", limit=25)

    assert captured, "expected Postgres queries"
    assert all("p1" in params for _, params in captured)  # every query project-scoped
    list_calls = [(sql, params) for sql, params in captured if "count(" not in sql.lower()]
    assert list_calls
    sql, params = list_calls[0]
    assert 25 in params  # limit forwarded
    assert "order by create_time desc" in sql.lower()  # newest first


def test_list_detectors_applies_create_time_window(reader, monkeypatch):
    captured: list[tuple] = []

    def fake_pg(sql, params):
        captured.append((sql.lower(), params))
        return [(0,)] if "count(" in sql.lower() else []

    monkeypatch.setattr(reader, "_pg_rows", fake_pg)

    reader.list_detectors(
        project_id="p1",
        limit=50,
        start_after=datetime(2026, 6, 1),
        end_before=datetime(2026, 6, 30),
    )

    # Both the count and list queries carry the inclusive-lower / exclusive-upper
    # create_time window, so pagination totals match the returned page.
    assert captured
    for sql, _params in captured:
        assert "create_time >= %s" in sql
        assert "create_time < %s" in sql


def test_get_detector_reader_service_is_singleton(monkeypatch):
    import rest.services.detector_reader as mod

    monkeypatch.setattr(mod, "get_clickhouse_client", lambda: MagicMock())
    mod._service = None
    assert mod.get_detector_reader_service() is mod.get_detector_reader_service()
