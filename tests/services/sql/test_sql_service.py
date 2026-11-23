"""Tests for the SQL Gateway execution seam.

No database. A fake client records what it was asked to run and hands back what
each test wants, which is enough to pin the three things that matter here: what
SQL leaves this process, how many rows come back, and what a failure tells the
caller.
"""

from __future__ import annotations

from typing import Any

import pytest
from clickhouse_connect.datatypes.registry import get_from_name
from clickhouse_connect.driver.exceptions import ClickHouseError

from rest.services.sql.errors import SqlExecutionError, SqlValidationError
from rest.services.sql.service import (
    SqlQueryService,
    classify_ch_error,
)
from shared.config import settings

PID = "acme_corp:proj.123-abc"


class FakeResult:
    def __init__(self, rows: list[list[Any]], columns: list[str] | None = None) -> None:
        self.result_rows = rows
        # `None` is "whatever the default is"; `[]` is the driver reporting no
        # column metadata at all, which is what it does for a result with no rows.
        self.column_names = ["span_id"] if columns is None else columns
        # Real driver type objects, as clickhouse-connect returns them.
        self.column_types = [get_from_name("String")] * len(self.column_names)
        self.summary = {"read_rows": "42", "read_bytes": "4096"}


def _describe_rows(columns: list[tuple[str, str]]) -> list[list[Any]]:
    """One row per column, as ClickHouse answers a DESCRIBE.

    Name first and type second, then five fields this service never reads. They
    are carried anyway so a test cannot pass by reading a two-element row that
    the server does not send.
    """
    return [[name, ch_type, "", "", "", "", ""] for name, ch_type in columns]


