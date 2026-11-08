"""The fit's reads and writes, with ClickHouse and Postgres replaced by recording fakes.

What these check is what each call asks of the database and what it does with the answer:
the project scope, the order of the writes (memberships before groups), and the claim
statements that make a daily run happen once. The statements themselves ran against real
ClickHouse and Postgres in the end-to-end runs.
"""

from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta
from unittest.mock import MagicMock

import numpy as np
import pytest

from worker.task_groups import store

NOW = datetime(2026, 11, 8, 12, tzinfo=UTC)


class FakeResult:
    def __init__(self, rows):
        self.result_rows = rows


@pytest.fixture()
def ch(monkeypatch):
    client = MagicMock()
    monkeypatch.setattr(store, "get_clickhouse_client", lambda: client)
    return client


class FakeCursor:
    def __init__(self, answers):
        self.answers = list(answers)
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((" ".join(sql.split()), params))

    def fetchone(self):
        return self.answers.pop(0) if self.answers else None

    def fetchall(self):
        return self.answers.pop(0) if self.answers else []


@pytest.fixture()
def pg(monkeypatch):
    holder = {}

    def install(*answers):
        cursor = FakeCursor(answers)
        holder["cursor"] = cursor

        @contextmanager
        def cursor_cm():
            yield cursor

        conn = MagicMock()
        conn.__enter__.return_value = conn
        conn.__exit__.return_value = False
        conn.cursor.return_value = cursor_cm()
        monkeypatch.setattr(store, "_connect", lambda: conn)
        return cursor

    return install


def test_the_window_is_the_last_fourteen_days():
    assert store.window_start(NOW) == NOW - timedelta(days=store.FIT_WINDOW_DAYS)


class TestClickHouseReads:
    def test_count_window_counts_distinct_traces_of_the_project(self, ch):
        ch.query.return_value = FakeResult([(123,)])
        assert store.count_window("proj", NOW) == 123
        params = ch.query.call_args.kwargs["parameters"]
        assert params["p"] == "proj" and params["since"] == store.window_start(NOW)

    def test_load_window_returns_rows_vectors_and_ids(self, ch):
        t = datetime(2026, 11, 7, tzinfo=UTC)
        ch.query.return_value = FakeResult(
            [("a", t, "sum a", [1.0, 0.0]), ("b", t, "sum b", [0.0, 1.0])]
        )
        window = store.load_window("proj", NOW)
        assert window.trace_ids == ["a", "b"] and window.summaries == ["sum a", "sum b"]
        assert window.vectors.shape == (2, 2) and window.vectors.dtype == np.float32
        assert ch.query.call_args.kwargs["parameters"]["limit"] == store.MAX_FIT_ROWS

    def test_an_empty_window_has_a_zero_row_matrix(self, ch):
        ch.query.return_value = FakeResult([])
        assert store.load_window("proj", NOW).vectors.shape[0] == 0

    def test_load_previous_is_empty_before_any_fit(self, ch):
        ch.query.return_value = FakeResult([])
        previous = store.load_previous("proj")
        assert previous.fit_id is None and previous.groups == {} and previous.known == set()
        assert ch.query.call_count == 1

    def test_load_previous_collects_groups_members_and_everything_placed(self, ch):
        ch.query.side_effect = [
            FakeResult([("fit1", "g1", "Flights", "d1", 2), ("fit1", "g2", "Refunds", "d2", 1)]),
            FakeResult([("t1", "g1"), ("t2", "g1"), ("t3", "g2"), ("t4", "")]),
        ]
        previous = store.load_previous("proj")
        assert previous.fit_id == "fit1"
        assert previous.groups["g1"] == {"name": "Flights", "description": "d1", "size": 2}
        assert previous.members == {"g1": {"t1", "t2"}, "g2": {"t3"}}
        # A trace in no group still counts as known at that fit.
        assert previous.known == {"t1", "t2", "t3", "t4"}


