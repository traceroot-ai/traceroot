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
    """Fake ClickHouse client, dispatching by SQL content: the run_id lookup
    (``FROM detector_runs``) gets run_rows, count queries get count_rows, and the
    finding queries get rows."""

    def __init__(self):
        self.calls: list[tuple] = []
        self.count_rows = [(0,)]
        self.rows: list[tuple] = []
        self.run_rows: list[tuple] = []  # (finding_id, [run_id, ...])

    def query(self, query, parameters=None):
        self.calls.append((query, parameters))
        if "from detector_runs" in query.lower():
            return _ch_result(self.run_rows)
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
    # A finding is per-trace; the two detectors above each produced a run.
    reader._client.run_rows = [("f1", ["run-1", "run-2"])]  # finding_id -> [run_id, ...]

    items, total = reader.list_findings(
        project_id="p1", limit=50, start_after=None, end_before=None, detector=None, trace_id=None
    )

    assert total == 1
    assert len(items) == 1
    assert items[0].finding_id == "f1"
    assert items[0].detectors == ["hallucination", "logic"]
    # All producing runs are joined back onto the finding for display.
    assert items[0].run_ids == ["run-1", "run-2"]
    # every query is project-scoped
    assert all(p and p.get("project_id") == "p1" for _, p in reader._client.calls)


def test_list_findings_run_ids_empty_when_no_run_references_the_finding(reader):
    payload = json.dumps([{"detectorId": "d1", "detectorName": "x", "summary": "s", "data": None}])
    reader._client.rows = [("f1", "p1", "t1", "sum", payload, datetime(2026, 6, 29))]
    reader._client.count_rows = [(1,)]
    reader._client.run_rows = []  # no run row references f1

    items, _ = reader.list_findings(
        project_id="p1", limit=50, start_after=None, end_before=None, detector=None, trace_id=None
    )

    assert items[0].run_ids == []


def test_list_findings_run_ids_empty_when_lookup_raises(reader):
    """The run_id lookup is a display convenience: if it throws, the finding
    still reads back with empty run_ids rather than failing the whole request."""
    payload = json.dumps([{"detectorId": "d1", "detectorName": "x", "summary": "s", "data": None}])
    reader._client.rows = [("f1", "p1", "t1", "sum", payload, datetime(2026, 6, 29))]
    reader._client.count_rows = [(1,)]

    real_query = reader._client.query

    def boom(query, parameters=None):
        if "from detector_runs" in query.lower():
            raise RuntimeError("clickhouse unavailable")
        return real_query(query, parameters)

    reader._client.query = boom

    items, _ = reader.list_findings(
        project_id="p1", limit=50, start_after=None, end_before=None, detector=None, trace_id=None
    )

    assert items[0].run_ids == []


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


def test_list_findings_places_time_filters_for_dedup_correctness(reader, monkeypatch):
    reader._client.rows = []
    reader._client.count_rows = [(0,)]
    monkeypatch.setattr(reader, "_pg_rows", lambda sql, params: [])

    reader.list_findings(
        project_id="p1",
        limit=50,
        start_after=datetime(2026, 6, 1),
        end_before=datetime(2026, 6, 30),
        detector="hallucination",
        trace_id=None,
    )

    # Filter placement is correctness- AND performance-critical on a
    # ReplacingMergeTree(timestamp):
    #   - start_after (lower bound) goes BEFORE `LIMIT 1 BY finding_id` so the
    #     dedup + count only process the window's rows; it's safe because a
    #     finding's latest version has the max timestamp.
    #   - end_before (upper bound) and the payload predicate go AFTER dedup, or a
    #     stale version could resurface a finding whose latest version is excluded.
    for query, _ in reader._client.calls:
        dedup = query.index("LIMIT 1 BY finding_id")
        assert query.index("timestamp >=") < dedup
        assert query.index("timestamp <") > dedup
        assert query.index("arrayExists") > dedup


def test_get_finding_normalizes_results_and_attaches_rca(reader, monkeypatch):
    payload = json.dumps(
        [{"detectorId": "d1", "detectorName": "hallucination", "summary": "s", "data": {"x": 1}}]
    )
    reader._client.rows = [("f1", "p1", "t1", "sum", payload, datetime(2026, 6, 29))]
    reader._client.run_rows = [("f1", ["run-9"])]

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
    assert detail.run_ids == ["run-9"]


