"""Live check that the trace list, session and user reads filter the CURRENT trace row.

Ingest writes a placeholder ``traces`` row when a batch carries a trace's children but not
its root (name from the first span, start = that span's start, no input/output), then a
full row with a newer ``ch_update_time`` when the root arrives. Until a merge, and forever
when the two rows land on different UTC days (different sort keys), both rows are in the
table. ``get_trace`` reads the newest row. Every list read must decide which traces match
from that same row, so a filter the stale placeholder happens to satisfy (its name, its
later start time) must not resurrect it. See traceroot-ai/traceroot#2708.
"""

from __future__ import annotations

import os
import time
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from db.clickhouse.client import ClickHouseClient
from rest.schemas.dashboards import WidgetSpec
from rest.services import trace_reader
from rest.services.trace_reader import TraceReaderService
from rest.services.widget_query import compile_widget_query

from .conftest import _insert, _span

pytestmark = pytest.mark.integration

PROJECT = "proj_list_dedup"

# Every same-day pair is ONE insert block, alone in a month no other suite seeds, so it is
# one part that no merge touches: a merge of a same-day pair would collapse it to its newest
# row and every test on it would pass without testing anything.

# Same-day pair, April 2026.
SAME_DAY = "dedup-same-day"
SAME_DAY_SESSION = "dedup-session-same-day"
SAME_DAY_USER = "dedup-user-same-day"
SD_FULL_START = datetime(2026, 4, 10, 9, 59, 0, tzinfo=UTC)
SD_PLACEHOLDER_START = datetime(2026, 4, 10, 10, 1, 0, tzinfo=UTC)
SD_BOUNDARY = datetime(2026, 4, 10, 10, 0, 0, tzinfo=UTC)

# Cross-day pair, alone in February 2026, which this module merges (that partition only).
CROSS_DAY = "dedup-cross-day"
CROSS_DAY_SESSION = "dedup-session-cross-day"
CROSS_DAY_USER = "dedup-user-cross-day"
CD_FULL_START = datetime(2026, 2, 10, 23, 59, 30, tzinfo=UTC)
CD_PLACEHOLDER_START = datetime(2026, 2, 11, 0, 0, 10, tzinfo=UTC)
CD_BOUNDARY = datetime(2026, 2, 11, 0, 0, 0, tzinfo=UTC)
CD_PARTITION = 202602

# A single-row trace inside each window, so an empty result can't pass for a correct one.
CONTROLS = {
    "dedup-control-apr": datetime(2026, 4, 10, 10, 30, 0, tzinfo=UTC),
    "dedup-control-feb": datetime(2026, 2, 11, 0, 30, 0, tzinfo=UTC),
}

# Clock skew (July 2026): the root's host runs ahead, so the full row starts AFTER its placeholder.
SKEW = "dedup-skew"
SKEW_PLACEHOLDER_START = datetime(2026, 7, 12, 10, 0, 0, tzinfo=UTC)
SKEW_FULL_START = datetime(2026, 7, 12, 10, 0, 30, tzinfo=UTC)

# November 2026: a trace whose placeholder carried one session/user and whose full row
# another. The full row has trace-level I/O, so only the OLD session needs its I/O
# backfilled from spans; it shares that session/user with a quiet trace that has no I/O
# anywhere. Both traces have one span with a known cost; the moved trace's span has I/O.
MOVED = "dedup-moved"
QUIET = "dedup-quiet"
OLD_SESSION, NEW_SESSION = "dedup-session-old", "dedup-session-new"
OLD_USER, NEW_USER = "dedup-user-old", "dedup-user-new"
MOVED_FULL_START = datetime(2026, 11, 12, 12, 0, 0, tzinfo=UTC)
MOVED_PLACEHOLDER_START = datetime(2026, 11, 12, 12, 0, 10, tzinfo=UTC)
QUIET_START = datetime(2026, 11, 12, 12, 5, 0, tzinfo=UTC)
MOVED_COST, QUIET_COST = 5.0, 1.0
MOVED_SPAN_IO = ('"moved-in"', '"moved-out"')
MOVED_WINDOW = (
    datetime(2026, 11, 12, 11, 0, tzinfo=UTC),
    datetime(2026, 11, 12, 13, 0, tzinfo=UTC),
)

