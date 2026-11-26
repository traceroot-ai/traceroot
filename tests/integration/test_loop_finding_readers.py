"""Detector-finding readers against a live ClickHouse leave a Loop's rows out.

A Loop records each (finding, trace) as its own ``detector_findings`` row and a
completed run of its hidden detector, both with ``source = 'loop'`` (migration
017). These read the real SQL of every reader that treats a trace as having one
detector finding, on a trace that a detector flagged and a Loop cited (newer, so
a newest-first read would return it).
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

import pytest

import rest.routers.internal.detectors as detectors_router
import rest.services.detector_reader as detector_reader
from db.clickhouse.client import ClickHouseClient

from .conftest import Gateway, _insert

pytestmark = pytest.mark.integration

PROJECT = "it_loop_readers"
TRACE = "trace-cited"
LOOP_ONLY_TRACE = "trace-loop-only"
DETECTOR_AT = datetime(2026, 4, 10, 10, 0, tzinfo=UTC)
LOOP_AT = datetime(2026, 4, 10, 11, 0, tzinfo=UTC)


def _payload(detector_id: str, detector_name: str, summary: str) -> str:
    return json.dumps(
        [{"detectorId": detector_id, "detectorName": detector_name, "summary": summary}]
    )


def _finding(
    finding_id: str, trace_id: str, payload: str, ts: datetime, source: str = "detector"
) -> dict:
    return {
        "finding_id": finding_id,
        "project_id": PROJECT,
        "trace_id": trace_id,
        "summary": "s",
        "payload": payload,
        "timestamp": ts,
        "source": source,
    }


def _run(
    run_id: str,
    detector_id: str,
    trace_id: str,
    finding_id: str,
    ts: datetime,
    source: str = "detector",
) -> dict:
    return {
        "run_id": run_id,
        "detector_id": detector_id,
        "project_id": PROJECT,
        "trace_id": trace_id,
        "finding_id": finding_id,
        "status": "completed",
        "timestamp": ts,
        "used_inference": False,
        "source": source,
    }


@pytest.fixture(scope="module")
def seeded(gateway: Gateway) -> Gateway:
    _insert(
        gateway.admin,
        "detector_findings",
        [
            _finding("f-detector", TRACE, _payload("d1", "Latency", "slow"), DETECTOR_AT),
            _finding(
                "f-loop",
                TRACE,
                _payload("loop-d", "loop:Checkout", "timeouts"),
                LOOP_AT,
                "loop",
            ),
            # The row's source, not its payload, says it is a Loop's: this one
            # names its detector like any other.
            _finding(
                "f-loop-only",
                LOOP_ONLY_TRACE,
                _payload("gone-d", "Deleted", "x"),
                LOOP_AT,
                "loop",
            ),
        ],
    )
    _insert(
        gateway.admin,
        "detector_runs",
        [
            _run("run-detector", "d1", TRACE, "f-detector", DETECTOR_AT),
            _run("run-loop", "loop-d", TRACE, "f-loop", LOOP_AT, "loop"),
            _run("run-loop-only", "gone-d", LOOP_ONLY_TRACE, "f-loop-only", LOOP_AT, "loop"),
        ],
    )
    return gateway


@pytest.fixture()
def live(seeded: Gateway, monkeypatch) -> Gateway:
    client = ClickHouseClient(seeded.admin)
    monkeypatch.setattr(detectors_router, "get_clickhouse_client", lambda: client)
    monkeypatch.setattr(detector_reader, "get_clickhouse_client", lambda: client)
    return seeded


@pytest.fixture()
def reader(live: Gateway, monkeypatch) -> detector_reader.DetectorReaderService:
    svc = detector_reader.DetectorReaderService()
    monkeypatch.setattr(svc, "_pg_rows", lambda sql, params: [])
    return svc


def test_trace_findings_return_only_the_detector_finding(live):
    found = asyncio.run(detectors_router.get_trace_findings(TRACE, PROJECT))["findings"]
    assert [f["finding_id"] for f in found] == ["f-detector"]
    loop_only = asyncio.run(detectors_router.get_trace_findings(LOOP_ONLY_TRACE, PROJECT))
    assert loop_only == {"findings": []}


def test_trace_detector_runs_leave_out_loop_runs(live):
    runs = asyncio.run(detectors_router.list_trace_detector_runs(TRACE, PROJECT))["runs"]
    assert [r["run_id"] for r in runs] == ["run-detector"]
    loop_only = asyncio.run(detectors_router.list_trace_detector_runs(LOOP_ONLY_TRACE, PROJECT))
    assert loop_only == {"runs": []}


def test_finding_by_trace_is_the_detector_finding(reader):
    assert reader.get_finding_by_trace(PROJECT, TRACE).finding_id == "f-detector"
    assert reader.get_finding_by_trace(PROJECT, LOOP_ONLY_TRACE) is None


def test_finding_by_id_does_not_resolve_a_loop_row(reader):
    assert reader.get_finding(PROJECT, "f-detector").finding_id == "f-detector"
    assert reader.get_finding(PROJECT, "f-loop") is None


def test_list_findings_counts_and_lists_only_detector_findings(reader):
    items, total = reader.list_findings(
        project_id=PROJECT,
        limit=50,
        start_after=None,
        end_before=None,
        detector=None,
        trace_id=None,
    )
    assert total == 1
    assert [(i.finding_id, i.detectors) for i in items] == [("f-detector", ["Latency"])]
