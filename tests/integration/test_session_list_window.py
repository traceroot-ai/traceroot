"""Live check that the session list describes only the traces in the requested window.

When a session's traces carry no trace-level input/output, ``list_sessions`` fills it in
from their spans. That second scan must see the same traces as the row's counts: a trace
outside the window, or past the retention cutoff the routers clamp ``start_after`` to,
must not supply the input a session is listed with.
"""

from __future__ import annotations

from datetime import timedelta
from unittest.mock import patch

import pytest

from db.clickhouse.client import ClickHouseClient

from .conftest import T0, _insert, _span, _trace

pytestmark = pytest.mark.integration

PROJECT = "proj_session_window"
SESSION = "session-window"


@pytest.fixture(scope="module")
def seeded_session(gateway):
    """One session: an old trace outside the window and a recent one inside it."""
    old, new = T0 - timedelta(days=10), T0
    _insert(
        gateway.admin,
        "traces",
        [
            {**_trace(PROJECT, "win-old", old), "session_id": SESSION},
            {**_trace(PROJECT, "win-new", new), "session_id": SESSION},
        ],
    )
    _insert(
        gateway.admin,
        "spans",
        [
            {**_span(PROJECT, "win-old-s", "win-old", old), "input": "OLD-IN", "output": "OLD-OUT"},
            {**_span(PROJECT, "win-new-s", "win-new", new), "input": "NEW-IN", "output": "NEW-OUT"},
        ],
    )


@pytest.mark.usefixtures("seeded_session")
def test_session_io_comes_from_traces_in_the_window(gateway):
    from rest.services.trace_reader import TraceReaderService

    with patch(
        "rest.services.trace_reader.get_clickhouse_client",
        return_value=ClickHouseClient(gateway.admin),
    ):
        service = TraceReaderService()

    # A day either side of the recent trace; the old one is ten days out.
    result = service.list_sessions(
        PROJECT, start_after=T0 - timedelta(days=1), end_before=T0 + timedelta(days=1)
    )

    [row] = result["data"]
    assert row["trace_count"] == 1
    assert (row["input"], row["output"]) == ("NEW-IN", "NEW-OUT")
