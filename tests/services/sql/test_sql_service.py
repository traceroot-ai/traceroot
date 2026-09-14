"""Tests for the SQL Gateway execution seam.

No database. A fake client records what it was asked to run and hands back what
each test wants, which is enough to pin the three things that matter here: what
SQL leaves this process, how many rows come back, and what a failure tells the
caller.
"""

from __future__ import annotations

from typing import Any

import pytest
from clickhouse_connect.driver.exceptions import ClickHouseError

from rest.services.sql.errors import SqlExecutionError, SqlValidationError
from rest.services.sql.service import (
    SqlQueryService,
    classify_ch_error,
)

PID = "acme_corp:proj.123-abc"


class FakeResult:
    def __init__(self, rows: list[list[Any]], columns: list[str] | None = None) -> None:
        self.result_rows = rows
        self.column_names = columns or ["span_id"]
        self.column_types = ["String"] * len(self.column_names)
        self.summary = {"read_rows": "42", "read_bytes": "4096"}


class FakeClient:
    """Records the call and returns canned rows, or raises what it was given."""

    def __init__(self, rows: list[list[Any]] | None = None, raises: Exception | None = None):
        self.rows = rows if rows is not None else []
        self.raises = raises
        self.calls: list[dict[str, Any]] = []

    def query(self, query: str, parameters: Any = None, settings: Any = None) -> FakeResult:
        self.calls.append({"query": query, "parameters": parameters, "settings": settings})
        if self.raises is not None:
            raise self.raises
        return FakeResult(self.rows)

    @property
    def last(self) -> dict[str, Any]:
        assert self.calls, "client was never called"
        return self.calls[-1]


def _service(client: FakeClient, ceiling: int = 100) -> SqlQueryService:
    return SqlQueryService(client, max_rows_ceiling=ceiling)


# ---------------------------------------------------------------------------
# What leaves the process
# ---------------------------------------------------------------------------
class TestExecutedSql:
    def test_the_query_runs_against_the_curated_view(self) -> None:
        client = FakeClient(rows=[["s1"]])
        _service(client).run("SELECT span_id FROM spans", PID)
        assert "spans_public_v1" in client.last["query"]
        assert "FROM spans_public_v1" in client.last["query"]

    def test_the_row_cap_wraps_the_whole_rewritten_query(self) -> None:
        client = FakeClient(rows=[["s1"]])
        _service(client, ceiling=100).run("SELECT span_id FROM spans", PID)
        assert client.last["query"].startswith("SELECT * FROM (")
        assert client.last["query"].rstrip().endswith("LIMIT 101")

    def test_the_project_travels_as_a_bound_parameter(self) -> None:
        client = FakeClient(rows=[["s1"]])
        _service(client).run("SELECT span_id FROM spans", PID)
        assert client.last["parameters"] == {"scope_project_id": PID}
        assert PID not in client.last["query"]

    def test_no_per_query_settings_are_sent(self) -> None:
        # readonly = 1 answers Code 164 to any override, stricter ones included.
        client = FakeClient(rows=[["s1"]])
        _service(client).run("SELECT span_id FROM spans", PID)
        assert client.last["settings"] is None

    def test_a_caller_limit_does_not_lift_the_cap(self) -> None:
        client = FakeClient(rows=[["s1"]])
        _service(client, ceiling=10).run("SELECT span_id FROM spans LIMIT 5000", PID)
        assert client.last["query"].rstrip().endswith("LIMIT 11")


# ---------------------------------------------------------------------------
# The cap and the truncation sentinel
# ---------------------------------------------------------------------------
class TestRowCap:
    def test_max_rows_below_the_ceiling_is_honoured(self) -> None:
        client = FakeClient(rows=[["s1"]])
        _service(client, ceiling=100).run("SELECT span_id FROM spans", PID, max_rows=10)
        assert client.last["query"].rstrip().endswith("LIMIT 11")

    def test_max_rows_above_the_ceiling_is_clamped(self) -> None:
        client = FakeClient(rows=[["s1"]])
        _service(client, ceiling=100).run("SELECT span_id FROM spans", PID, max_rows=10_000)
        assert client.last["query"].rstrip().endswith("LIMIT 101")

    @pytest.mark.parametrize("bad", [0, -1, True, 2.5, "10"])
    def test_a_nonsense_max_rows_is_refused_before_execution(self, bad: Any) -> None:
        client = FakeClient(rows=[["s1"]])
        with pytest.raises(SqlExecutionError) as exc_info:
            _service(client).run("SELECT span_id FROM spans", PID, max_rows=bad)
        assert exc_info.value.is_client_error
        assert not client.calls

    def test_exactly_the_cap_is_not_truncated(self) -> None:
        client = FakeClient(rows=[[f"s{i}"] for i in range(10)])
        result = _service(client, ceiling=10).run("SELECT span_id FROM spans", PID)
        assert result.row_count == 10
        assert result.truncated is False

    def test_one_over_the_cap_is_truncated_and_the_sentinel_dropped(self) -> None:
        client = FakeClient(rows=[[f"s{i}"] for i in range(11)])
        result = _service(client, ceiling=10).run("SELECT span_id FROM spans", PID)
        assert result.row_count == 10
        assert result.truncated is True
        assert result.rows[-1] == ["s9"]

    def test_fewer_rows_than_the_cap_is_not_truncated(self) -> None:
        client = FakeClient(rows=[["s1"], ["s2"]])
        result = _service(client, ceiling=10).run("SELECT span_id FROM spans", PID)
        assert (result.row_count, result.truncated) == (2, False)