PLACEHOLDER_NAME = "openai.chat"
FULL_NAME = "agent_run"
FULL_INPUT = '"hello"'
FULL_OUTPUT = '"world"'


def _row(trace_id, start, name, updated, *, session, user, io=None):
    return {
        "trace_id": trace_id,
        "project_id": PROJECT,
        "trace_start_time": start,
        "name": name,
        "user_id": user,
        "session_id": session,
        "input": io[0] if io else None,
        "output": io[1] if io else None,
        "metadata": None,
        "source": "user",
        "is_evaluation": 0,
        "ch_update_time": updated,
    }


def _insert_block(admin, table: str, rows: list[dict]) -> None:
    """One insert, one part, with no insert-time dedup of the versions inside it."""
    columns = list(rows[0])
    admin.insert(
        table,
        [[r[c] for c in columns] for r in rows],
        column_names=columns,
        settings={"optimize_on_insert": 0},
    )


def _pair(
    trace_id,
    placeholder_start,
    full_start,
    *,
    session,
    user,
    new_session=None,
    new_user=None,
    io=(FULL_INPUT, FULL_OUTPUT),
):
    """Placeholder (older ch_update_time) and the full row written when the root arrived."""
    written = min(placeholder_start, full_start) + timedelta(seconds=5)
    return [
        _row(trace_id, placeholder_start, PLACEHOLDER_NAME, written, session=session, user=user),
        _row(
            trace_id,
            full_start,
            FULL_NAME,
            written + timedelta(minutes=1),
            session=new_session or session,
            user=new_user or user,
            io=io,
        ),
    ]


def _control(trace_id, start):
    return _row(
        trace_id,
        start,
        "control",
        start + timedelta(seconds=5),
        session=f"{trace_id}-session",
        user=f"{trace_id}-user",
        io=('"in"', '"out"'),
    )


@pytest.fixture(scope="module")
def seeded(gateway):
    """One insert block per month partition (see the note above the constants)."""
    admin = gateway.admin
    _insert_block(
        admin,
        "traces",
        _pair(
            SAME_DAY,
            SD_PLACEHOLDER_START,
            SD_FULL_START,
            session=SAME_DAY_SESSION,
            user=SAME_DAY_USER,
        )
        + [_control("dedup-control-apr", CONTROLS["dedup-control-apr"])],
    )
    _insert_block(
        admin,
        "traces",
        _pair(
            CROSS_DAY,
            CD_PLACEHOLDER_START,
            CD_FULL_START,
            session=CROSS_DAY_SESSION,
            user=CROSS_DAY_USER,
        )
        + [_control("dedup-control-feb", CONTROLS["dedup-control-feb"])],
    )
    _insert_block(
        admin,
        "traces",
        _pair(
            SKEW,
            SKEW_PLACEHOLDER_START,
            SKEW_FULL_START,
            session="dedup-session-skew",
            user="dedup-user-skew",
        ),
    )
    _insert_block(
        admin,
        "traces",
        _pair(
            MOVED,
            MOVED_PLACEHOLDER_START,
            MOVED_FULL_START,
            session=OLD_SESSION,
            user=OLD_USER,
            new_session=NEW_SESSION,
            new_user=NEW_USER,
        )
        + [
            _row(
                QUIET,
                QUIET_START,
                "quiet",
                QUIET_START + timedelta(seconds=5),
                session=OLD_SESSION,
                user=OLD_USER,
            )
        ],
    )
    spans = []
    for trace_id, start, cost, io in (
        (MOVED, MOVED_FULL_START, MOVED_COST, MOVED_SPAN_IO),
        (QUIET, QUIET_START, QUIET_COST, ("", "")),
    ):
        span = _span(PROJECT, f"{trace_id}-root", trace_id, start, updated=start)
        span.update(cost=Decimal(str(cost)), input=io[0], output=io[1])
        spans.append(span)
    _insert(admin, "spans", spans)
    # Cross-day rows have different sort keys, so a merge keeps both. Merge only this
    # module's own partition: a table-wide OPTIMIZE would collapse versions other tests seed.
    gateway.admin.command(f"OPTIMIZE TABLE traces PARTITION {CD_PARTITION} FINAL")
    remaining = gateway.admin.query(
        "SELECT count() FROM traces WHERE project_id = {p:String} AND trace_id = {t:String}",
        parameters={"p": PROJECT, "t": CROSS_DAY},
    ).result_rows[0][0]
    assert remaining == 2, "the cross-day pair should survive a merge as two rows"
    return gateway