def test_get_finding_returns_none_when_missing(reader):
    reader._client.rows = []
    assert reader.get_finding("p1", "missing") is None


def test_get_finding_compares_ids_hyphen_insensitively(reader, monkeypatch):
    """Stored ids are uuid-hyphenated but display surfaces render them dashless
    — the lookup predicate must strip hyphens from BOTH sides so either shape
    of the id resolves either shape of the stored row."""
    payload = json.dumps([{"detectorId": "d1", "detectorName": "x", "summary": "s", "data": None}])
    stored_id = "b3977f86-c96d-f250-b7b5-dd9062a94dfd"
    reader._client.rows = [(stored_id, "p1", "t1", "sum", payload, datetime(2026, 6, 29))]
    monkeypatch.setattr(reader, "_pg_rows", lambda sql, params: [])

    detail = reader.get_finding("p1", "b3977f86c96df250b7b5dd9062a94dfd")

    # The matched row is returned with its stored id untouched. The fake client
    # cannot evaluate the predicate, so the SQL itself is asserted below.
    assert detail is not None
    assert detail.finding_id == stored_id

    finding_queries = [
        (q, p) for q, p in reader._client.calls if "from detector_findings" in q.lower()
    ]
    assert finding_queries, "expected a detector_findings lookup"
    query, params = finding_queries[0]
    assert "replaceAll(finding_id, '-', '')" in query
    assert "replaceAll({finding_id:String}, '-', '')" in query
    assert params["finding_id"] == "b3977f86c96df250b7b5dd9062a94dfd"


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
    # The finding-fetch query (the one carrying trace_id) is project- and
    # trace-scoped — the trailing run_id lookup is a separate call.
    _, params = next((q, p) for q, p in reader._client.calls if p and "trace_id" in p)
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


def test_get_detector_returns_full_config_with_trigger(reader, monkeypatch):
    row = (
        "det-1",
        "Error spike",
        "failure",
        True,
        datetime(2026, 8, 1, 12, 0, 0),
        "Flag traces with elevated error rates",
        {"type": "object"},
        25,
        True,
        "claude-haiku-4-5",
        "anthropic",
        "system",
        datetime(2026, 8, 2, 9, 0, 0),
        [{"field": "root_span_finished", "op": "=", "value": True}],
    )
    captured = {}

    def fake_pg_rows(sql, params):
        captured["sql"] = sql
        captured["params"] = params
        return [row]

    monkeypatch.setattr(reader, "_pg_rows", fake_pg_rows)
    detail = reader.get_detector("proj-A", "det-1")

    assert captured["params"] == ("proj-A", "det-1")
    assert "LEFT JOIN detector_triggers" in captured["sql"]
    assert detail.detector_id == "det-1"
    assert detail.prompt == "Flag traces with elevated error rates"
    assert detail.output_schema == {"type": "object"}
    assert detail.sample_rate == 25
    assert detail.enable_rca is True
    assert detail.detection_model == "claude-haiku-4-5"
    assert detail.detection_provider == "anthropic"
    assert detail.detection_source == "system"
    assert detail.updated_at == datetime(2026, 8, 2, 9, 0, 0)
    assert detail.trigger_conditions == [{"field": "root_span_finished", "op": "=", "value": True}]


def test_get_detector_returns_none_when_missing(reader, monkeypatch):
    monkeypatch.setattr(reader, "_pg_rows", lambda sql, params: [])
    assert reader.get_detector("proj-A", "nope") is None


def test_get_detector_without_trigger_has_none_conditions(reader, monkeypatch):
    row = (
        "det-2",
        "Latency",
        "blank",
        False,
        datetime(2026, 8, 1, 12, 0, 0),
        "p",
        None,
        100,
        False,
        None,
        None,
        None,
        datetime(2026, 8, 1, 12, 0, 0),
        None,
    )
    monkeypatch.setattr(reader, "_pg_rows", lambda sql, params: [row])
    detail = reader.get_detector("proj-A", "det-2")
    assert detail.trigger_conditions is None
    assert detail.enabled is False
    assert detail.detection_model is None