# ---------------------------------------------------------------------------
# Nothing reaches the database that should not
# ---------------------------------------------------------------------------
class TestRefusedBeforeExecution:
    @pytest.mark.parametrize(
        "query",
        [
            "DROP TABLE spans",
            "SELECT * FROM system.tables",
            "SELECT project_id FROM spans",
            "SELECT sleep(5) FROM spans",
            "SELECT * FROM spans; SELECT 1",
        ],
    )
    def test_a_refused_query_never_reaches_the_client(self, query: str) -> None:
        client = FakeClient(rows=[["s1"]])
        with pytest.raises(SqlValidationError):
            _service(client).run(query, PID)
        assert not client.calls


# ---------------------------------------------------------------------------
# What a failure tells the caller
# ---------------------------------------------------------------------------
class TestErrorClassification:
    @pytest.mark.parametrize(
        ("code", "expected_fragment"),
        [
            (159, "execution time"),
            (241, "memory"),
            (396, "maximum size"),
            (62, "could not be parsed"),
            (456, "parameter"),
        ],
    )
    def test_known_codes_become_the_caller_s_problem(
        self, code: int, expected_fragment: str
    ) -> None:
        message, is_client_error = classify_ch_error(f"Code: {code}. DB::Exception: raw detail")
        assert is_client_error
        assert expected_fragment in message

    def test_an_unknown_code_is_opaque_by_default(self) -> None:
        # The point of a code table over a message scrub: a code nobody has seen
        # is safe without anyone revisiting this list.
        message, is_client_error = classify_ch_error("Code: 9999. DB::Exception: something new")
        assert is_client_error is False
        assert message == "Query execution failed."

    def test_a_message_with_no_code_is_opaque(self) -> None:
        message, is_client_error = classify_ch_error("connection reset by peer")
        assert is_client_error is False
        assert message == "Query execution failed."

    def test_the_raw_error_never_reaches_the_caller(self) -> None:
        raw = (
            "Code: 47. DB::Exception: Unknown expression identifier 'x' in scope "
            f"SELECT * FROM spans_public_v1(project_id = '{PID}') AS spans"
        )
        client = FakeClient(raises=ClickHouseError(raw))
        with pytest.raises(SqlExecutionError) as exc_info:
            _service(client).run("SELECT span_id FROM spans", PID)
        surfaced = str(exc_info.value)
        assert PID not in surfaced
        assert "spans_public_v1" not in surfaced
        assert "SELECT" not in surfaced


# ---------------------------------------------------------------------------
# Result shape
# ---------------------------------------------------------------------------
class TestResultShape:
    def test_columns_carry_names_and_types(self) -> None:
        client = FakeClient(rows=[["s1"]])
        result = _service(client).run("SELECT span_id FROM spans", PID)
        assert [c.name for c in result.columns] == ["span_id"]
        assert [c.type for c in result.columns] == ["String"]

    def test_statistics_are_read_when_the_driver_supplies_them(self) -> None:
        client = FakeClient(rows=[["s1"]])
        result = _service(client).run("SELECT span_id FROM spans", PID)
        assert result.statistics == {"rows_read": 42, "bytes_read": 4096}

    def test_elapsed_is_recorded(self) -> None:
        client = FakeClient(rows=[["s1"]])
        result = _service(client).run("SELECT span_id FROM spans", PID)
        assert result.elapsed_ms >= 0


# ---------------------------------------------------------------------------
# Caller-supplied parameters
# ---------------------------------------------------------------------------
class TestCallerParameters:
    def test_a_caller_parameter_is_bound_not_interpolated(self) -> None:
        client = FakeClient(rows=[["s1"]])
        _service(client).run(
            "SELECT span_id FROM spans WHERE span_id = {want:String}",
            PID,
            parameters={"want": "s1"},
        )
        assert client.last["parameters"]["want"] == "s1"
        assert "s1" not in client.last["query"]

    def test_the_scope_bind_wins_over_a_caller_parameter(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The scrub refuses this name outright, so reaching the merge at all means
        # standing in for a scrub that let it through. That is the point: the
        # ordering is a second, independent reason the tenant scope cannot move.
        from rest.services.sql import service as service_module

        monkeypatch.setattr(
            service_module, "_scrubbed", lambda _params: {"scope_project_id": "somebody_else"}
        )
        client = FakeClient(rows=[["s1"]])
        _service(client).run("SELECT span_id FROM spans", PID)
        assert client.last["parameters"]["scope_project_id"] == PID

    @pytest.mark.parametrize(
        "name", ["project_id", "PROJECT_ID", "scope_project_id", "scope_anything", "SCOPE_x"]
    )
    def test_a_reserved_parameter_name_is_refused_before_execution(self, name: str) -> None:
        client = FakeClient(rows=[["s1"]])
        with pytest.raises(SqlExecutionError) as exc_info:
            _service(client).run("SELECT span_id FROM spans", PID, parameters={name: "x"})
        assert exc_info.value.is_client_error
        assert not client.calls

    @pytest.mark.parametrize(
        "name", ["with space", "x&max_execution_time", "1leading", "", "a-b", "abc\n", "abc\r\n"]
    )
    def test_a_malformed_parameter_name_is_refused(self, name: str) -> None:
        # The name is sent as `param_<name>` in the request, so a separator in it
        # would add a request field rather than a value.
        client = FakeClient(rows=[["s1"]])
        with pytest.raises(SqlExecutionError):
            _service(client).run("SELECT span_id FROM spans", PID, parameters={name: "x"})
        assert not client.calls

    def test_no_parameters_still_sends_only_the_scope_bind(self) -> None:
        client = FakeClient(rows=[["s1"]])
        _service(client).run("SELECT span_id FROM spans", PID)
        assert client.last["parameters"] == {"scope_project_id": PID}