@pytest.fixture
def utc():
    """Run in a UTC process.

    The service and the widget compiler bind naive-UTC datetimes, and clickhouse-connect
    reads a naive datetime as the client's LOCAL time, so on a non-UTC runner every
    window would shift.
    """
    previous = os.environ.get("TZ")
    os.environ["TZ"] = "UTC"
    time.tzset()
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = previous
        time.tzset()


@pytest.fixture
def reader(seeded, utc, monkeypatch):
    """The real service on the live test database, in a UTC process."""
    monkeypatch.setattr(
        trace_reader, "get_clickhouse_client", lambda: ClickHouseClient(seeded.admin)
    )
    return TraceReaderService()


def _current(reader: TraceReaderService, trace_id: str) -> dict:
    trace = reader.get_trace(PROJECT, trace_id)
    assert trace is not None
    # The detail read is the reference: it must already return the full row.
    assert (trace["name"], trace["input"]) == (FULL_NAME, FULL_INPUT)
    return trace


def _assert_current(row: dict, trace: dict) -> None:
    assert (row["name"], row["trace_start_time"], row["input"], row["output"]) == (
        trace["name"],
        trace["trace_start_time"],
        trace["input"],
        trace["output"],
    )


def _ids(result: dict) -> list[str]:
    return [r["trace_id"] for r in result["data"]]


def _consistent(result: dict) -> None:
    # One page holds everything here, so meta.total must equal the rows returned.
    assert result["meta"]["total"] == len(result["data"])


# --- list_traces -------------------------------------------------------------------------


@pytest.mark.parametrize("trace_id", [SAME_DAY, CROSS_DAY])
def test_unfiltered_list_shows_the_current_row(reader, trace_id):
    trace = _current(reader, trace_id)
    result = reader.list_traces(PROJECT, limit=100)
    _consistent(result)
    rows = [r for r in result["data"] if r["trace_id"] == trace_id]
    assert len(rows) == 1
    _assert_current(rows[0], trace)


@pytest.mark.parametrize("trace_id", [SAME_DAY, CROSS_DAY])
def test_name_filter_matches_only_the_current_name(reader, trace_id):
    trace = _current(reader, trace_id)

    stale = reader.list_traces(PROJECT, limit=100, name="openai")
    _consistent(stale)
    assert trace_id not in _ids(stale)

    current = reader.list_traces(PROJECT, limit=100, name="agent")
    _consistent(current)
    rows = [r for r in current["data"] if r["trace_id"] == trace_id]
    assert len(rows) == 1
    _assert_current(rows[0], trace)


@pytest.mark.parametrize("trace_id", [SAME_DAY, CROSS_DAY])
def test_search_matches_only_the_current_row(reader, trace_id):
    trace = _current(reader, trace_id)

    stale = reader.list_traces(PROJECT, limit=100, search_query="chat")
    _consistent(stale)
    assert trace_id not in _ids(stale)

    current = reader.list_traces(PROJECT, limit=100, search_query="agent_run")
    _consistent(current)
    rows = [r for r in current["data"] if r["trace_id"] == trace_id]
    assert len(rows) == 1
    _assert_current(rows[0], trace)