# --------------------------------------------------------------------------- #
# signals
# --------------------------------------------------------------------------- #
def _two_detector_finding(reader):
    payload = json.dumps(
        [
            {"detectorId": "d1", "detectorName": "Failure", "summary": "timeout", "data": {}},
            {"detectorId": "d2", "detectorName": "Logic", "summary": "wrong city", "data": {}},
        ]
    )
    reader._client.rows = [("f1", "p1", "t1", "sum", payload, datetime(2026, 9, 30))]


def _signals_pg(own_rca=None, inherited=None, fail=None, calls=None):
    """Fake Postgres for the signal lookups; ``fail`` names a query to raise on.

    Rows come back only for project p1 and its finding f1 / signal sig-1, so a
    lookup that loses its project or finding filter finds nothing. ``calls``
    collects (sql, params) for assertions.
    """

    def fake_pg(sql, params):
        s = sql.lower()
        if calls is not None:
            calls.append((s, params))
        if fail and fail in s:
            raise RuntimeError("postgres down")
        if "from signal_hits sh join signals" in s:
            if "sh.project_id = %s" in s and params == ("p1", ["f1"]):
                return [("f1", "d1", "sig-1", "Timeout swallowed", "open")]
            return []
        if "from signal_rcas" in s:
            if "dr.project_id = %s" in s and params[:2] == (["sig-1"], "p1"):
                return inherited or []
            return []
        if "from detector_rcas" in s:
            return own_rca or []
        return []

    return fake_pg


def test_get_finding_attaches_the_signal_of_each_grouped_hit(reader, monkeypatch):
    _two_detector_finding(reader)
    calls = []
    monkeypatch.setattr(
        reader,
        "_pg_rows",
        _signals_pg(
            own_rca=[("done", "own")],
            inherited=[("sig-1", "- Root cause: the signal's", "trace-first")],
            calls=calls,
        ),
    )
    detail = reader.get_finding("p1", "f1")
    signal_lookups = [p for sql, p in calls if "from signal_hits sh join signals" in sql]
    assert signal_lookups == [("p1", ["f1"])]
    first, second = detail.results
    assert (first.signal_id, first.signal_title, first.signal_status) == (
        "sig-1",
        "Timeout swallowed",
        "open",
    )
    # Not grouped (signals off, or not assigned yet): no signal.
    assert (second.signal_id, second.signal_title, second.signal_status) == (None, None, None)
    assert [s.signal_id for s in detail.signals] == ["sig-1"]
    # The finding's own RCA wins over the signal's, which is not even read.
    assert detail.rca.result == "own" and detail.rca.inherited is False
    assert not any("from signal_rcas" in sql for sql, _ in calls)


def test_get_finding_inherits_the_signal_rca_when_it_ran_none(reader, monkeypatch):
    _two_detector_finding(reader)
    calls = []
    monkeypatch.setattr(
        reader,
        "_pg_rows",
        _signals_pg(
            inherited=[("sig-1", "- Root cause: swallowed timeout", "trace-first")], calls=calls
        ),
    )
    detail = reader.get_finding("p1", "f1")
    assert [p for sql, p in calls if "from signal_rcas" in sql] == [(["sig-1"], "p1")]
    assert detail.rca.status == "done"
    assert detail.rca.inherited is True
    assert detail.rca.result.startswith('## Failure: signal "Timeout swallowed"')
    assert "The signal's RCA, from trace trace-first:" in detail.rca.result
    assert detail.rca.result.endswith("- Root cause: swallowed timeout")


def test_inherited_rca_reads_the_answer_kept_on_the_opening(reader, monkeypatch):
    """The signal's answer is the one kept on its opening, not the shared finding's
    latest attempt, which a later signal on the same trace resets and may fail."""
    _two_detector_finding(reader)
    calls = []
    monkeypatch.setattr(reader, "_pg_rows", _signals_pg(inherited=[], calls=calls))
    reader.get_finding("p1", "f1")
    sql = next(sql for sql, _ in calls if "from signal_rcas" in sql)
    assert "sr.result is not null" in sql
    assert "dr.status" not in sql
    assert "sr.signal_id, sr.result," in sql


