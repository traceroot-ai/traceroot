"""Regression test for #1366.

`TraceReaderService.list_users` filtered `end_before` with `<=`, while
`list_traces`, `list_sessions` and `get_session` all use `<`. A trace whose
`trace_start_time` exactly equals `end_before` therefore appeared on the users
tab but not the others, so per-page totals disagreed across tabs sharing the
same filter. All `end_before` filters must use an exclusive upper bound (`<`).

The ClickHouse client is mocked; we assert on the SQL issued, never touching a
real database.
"""

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


def _service_capturing(queries):
    from rest.services.trace_reader import TraceReaderService

    client = MagicMock()

    def side_effect(query, parameters=None):
        queries.append(query)
        return SimpleNamespace(result_rows=[])

    client.query.side_effect = side_effect
    with patch(
        "rest.services.trace_reader.get_clickhouse_client",
        return_value=client,
    ):
        return TraceReaderService()


def test_list_users_end_before_is_exclusive():
    queries: list[str] = []
    service = _service_capturing(queries)

    service.list_users(
        project_id="proj",
        end_before=datetime(2024, 1, 31, 23, 59, 59),
    )

    sql = "\n".join(queries)
    assert "t.trace_start_time < {end_before:DateTime64(3)}" in sql
    assert "t.trace_start_time <= {end_before:DateTime64(3)}" not in sql