@pytest.mark.parametrize(
    ("trace_id", "boundary", "control"),
    [(SAME_DAY, SD_BOUNDARY, "dedup-control-apr"), (CROSS_DAY, CD_BOUNDARY, "dedup-control-feb")],
)
def test_window_uses_the_current_start_time(reader, trace_id, boundary, control):
    trace = _current(reader, trace_id)

    # The trace started before the boundary; only its placeholder starts after it.
    after = reader.list_traces(PROJECT, limit=100, start_after=boundary)
    _consistent(after)
    assert trace_id not in _ids(after)
    assert control in _ids(after)

    # A window that opens before the real start shows the trace, as get_trace has it.
    before = reader.list_traces(PROJECT, limit=100, start_after=boundary - timedelta(minutes=30))
    _consistent(before)
    rows = [r for r in before["data"] if r["trace_id"] == trace_id]
    assert len(rows) == 1
    _assert_current(rows[0], trace)


@pytest.mark.parametrize(
    ("trace_id", "full_start"), [(SAME_DAY, SD_FULL_START), (CROSS_DAY, CD_FULL_START)]
)
def test_window_ending_between_the_two_starts_keeps_the_current_row(reader, trace_id, full_start):
    """end_before past the real start but before the placeholder's: the full row decides."""
    trace = _current(reader, trace_id)
    result = reader.list_traces(
        PROJECT,
        limit=100,
        start_after=full_start - timedelta(minutes=1),
        end_before=full_start + timedelta(seconds=30),
    )
    _consistent(result)
    rows = [r for r in result["data"] if r["trace_id"] == trace_id]
    assert len(rows) == 1
    _assert_current(rows[0], trace)


# --- sessions ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("trace_id", "session", "boundary"),
    [(SAME_DAY, SAME_DAY_SESSION, SD_BOUNDARY), (CROSS_DAY, CROSS_DAY_SESSION, CD_BOUNDARY)],
)
def test_get_session_uses_the_current_row(reader, trace_id, session, boundary):
    trace = _current(reader, trace_id)

    assert reader.get_session(PROJECT, session, start_after=boundary) is None

    detail = reader.get_session(PROJECT, session, start_after=boundary - timedelta(minutes=30))
    assert detail is not None
    assert detail["trace_count"] == 1
    (row,) = detail["traces"]
    assert row["trace_id"] == trace_id
    _assert_current(row, trace)
    assert detail["first_trace_time"] == trace["trace_start_time"]


@pytest.mark.parametrize(
    ("trace_id", "session", "boundary"),
    [(SAME_DAY, SAME_DAY_SESSION, SD_BOUNDARY), (CROSS_DAY, CROSS_DAY_SESSION, CD_BOUNDARY)],
)
def test_list_sessions_uses_the_current_row(reader, trace_id, session, boundary):
    trace = _current(reader, trace_id)

    after = reader.list_sessions(PROJECT, limit=100, start_after=boundary)
    _consistent(after)
    assert session not in [s["session_id"] for s in after["data"]]

    before = reader.list_sessions(PROJECT, limit=100, start_after=boundary - timedelta(minutes=30))
    _consistent(before)
    (entry,) = [s for s in before["data"] if s["session_id"] == session]
    assert entry["trace_count"] == 1
    assert entry["first_trace_time"] == entry["last_trace_time"] == trace["trace_start_time"]
    assert (entry["input"], entry["output"]) == (trace["input"], trace["output"])


# --- users -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("trace_id", "user", "boundary"),
    [(SAME_DAY, SAME_DAY_USER, SD_BOUNDARY), (CROSS_DAY, CROSS_DAY_USER, CD_BOUNDARY)],
)
def test_list_users_uses_the_current_row(reader, trace_id, user, boundary):
    trace = _current(reader, trace_id)

    after = reader.list_users(PROJECT, limit=100, start_after=boundary)
    _consistent(after)
    assert user not in [u["user_id"] for u in after["data"]]

    before = reader.list_users(PROJECT, limit=100, start_after=boundary - timedelta(minutes=30))
    _consistent(before)
    (entry,) = [u for u in before["data"] if u["user_id"] == user]
    assert entry["trace_count"] == 1
    assert entry["last_trace_time"] == trace["trace_start_time"]