@pytest.mark.parametrize("status", ["failed", "pending"])
def test_get_finding_keeps_the_last_successful_answer_while_a_later_attempt_is_not_done(
    reader, monkeypatch, status
):
    """A later signal on the same trace resets the finding's RCA, and that attempt
    may fail; the answer kept on the finding's openings still stands for it."""
    _two_detector_finding(reader)
    calls = []

    def fake_pg(sql, params):
        s = sql.lower()
        calls.append((s, params))
        if "from signal_rcas sr join detector_rcas" in s and "sr.finding_id = %s" in s:
            return [("- Root cause: kept answer",)] if params == ("p1", "f1") else []
        if "from detector_rcas" in s:
            return [(status, None)]
        return []

    monkeypatch.setattr(reader, "_pg_rows", fake_pg)
    detail = reader.get_finding("p1", "f1")
    assert (detail.rca.status, detail.rca.result) == ("done", "- Root cause: kept answer")
    assert detail.rca.inherited is False
    kept_sql = next(s for s, _ in calls if "sr.finding_id = %s" in s)
    assert "dr.project_id = %s" in kept_sql and "sr.result is not null" in kept_sql
    assert "order by sr.create_time desc" in kept_sql


def test_get_finding_reports_the_latest_attempt_when_the_kept_answer_lookup_fails(
    reader, monkeypatch
):
    _two_detector_finding(reader)
    monkeypatch.setattr(
        reader,
        "_pg_rows",
        _signals_pg(own_rca=[("pending", None)], fail="from signal_rcas sr join detector_rcas"),
    )
    detail = reader.get_finding("p1", "f1")
    assert (detail.rca.status, detail.rca.result) == ("pending", None)


def test_get_finding_reports_a_failed_attempt_when_no_answer_was_kept(reader, monkeypatch):
    _two_detector_finding(reader)
    monkeypatch.setattr(reader, "_pg_rows", _signals_pg(own_rca=[("failed", None)]))
    detail = reader.get_finding("p1", "f1")
    assert (detail.rca.status, detail.rca.result) == ("failed", None)


@pytest.mark.parametrize("plan", [None, "enterprise"])
def test_inherited_rca_reads_any_age_without_a_retention_limit(reader, monkeypatch, plan):
    _two_detector_finding(reader)
    calls = []
    monkeypatch.setattr(reader, "_pg_rows", _signals_pg(inherited=[], calls=calls))
    reader.get_finding("p1", "f1", plan)
    sql, params = next((sql, p) for sql, p in calls if "from signal_rcas" in sql)
    assert "rh.seen_at >= %s" not in sql
    assert params == (["sig-1"], "p1")


def test_inherited_rca_is_read_only_from_findings_inside_the_plans_retention(reader, monkeypatch):
    """The answer comes from another trace; a plan sees it only while that trace's
    finding is inside its retention window, as for the finding itself."""
    _two_detector_finding(reader)
    calls = []
    monkeypatch.setattr(reader, "_pg_rows", _signals_pg(inherited=[], calls=calls))
    reader.get_finding_by_trace("p1", "t1", "free")
    sql, params = next((sql, p) for sql, p in calls if "from signal_rcas" in sql)
    assert "exists (select 1 from signal_hits rh" in sql and "rh.seen_at >= %s" in sql
    assert params[:2] == (["sig-1"], "p1")
    cutoff = params[2]
    assert isinstance(cutoff, datetime)
    assert abs((datetime.utcnow() - cutoff).days - 15) <= 1


def test_get_finding_has_no_rca_when_the_signal_has_no_finished_one(reader, monkeypatch):
    _two_detector_finding(reader)
    monkeypatch.setattr(reader, "_pg_rows", _signals_pg(inherited=[]))
    assert reader.get_finding("p1", "f1").rca is None


def test_signal_lookup_failures_degrade_to_null(reader, monkeypatch):
    _two_detector_finding(reader)
    monkeypatch.setattr(reader, "_pg_rows", _signals_pg(fail="from signal_hits sh join signals"))
    detail = reader.get_finding("p1", "f1")
    assert detail.results[0].signal_id is None and detail.signals == []

    monkeypatch.setattr(reader, "_pg_rows", _signals_pg(fail="from signal_rcas"))
    assert reader.get_finding("p1", "f1").rca is None


def test_list_findings_lists_each_findings_signals(reader, monkeypatch):
    _two_detector_finding(reader)
    reader._client.count_rows = [(1,)]
    monkeypatch.setattr(reader, "_pg_rows", _signals_pg())
    items, _ = reader.list_findings("p1", 10, None, None, None, None)
    assert [(s.detector_id, s.signal_id) for s in items[0].signals] == [("d1", "sig-1")]
