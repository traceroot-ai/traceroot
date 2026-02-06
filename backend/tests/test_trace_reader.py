from unittest.mock import MagicMock, patch

import pytest

from rest.services.trace_reader import TraceReaderService


@pytest.fixture
def mock_clickhouse_client():
    with patch("rest.services.trace_reader.get_clickhouse_client") as mock_get:
        client = MagicMock()
        mock_get.return_value = client
        yield client


def test_list_traces_with_session_id(mock_clickhouse_client):
    service = TraceReaderService()

    # Mock return value for the count query and the main query
    mock_clickhouse_client.query.side_effect = [
        MagicMock(result_rows=[]),  # Main query
        MagicMock(result_rows=[[0]]),  # Count query
    ]

    project_id = "test-project"
    session_id = "test-session-123"

    service.list_traces(project_id=project_id, session_id=session_id)

    # Verify that the query contains the session_id condition
    # The first call to query is the traces list
    args, kwargs = mock_clickhouse_client.query.call_args_list[0]
    query = args[0]
    params = kwargs.get("parameters", {})

    assert "t.session_id = {session_id:String}" in query
    assert params["session_id"] == session_id
    assert params["project_id"] == project_id


def test_list_traces_without_session_id(mock_clickhouse_client):
    service = TraceReaderService()

    mock_clickhouse_client.query.side_effect = [
        MagicMock(result_rows=[]),
        MagicMock(result_rows=[[0]]),
    ]

    service.list_traces(project_id="test-project")

    args, _ = mock_clickhouse_client.query.call_args_list[0]
    query = args[0]

    assert "t.session_id =" not in query
