"""Live check that the trace and session lists judge each trace by its latest version.

Ingest writes a trace more than once: an eager row from the first child span to export,
then the root's row with the real name, user and session and a newer ch_update_time.
Until ClickHouse merges the parts both rows are live, so a predicate applied before the
``LIMIT 1 BY`` dedup can match the superseded row and show the trace under its old name.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from db.clickhouse.client import ClickHouseClient
from rest.services.trace_reader import TraceReaderService

from .conftest import V1, V2, _insert, _trace

pytestmark = pytest.mark.integration

PROJECT = "proj_trace_versions"
PROJECT_TIE = "proj_trace_version_tie"
# Alone in its month, so no other case's rows share the partition.
ROOT_START = datetime(2026, 4, 10, 10, 0, 0, tzinfo=UTC)


def _version(project, trace_id, **kw):
    row = _trace(project, trace_id, kw.pop("start", ROOT_START), **kw)
    row.update(user_id=kw.get("user", "user-1"), session_id=kw.get("session", "session-1"))
    row.update(input=kw.get("input", ""), output=kw.get("output", ""))
    return row


@pytest.fixture(scope="module")
def reader(gateway):
    # One insert per version, as ingest writes them: ReplacingMergeTree collapses the
    # versions inside a single inserted block, which would hide the bug.
    versions = [
        _version(
            PROJECT,
            "stale-t",
            name="openai.chat",
            user="eager-user",
            session="eager-session",
            start=ROOT_START + timedelta(seconds=5),
            updated=V1,
        ),
        _version(
            PROJECT,
            "stale-t",
            name="checkout_flow",
            user="real-user",
            session="real-session",
            input="real input",
            updated=V2,
        ),
        _version(PROJECT_TIE, "tie-t", name="first", input="first input", updated=V1),
        _version(PROJECT_TIE, "tie-t", name="second", input="second input", updated=V1),
    ]
    for version in versions:
        _insert(gateway.admin, "traces", [version])
    service = TraceReaderService.__new__(TraceReaderService)
    service._client = ClickHouseClient(gateway.admin)
    return service


def test_unfiltered_list_shows_the_latest_version(reader):
    page = reader.list_traces(PROJECT)

    assert [(t["name"], t["user_id"], t["input"]) for t in page["data"]] == [
        ("checkout_flow", "real-user", "real input")
    ]
    assert page["meta"]["total"] == 1


@pytest.mark.parametrize(
    "scope",
    [{"name": "openai"}, {"search_query": "openai"}, {"user_id": "eager-user"}],
)
def test_a_predicate_never_matches_a_superseded_version(reader, scope):
    page = reader.list_traces(PROJECT, **scope)

    assert page["data"] == []
    assert page["meta"]["total"] == 0


def test_a_predicate_matching_the_latest_version_still_finds_it(reader):
    page = reader.list_traces(PROJECT, name="checkout")

    assert [t["name"] for t in page["data"]] == ["checkout_flow"]
    assert page["meta"]["total"] == 1


def test_label_candidates_judge_the_latest_version(reader):
    scope = {
        "project_id": PROJECT,
        "user_id": None,
        "start_after": None,
        "end_before": None,
        "search_query": None,
        "filters": [],
        "include_evaluations": False,
    }

    assert reader.matching_trace_ids(["stale-t"], name="openai", **scope) == []
    assert reader.matching_trace_ids(["stale-t"], name="checkout", **scope) == ["stale-t"]


def test_sessions_place_a_trace_by_its_latest_version(reader):
    sessions = reader.list_sessions(PROJECT)

    assert [(s["session_id"], s["trace_count"]) for s in sessions["data"]] == [("real-session", 1)]
    assert sessions["meta"]["total"] == 1
    assert reader.list_sessions(PROJECT, search_query="eager")["data"] == []


def test_tied_versions_are_never_mixed_in_one_row(reader):
    """Placeholder rows share one ch_update_time, so either may win; never half of each."""
    (row,) = reader.list_traces(PROJECT_TIE)["data"]

    assert (row["name"], row["input"]) in {("first", "first input"), ("second", "second input")}