class FakeClient:
    """Records the call and returns canned rows, or raises what it was given.

    A DESCRIBE is answered separately, because the service issues one only for a
    result the driver did not describe, and what it returns is a different shape
    from the query's own answer.
    """

    def __init__(
        self,
        rows: list[list[Any]] | None = None,
        raises: Exception | None = None,
        columns: list[str] | None = None,
        describes: list[tuple[str, str]] | None = None,
        describe_raises: Exception | None = None,
    ):
        self.rows = rows if rows is not None else []
        self.raises = raises
        self.columns = columns
        self.describes = describes
        self.describe_raises = describe_raises
        self.calls: list[dict[str, Any]] = []

    def query(self, query: str, parameters: Any = None, settings: Any = None) -> FakeResult:
        self.calls.append({"query": query, "parameters": parameters, "settings": settings})
        if query.lstrip().startswith("DESCRIBE"):
            if self.describe_raises is not None:
                raise self.describe_raises
            return FakeResult(_describe_rows(self.describes or []), ["name", "type"])
        if self.raises is not None:
            raise self.raises
        return FakeResult(self.rows, self.columns)

    @property
    def last(self) -> dict[str, Any]:
        assert self.calls, "client was never called"
        return self.calls[-1]

    @property
    def describe_calls(self) -> list[dict[str, Any]]:
        return [c for c in self.calls if c["query"].lstrip().startswith("DESCRIBE")]


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

    def test_the_default_ceiling_leaves_room_for_the_sentinel_under_the_server_cap(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The server answers Code 396 once a result passes its row cap, so the
        # fetched LIMIT, sentinel included, must not exceed it.
        monkeypatch.setattr(settings.clickhouse, "sql_max_result_rows", 50)
        client = FakeClient(rows=[["s1"]])
        SqlQueryService(client).run("SELECT span_id FROM spans", PID, max_rows=10_000)
        assert client.last["query"].rstrip().endswith("LIMIT 50")

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
            (47, "column"),
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

    @pytest.mark.parametrize("code", [60, 62, 456])
    def test_codes_a_caller_cannot_reach_are_server_errors(self, code: int) -> None:
        # Layer 1 refuses unknown tables and unparseable SQL, and the rewriter
        # supplies every view argument, so each of these means a deployment or
        # rewriter defect. Reported as the caller's fault, none of them would alert.
        message, is_client_error = classify_ch_error(f"Code: {code}. DB::Exception: raw detail")
        assert is_client_error is False
        assert message == "Query execution failed."

    def test_an_unsupplied_caller_parameter_is_the_caller_s_problem(self) -> None:
        client = FakeClient(raises=ClickHouseError("Code: 456. Substitution `min_ms` is not set"))
        with pytest.raises(SqlExecutionError) as exc_info:
            _service(client).run(
                "SELECT span_id FROM spans WHERE duration_ms > {min_ms:Int64}", PID
            )
        assert exc_info.value.is_client_error
        assert str(exc_info.value) == "Query uses a parameter that was not supplied."

    def test_a_missing_view_argument_stays_a_server_error_even_with_a_missing_caller_one(
        self,
    ) -> None:
        # The caller omitted their own parameter too, so "is any caller parameter
        # missing" would have blamed them and hidden the rewriter and view skew.
        client = FakeClient(raises=ClickHouseError("Code: 456. Substitution `end_time` is not set"))
        with pytest.raises(SqlExecutionError) as exc_info:
            _service(client).run(
                "SELECT span_id FROM spans WHERE duration_ms > {min_ms:Int64}", PID
            )
        assert exc_info.value.is_client_error is False
        assert str(exc_info.value) == "Query execution failed."

    @pytest.mark.parametrize(
        ("raw", "parameters"),
        [
            # A name the caller did supply: not evidence the caller is at fault.
            ("Code: 456. DB::Exception: Substitution `min_ms` is not set", {"min_ms": 5}),
            # Wording this code cannot read, with the caller's own parameter also
            # missing: unreadable is not the same as absent, so it must not be
            # read as one, or a skew hides behind the caller's omission.
            ("Code: 456. DB::Exception: a wording nobody has seen", None),
        ],
    )
    def test_456_falls_back_to_a_server_error_when_the_name_does_not_match(
        self, raw: str, parameters: dict[str, Any] | None
    ) -> None:
        client = FakeClient(raises=ClickHouseError(raw))
        with pytest.raises(SqlExecutionError) as exc_info:
            _service(client).run(
                "SELECT span_id FROM spans WHERE duration_ms > {min_ms:Int64}",
                PID,
                parameters=parameters,
            )
        assert exc_info.value.is_client_error is False

    def test_456_with_every_caller_parameter_supplied_is_a_server_error(self) -> None:
        # The caller supplied everything their query names, so the missing
        # substitution is a view argument: the rewriter and the view disagree.
        client = FakeClient(raises=ClickHouseError("Code: 456. Substitution `end_time` is not set"))
        with pytest.raises(SqlExecutionError) as exc_info:
            _service(client).run(
                "SELECT span_id FROM spans WHERE duration_ms > {min_ms:Int64}",
                PID,
                parameters={"min_ms": 5},
            )
        assert exc_info.value.is_client_error is False
        assert str(exc_info.value) == "Query execution failed."

    def test_456_on_a_query_without_placeholders_is_a_server_error(self) -> None:
        client = FakeClient(
            raises=ClickHouseError("Code: 456. Substitution `start_time` is not set")
        )
        with pytest.raises(SqlExecutionError) as exc_info:
            _service(client).run("SELECT span_id FROM spans", PID)
        assert exc_info.value.is_client_error is False

    # Verbatim from ClickHouse 25.2. Each type family raises its own code, which
    # is the reason blame follows the clause naming the parameter rather than a
    # list of codes that would go stale with the next type ClickHouse adds.
    @pytest.mark.parametrize(
        "raw",
        [
            # The trailing Z every ISO-8601 formatter emits, which is the shape a
            # caller is most likely to send by accident.
            "Code: 457. DB::Exception: Value 2026-01-01T00:00:00Z cannot be parsed as "
            "DateTime64(3) for query parameter 'p' because it isn't parsed completely: "
            "only 19 of 20 bytes was parsed: 2026-01-01 00:00:00. (BAD_QUERY_PARAMETER)",
            "Code: 41. DB::Exception: Cannot parse datetime: value nope cannot be parsed "
            "as DateTime for query parameter 'p'. (CANNOT_PARSE_DATETIME)",
            "Code: 38. DB::Exception: Cannot parse date: value is too short: value nope "
            "cannot be parsed as Date for query parameter 'p'. (CANNOT_PARSE_DATE)",
            "Code: 376. DB::Exception: Cannot parse uuid nope: value nope cannot be "
            "parsed as UUID for query parameter 'p'. (CANNOT_PARSE_UUID)",
            "Code: 130. DB::Exception: Array does not start with '[' character: value "
            "nope cannot be parsed as Array(UInt8) for query parameter 'p'. "
            "(CANNOT_READ_ARRAY_FROM_TEXT)",
            "Code: 27. DB::Exception: Cannot parse input: expected '{' before: 'nope': "
            "value nope cannot be parsed as Map(String,UInt8) for query parameter 'p'. "
            "(CANNOT_PARSE_INPUT_ASSERTION_FAILED)",
        ],
    )
    def test_a_value_the_declared_type_cannot_hold_is_the_caller_s_problem(self, raw: str) -> None:
        # A 500 here would send the caller to read a status page about a value
        # only they can fix, and would page whoever owns the gateway for it.
        client = FakeClient(raises=ClickHouseError(raw))
        with pytest.raises(SqlExecutionError) as exc_info:
            _service(client).run(
                "SELECT span_id FROM spans WHERE duration_ms > {p:Int64}",
                PID,
                parameters={"p": "nope"},
            )
        assert exc_info.value.is_client_error
        assert str(exc_info.value) == (
            "Query supplied a parameter value that its declared type cannot hold."
        )

    @pytest.mark.parametrize(
        "raw",
        [
            # A parameter the caller did not supply is the rewriter's bind, so the
            # value came from the gateway and the gateway is what is wrong.
            "Code: 457. DB::Exception: Value x cannot be parsed as String for query "
            "parameter 'scope_project_id'. (BAD_QUERY_PARAMETER)",
            # Wording this code cannot read stays a server error, so a change in
            # ClickHouse's prose costs a caller a generic message and never costs
            # an alert.
            "Code: 457. DB::Exception: a wording nobody has seen",
        ],
    )
    def test_a_value_failure_the_caller_did_not_cause_stays_a_server_error(self, raw: str) -> None:
        client = FakeClient(raises=ClickHouseError(raw))
        with pytest.raises(SqlExecutionError) as exc_info:
            _service(client).run(
                "SELECT span_id FROM spans WHERE duration_ms > {p:Int64}",
                PID,
                parameters={"p": "nope"},
            )
        assert exc_info.value.is_client_error is False
        assert str(exc_info.value) == "Query execution failed."

    def test_the_value_that_was_refused_never_reaches_the_caller(self) -> None:
        # The raw text quotes the value back, and a caller's value can carry
        # anything, so the returned sentence is fixed and derived from nothing.
        raw = (
            "Code: 457. DB::Exception: Value spans_public_v1 cannot be parsed as Int64 "
            "for query parameter 'p'. (BAD_QUERY_PARAMETER)"
        )
        client = FakeClient(raises=ClickHouseError(raw))
        with pytest.raises(SqlExecutionError) as exc_info:
            _service(client).run(
                "SELECT span_id FROM spans WHERE duration_ms > {p:Int64}",
                PID,
                parameters={"p": "spans_public_v1"},
            )
        assert "spans_public_v1" not in str(exc_info.value)

    # Verbatim from ClickHouse 25.2, one per code a caller's own literal reaches.
    @pytest.mark.parametrize(
        "raw",
        [
            "Code: 6. DB::Exception: Cannot parse string '2026-09-17 19:01:56.000' as "
            "DateTime: syntax error at position 19 (parsed just '2026-09-17 19:01:56'): "
            "In scope SELECT toDateTime('2026-09-17 19:01:56.000'). (CANNOT_PARSE_TEXT)",
            "Code: 38. DB::Exception: Cannot parse string 'nonsense' as Date: In scope "
            "SELECT toDate('nonsense'). (CANNOT_PARSE_DATE)",
            "Code: 41. DB::Exception: Cannot parse string 'bad' as DateTime64(3): In "
            "scope SELECT toDateTime64('bad', 3). (CANNOT_PARSE_DATETIME)",
        ],
    )
    def test_a_literal_the_type_cannot_hold_is_the_caller_s_problem(self, raw: str) -> None:
        # The caller wrote the literal, so a 500 sends them to a status page about
        # their own typo and pages whoever owns the gateway for it.
        client = FakeClient(raises=ClickHouseError(raw))
        with pytest.raises(SqlExecutionError) as exc_info:
            _service(client).run("SELECT count() FROM spans", PID)
        assert exc_info.value.is_client_error
        assert str(exc_info.value) == (
            "Query contains a value that cannot be parsed as the type it is used as."
        )

    def test_the_literal_that_was_refused_never_reaches_the_caller(self) -> None:
        # These messages quote the caller's SQL back, and the scoped SQL is what
        # actually ran, so the raw text names the curated view.
        raw = (
            "Code: 6. DB::Exception: Cannot parse string 'x' as DateTime: In scope "
            "SELECT toDateTime('x') FROM spans_public_v1(project_id = 'proj-1'). "
            "(CANNOT_PARSE_TEXT)"
        )
        client = FakeClient(raises=ClickHouseError(raw))
        with pytest.raises(SqlExecutionError) as exc_info:
            _service(client).run("SELECT count() FROM spans", PID)
        assert "spans_public_v1" not in str(exc_info.value)
        assert "proj-1" not in str(exc_info.value)

    def test_a_parameter_value_still_gets_the_more_specific_message(self) -> None:
        # 41 is now in the client table, so the generic literal sentence would be
        # correct but less useful for a value the caller passed as a parameter.
        # The parameter branch runs after classification and must still win.
        raw = (
            "Code: 41. DB::Exception: Cannot parse datetime: value nope cannot be parsed "
            "as DateTime for query parameter 'p'. (CANNOT_PARSE_DATETIME)"
        )
        client = FakeClient(raises=ClickHouseError(raw))
        with pytest.raises(SqlExecutionError) as exc_info:
            _service(client).run(
                "SELECT span_id FROM spans WHERE duration_ms > {p:Int64}",
                PID,
                parameters={"p": "nope"},
            )
        assert exc_info.value.is_client_error
        assert str(exc_info.value) == (
            "Query supplied a parameter value that its declared type cannot hold."
        )

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

    @pytest.mark.parametrize(
        "type_name", ["UInt64", "Nullable(String)", "Map(LowCardinality(String), String)"]
    )
    def test_a_column_type_is_its_clickhouse_name_not_the_driver_object(
        self, type_name: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # str() of a driver type is a Python repr carrying a memory address.
        client = FakeClient(rows=[["s1"]])
        real_query = client.query

        def query_with_type(*args: Any, **kwargs: Any) -> FakeResult:
            result = real_query(*args, **kwargs)
            result.column_types = [get_from_name(type_name)]
            return result

        monkeypatch.setattr(client, "query", query_with_type)
        result = _service(client).run("SELECT span_id FROM spans", PID)
        assert [c.type for c in result.columns] == [type_name]

    def test_statistics_are_read_when_the_driver_supplies_them(self) -> None:
        client = FakeClient(rows=[["s1"]])
        result = _service(client).run("SELECT span_id FROM spans", PID)
        assert result.statistics == {"rows_read": 42, "bytes_read": 4096}

    def test_elapsed_is_recorded(self) -> None:
        client = FakeClient(rows=[["s1"]])
        result = _service(client).run("SELECT span_id FROM spans", PID)
        assert result.elapsed_ms >= 0


# ---------------------------------------------------------------------------
# An empty result still says what it is empty of
# ---------------------------------------------------------------------------
class TestEmptyResultColumns:
    """The driver reports no column names or types for a result with no rows.

    Every other test in this file has rows behind it, which is why none of them
    could fail on the answer being shapeless. An empty answer is the ordinary
    answer to a time-windowed query over a quiet day, so the service asks the
    server to describe the statement it has just run. These tests pin that the
    ask happens, that it asks about the right statement, and that the answer is
    passed through as given; what ClickHouse actually names a projection is
    pinned against a real server in tests/integration.
    """

    def test_the_columns_come_from_the_server(self) -> None:
        client = FakeClient(
            rows=[], columns=[], describes=[("span_id", "String"), ("hits", "UInt64")]
        )
        result = _service(client).run("SELECT span_id, count() AS hits FROM spans", PID)
        assert [(c.name, c.type) for c in result.columns] == [
            ("span_id", "String"),
            ("hits", "UInt64"),
        ]
        assert result.rows == []
        assert result.row_count == 0

    def test_the_server_is_asked_about_the_sql_that_just_ran(self) -> None:
        # Not the caller's statement and not the rewritten one, but the wrapped
        # form that was executed: that is the query whose answer was empty, and
        # the only one whose shape is the answer's shape.
        client = FakeClient(rows=[], columns=[], describes=[("span_id", "String")])
        _service(client).run("SELECT span_id FROM spans", PID)
        executed, described = client.calls[0]["query"], client.calls[1]["query"]
        assert described == f"DESCRIBE (\n{executed}\n)"

    def test_the_describe_carries_the_same_parameters(self) -> None:
        # The scope bind among them. Without it the describe fails with code 456
        # and the caller gets a shapeless answer for no reason.
        client = FakeClient(rows=[], columns=[], describes=[("span_id", "String")])
        _service(client).run("SELECT span_id FROM spans", PID, parameters={"v": "x"})
        assert client.calls[1]["parameters"] == client.calls[0]["parameters"]
        assert client.calls[1]["parameters"] == {"v": "x", "scope_project_id": PID}

    def test_nothing_is_described_when_the_driver_answered(self) -> None:
        # Rows behind it: the driver's own names and types are the contract, and
        # the server is not asked a second question.
        client = FakeClient(rows=[["s1"]], columns=["renamed_by_the_server"])
        result = _service(client).run("SELECT span_id FROM spans", PID)
        assert [(c.name, c.type) for c in result.columns] == [("renamed_by_the_server", "String")]
        assert client.describe_calls == []

    def test_a_repeated_name_is_reported_as_the_server_reports_it(self) -> None:
        # ClickHouse resolves `SELECT span_id AS a, a` to two columns both called
        # `a`. Whatever it says is passed through, duplicates included, because a
        # list that silently disagrees with the answer is worse than no list.
        client = FakeClient(rows=[], columns=[], describes=[("a", "String"), ("a", "String")])
        result = _service(client).run("SELECT span_id AS a, a FROM spans", PID)
        assert [(c.name, c.type) for c in result.columns] == [("a", "String"), ("a", "String")]

    def test_a_failed_describe_leaves_the_answer_as_it_was(self) -> None:
        # The query already succeeded. Failing to describe it must not turn a
        # good answer into an error, so the columns stay empty and the rest of
        # the result is untouched.
        client = FakeClient(
            rows=[], columns=[], describe_raises=ClickHouseError("Code: 241. DB::Exception: boom")
        )
        result = _service(client).run("SELECT span_id FROM spans", PID)
        assert client.describe_calls, "the describe was never attempted, so nothing was contained"
        assert result.columns == []
        assert result.rows == []
        assert result.row_count == 0
        assert result.truncated is False

    def test_a_describe_that_fails_outside_the_driver_is_contained_too(self) -> None:
        # Not every failure here is a ClickHouseError: a connection reset on the
        # second call arrives as something else entirely.
        client = FakeClient(rows=[], columns=[], describe_raises=OSError("connection reset"))
        result = _service(client).run("SELECT span_id FROM spans", PID)
        assert client.describe_calls, "the describe was never attempted, so nothing was contained"
        assert result.columns == []

    def test_a_describe_that_answers_nothing_describes_nothing(self) -> None:
        # The columns come from the rows of the answer, never from the header
        # ClickHouse puts on a DESCRIBE, which names its own seven fields.
        client = FakeClient(rows=[], columns=[], describes=[])
        result = _service(client).run("SELECT span_id FROM spans", PID)
        assert client.describe_calls, "the describe was never attempted, so nothing was measured"
        assert result.columns == []


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