def test_window_end_uses_the_current_start_time_under_clock_skew(reader):
    """The full row starts after its placeholder: a window ending between them excludes it."""
    trace = reader.get_trace(PROJECT, SKEW)
    assert trace is not None and trace["name"] == FULL_NAME

    result = reader.list_traces(
        PROJECT,
        limit=100,
        start_after=SKEW_PLACEHOLDER_START - timedelta(minutes=5),
        end_before=SKEW_PLACEHOLDER_START + timedelta(seconds=15),
    )
    _consistent(result)
    assert SKEW not in _ids(result)

    result = reader.list_traces(
        PROJECT,
        limit=100,
        start_after=SKEW_PLACEHOLDER_START - timedelta(minutes=5),
        end_before=SKEW_FULL_START + timedelta(seconds=15),
    )
    _consistent(result)
    rows = [r for r in result["data"] if r["trace_id"] == SKEW]
    assert len(rows) == 1
    _assert_current(rows[0], trace)


# --- aggregates over a trace that moved session/user between its versions ---------------


def test_list_traces_costs_follow_the_current_rows(reader):
    start, end = MOVED_WINDOW
    result = reader.list_traces(PROJECT, limit=100, start_after=start, end_before=end)
    _consistent(result)
    costs = {r["trace_id"]: r["total_cost"] for r in result["data"]}
    assert costs == {MOVED: MOVED_COST, QUIET: QUIET_COST}


def test_list_sessions_aggregates_follow_the_current_rows(reader):
    start, end = MOVED_WINDOW
    result = reader.list_sessions(PROJECT, limit=100, start_after=start, end_before=end)
    _consistent(result)
    by_session = {s["session_id"]: s for s in result["data"]}
    assert set(by_session) == {OLD_SESSION, NEW_SESSION}

    old = by_session[OLD_SESSION]
    assert (old["trace_count"], old["total_cost"]) == (1, QUIET_COST)
    # Only the quiet trace is in the old session, and it has no I/O anywhere: the moved
    # trace's spans must not be backfilled into it through its stale placeholder.
    assert (old["input"], old["output"]) == (None, None)

    new = by_session[NEW_SESSION]
    assert (new["trace_count"], new["total_cost"]) == (1, MOVED_COST)
    assert (new["input"], new["output"]) == (FULL_INPUT, FULL_OUTPUT)


# September 2026: one session, two single-row traces with no trace-level I/O, nine days
# apart. The span I/O backfill has always read every trace of the session, not only those
# inside the list's window, and the dedup-first change must not narrow it.
SPAN_IO_SESSION = "dedup-session-span-io"
EARLY, LATE = "dedup-span-io-early", "dedup-span-io-late"
EARLY_START = datetime(2026, 9, 1, 10, 0, 0, tzinfo=UTC)
LATE_START = datetime(2026, 9, 10, 10, 0, 0, tzinfo=UTC)


@pytest.fixture(scope="module")
def span_io_session(seeded):
    rows, spans = [], []
    for trace_id, start in ((EARLY, EARLY_START), (LATE, LATE_START)):
        rows.append(
            _row(
                trace_id,
                start,
                "session-step",
                start + timedelta(seconds=5),
                session=SPAN_IO_SESSION,
                user="dedup-user-span-io",
            )
        )
        span = _span(PROJECT, f"{trace_id}-root", trace_id, start, updated=start)
        span.update(input=f'"{trace_id}-in"', output=f'"{trace_id}-out"')
        spans.append(span)
    _insert(seeded.admin, "traces", rows)
    _insert(seeded.admin, "spans", spans)


@pytest.mark.usefixtures("span_io_session")
def test_list_sessions_backfills_span_io_from_the_whole_session(reader):
    """Windowed to the later trace only: the first input still comes from the earlier
    trace, as it does on main, and the last output from the later one."""
    result = reader.list_sessions(
        PROJECT,
        limit=100,
        start_after=LATE_START - timedelta(days=2),
        end_before=LATE_START + timedelta(days=1),
    )
    session = next(s for s in result["data"] if s["session_id"] == SPAN_IO_SESSION)
    assert session["trace_count"] == 1
    assert (session["input"], session["output"]) == (f'"{EARLY}-in"', f'"{LATE}-out"')