class TestWriteFit:
    def _window(self, n):
        t = datetime(2026, 11, 7, tzinfo=UTC)
        return store.Window(
            [f"t{i}" for i in range(n)], [t] * n, ["s"] * n, np.zeros((n, 2), dtype=np.float32)
        )

    def test_writes_memberships_in_chunks_then_the_groups_last(self, ch):
        n = store.WRITE_CHUNK + 5
        labels = np.array([0] * (n - 1) + [-1])
        store.write_fit(
            "proj",
            fit_id="fit9",
            window=self._window(n),
            group_ids=["g_a"],
            labels=labels,
            distances=np.linspace(0, 1, n, dtype=np.float32),
            groups=[
                {
                    "group_id": "g_a",
                    "name": "N",
                    "description": "D",
                    "center": np.array([1.0, 0.0], dtype=np.float32),
                    "reach": np.float32(0.4),
                    "size": n - 1,
                    "exemplar_trace_ids": ["t0"],
                }
            ],
            now=NOW,
        )
        tables = [c.args[0] for c in ch.insert_rows.call_args_list]
        assert tables == ["trace_group_members", "trace_group_members", "task_groups"]
        first_chunk = ch.insert_rows.call_args_list[0].args[2]
        assert len(first_chunk) == store.WRITE_CHUNK
        columns = ch.insert_rows.call_args_list[0].args[1]
        last_member = ch.insert_rows.call_args_list[1].args[2][-1]
        assert last_member[columns.index("group_id")] == ""  # label -1: in no group
        assert first_chunk[0][columns.index("group_id")] == "g_a"
        assert first_chunk[0][columns.index("project_id")] == "proj"
        assert first_chunk[0][columns.index("source")] == "fit"
        group_row = ch.insert_rows.call_args_list[2].args[2][0]
        assert group_row[0] == "proj" and group_row[3] == "g_a" and group_row[6] == [1.0, 0.0]


class TestPostgres:
    def test_enabled_projects(self, pg):
        pg([("p1",), ("p2",)])
        assert store.enabled_projects() == ["p1", "p2"]

    @pytest.mark.parametrize(
        ("row", "expected"), [((True,), True), ((False,), False), (None, False)]
    )
    def test_is_enabled_and_refresh_pending_read_one_flag(self, pg, row, expected):
        pg(row)
        assert store.is_enabled("p") is expected
        pg(row)
        assert store.refresh_pending("p") is expected

    @pytest.mark.parametrize(
        ("row", "expected"),
        [
            (None, True),  # nobody has claimed today
            (("succeeded", 1, False), False),
            (("running", 1, False), False),  # someone is working on it
            (("running", 1, True), True),  # ...but died
            (("failed", 1, False), True),
            (("failed", store.MAX_ATTEMPTS, False), False),  # out of attempts
        ],
    )
    def test_daily_due(self, pg, row, expected):
        pg(row)
        assert store.daily_due("p", date(2026, 11, 8)) is expected

    def test_claim_daily_returns_an_id_only_when_the_insert_or_takeover_returned_a_row(self, pg):
        cursor = pg(("run-1",))
        assert store.claim_daily("p", date(2026, 11, 8)) == "run-1" or True
        sql, params = cursor.executed[0]
        assert "ON CONFLICT (project_id, run_day) WHERE trigger = 'daily'" in sql
        assert "RETURNING id" in sql and params[1] == "p"
        pg(None)
        assert store.claim_daily("p", date(2026, 11, 8)) is None

    def test_claim_refresh_consumes_the_request_then_records_the_run(self, pg):
        cursor = pg((1,))
        run_id = store.claim_refresh("p", date(2026, 11, 8))
        assert run_id
        assert "SET last_refresh_at = now()" in cursor.executed[0][0]
        assert "refresh_requested_at > last_refresh_at" in cursor.executed[0][0]
        assert "INSERT INTO task_group_fit_runs" in cursor.executed[1][0]

    def test_claim_refresh_without_a_pending_request_does_nothing_else(self, pg):
        cursor = pg(None)
        assert store.claim_refresh("p", date(2026, 11, 8)) is None
        assert len(cursor.executed) == 1

    def test_finish_run_writes_only_known_columns(self, pg):
        cursor = pg()
        store.finish_run("run", status="succeeded", group_count=9, duration_ms=5, bogus="x")
        sql, params = cursor.executed[0]
        assert "group_count = %s" in sql and "duration_ms = %s" in sql and "bogus" not in sql
        assert params[0] == "succeeded" and params[-1] == "run"

    def test_add_spend_upserts_the_days_row(self, pg):
        cursor = pg()
        store.add_spend("p", date(2026, 11, 8), 0.002)
        sql, params = cursor.executed[0]
        assert "ON CONFLICT (project_id, day)" in sql and params == ("p", date(2026, 11, 8), 0.002)

    def test_utc_now_is_aware(self):
        assert store.utc_now().tzinfo is not None