def test_get_session_follows_the_current_rows(reader):
    detail = reader.get_session(PROJECT, OLD_SESSION, start_after=MOVED_WINDOW[0])
    assert detail is not None
    assert [t["trace_id"] for t in detail["traces"]] == [QUIET]
    assert (detail["trace_count"], detail["total_cost"]) == (1, QUIET_COST)


def test_list_users_aggregates_follow_the_current_rows(reader):
    start, end = MOVED_WINDOW
    result = reader.list_users(PROJECT, limit=100, start_after=start, end_before=end)
    _consistent(result)
    by_user = {u["user_id"]: u for u in result["data"]}
    assert (by_user[OLD_USER]["trace_count"], by_user[OLD_USER]["total_cost"]) == (1, QUIET_COST)
    assert (by_user[NEW_USER]["trace_count"], by_user[NEW_USER]["total_cost"]) == (1, MOVED_COST)


# --- dashboard widgets: the traces view's base relation ---------------------------------


def _widget_trace_count(admin, start: datetime, end: datetime) -> int:
    """A traces-count number tile over [start, end), run as the dashboard compiles it."""
    spec = WidgetSpec.model_validate(
        {
            "view": "traces",
            "filters": [],
            "metric": {"measure": "count", "agg": "count"},
            "display": {"type": "number"},
        }
    )
    sql, params = compile_widget_query(spec, project_id=PROJECT, start_time=start, end_time=end)
    result = admin.query(sql, parameters=params)
    return result.result_rows[0][result.column_names.index("value")]


@pytest.mark.parametrize(
    ("trace_id", "boundary"), [(SAME_DAY, SD_BOUNDARY), (CROSS_DAY, CD_BOUNDARY)]
)
def test_widget_window_uses_the_current_start_time(seeded, utc, trace_id, boundary):
    """Only the placeholder starts after the boundary: the tile counts the control alone."""
    assert _widget_trace_count(seeded.admin, boundary, boundary + timedelta(hours=1)) == 1


def test_widget_adjacent_windows_count_a_trace_once(seeded, utc):
    """Two tiles split at midnight add up to the tile spanning both (#2708 comment)."""
    start, end = CD_FULL_START - timedelta(minutes=1), CD_BOUNDARY + timedelta(hours=1)
    before = _widget_trace_count(seeded.admin, start, CD_BOUNDARY)
    after = _widget_trace_count(seeded.admin, CD_BOUNDARY, end)
    spanning = _widget_trace_count(seeded.admin, start, end)
    assert (before, after, spanning) == (1, 1, 2)


def test_widget_window_end_uses_the_current_start_time_under_clock_skew(seeded, utc):
    """The full row starts after its placeholder: a window ending between them is empty."""
    start = SKEW_PLACEHOLDER_START - timedelta(minutes=5)
    between = SKEW_PLACEHOLDER_START + timedelta(seconds=15)
    assert _widget_trace_count(seeded.admin, start, between) == 0
    assert _widget_trace_count(seeded.admin, start, SKEW_FULL_START + timedelta(seconds=15)) == 1


@pytest.mark.parametrize("trace_id", [SAME_DAY, CROSS_DAY, SKEW, MOVED])
def test_seed_is_what_the_tests_assume(seeded, trace_id):
    """Guard: every pair is still two physical rows, placeholder older than full.

    Without this a merge that collapsed a pair would leave its tests passing vacuously.
    """
    rows = seeded.admin.query(
        "SELECT name FROM traces WHERE project_id = {p:String} AND trace_id = {t:String} "
        "ORDER BY ch_update_time",
        parameters={"p": PROJECT, "t": trace_id},
    ).result_rows
    assert [r[0] for r in rows] == [PLACEHOLDER_NAME, FULL_NAME]
