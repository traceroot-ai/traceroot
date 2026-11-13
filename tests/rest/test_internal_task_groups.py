"""Unit tests for the internal task-group endpoints.

ClickHouse is a stub here, so these check request handling, validation and the
shape of what is written. The queries themselves were run against a live
ClickHouse (see the evidence in the pull request).
"""

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from shared.config import settings

HEADERS = {"X-Internal-Secret": "test-secret"}
BASE = "/api/v1/internal/task-groups"


@pytest.fixture()
def mock_ch(monkeypatch):
    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    mock = MagicMock()
    monkeypatch.setattr("rest.routers.internal.task_groups.get_clickhouse_client", lambda: mock)
    return mock


@pytest.fixture()
def client(mock_ch):
    return TestClient(app)


def _result(rows):
    r = MagicMock()
    r.result_rows = rows
    return r


class TestAuth:
    @pytest.mark.parametrize(
        "method,path",
        [
            ("get", "/candidates?project_id=p&since_ms=0&until_ms=1&idle_before_ms=0"),
            ("get", "/current-groups?project_id=p"),
            ("get", "/unplaced?project_id=p&fit_id=f"),
            ("post", "/digests"),
            ("post", "/members"),
        ],
    )
    def test_rejects_requests_without_the_secret(self, client, method, path):
        response = getattr(client, method)(BASE + path)
        assert response.status_code in (401, 403)


class TestCandidates:
    def test_returns_candidates_in_query_order_and_the_digested_count(self, client, mock_ch):
        mock_ch.query.side_effect = [
            _result([("t1", 1000, "12"), ("t2", 2000, "99999999999999999999")]),
            _result([(7,)]),
        ]
        response = client.get(
            f"{BASE}/candidates",
            params={"project_id": "p", "since_ms": 0, "until_ms": 5000, "idle_before_ms": 4000},
            headers=HEADERS,
        )
        assert response.status_code == 200
        body = response.json()
        assert body["digested"] == 7
        assert body["data"] == [
            {"trace_id": "t1", "trace_time_ms": 1000, "key": "12"},
            # The key stays a string: it can exceed what a JSON number holds exactly.
            {"trace_id": "t2", "trace_time_ms": 2000, "key": "99999999999999999999"},
        ]

    def test_scopes_the_query_by_project(self, client, mock_ch):
        mock_ch.query.side_effect = [_result([]), _result([(0,)])]
        client.get(
            f"{BASE}/candidates",
            params={
                "project_id": "proj-a",
                "since_ms": 0,
                "until_ms": 5000,
                "idle_before_ms": 4000,
            },
            headers=HEADERS,
        )
        for call in mock_ch.query.call_args_list:
            assert call.kwargs["parameters"]["project_id"] == "proj-a"
            assert "project_id = {project_id:String}" in call.args[0]

    def test_limit_is_bounded(self, client):
        response = client.get(
            f"{BASE}/candidates",
            params={
                "project_id": "p",
                "since_ms": 0,
                "until_ms": 1,
                "idle_before_ms": 0,
                "limit": 10**6,
            },
            headers=HEADERS,
        )
        assert response.status_code == 422


class TestWriteDigests:
    def _row(self, **over):
        row = {
            "trace_id": "t1",
            "trace_time_ms": 1000,
            "summary": "Book a flight.",
            "embedding": [0.1, 0.2],
            "summary_model": "m",
            "embedding_model": "e",
            "digest_version": 1,
            "cost_usd": 0.001,
        }
        return {**row, **over}

    def test_inserts_rows_with_the_projects_id(self, client, mock_ch):
        response = client.post(
            f"{BASE}/digests",
            json={"project_id": "p", "rows": [self._row()]},
            headers=HEADERS,
        )
        assert response.status_code == 200
        table, columns, rows = mock_ch.insert_rows.call_args.args
        assert table == "trace_task_digests"
        assert rows[0][columns.index("project_id")] == "p"
        assert rows[0][columns.index("lens")] == "task"
        assert rows[0][columns.index("embedding")] == [0.1, 0.2]

    @pytest.mark.parametrize(
        "bad", [{"summary": ""}, {"embedding": []}, {"cost_usd": -1}, {"trace_id": ""}]
    )
    def test_rejects_malformed_rows(self, client, bad):
        response = client.post(
            f"{BASE}/digests",
            json={"project_id": "p", "rows": [self._row(**bad)]},
            headers=HEADERS,
        )
        assert response.status_code == 422


class TestGroupsAndMembers:
    def test_current_groups_is_empty_before_any_fit(self, client, mock_ch):
        mock_ch.query.return_value = _result([])
        body = client.get(
            f"{BASE}/current-groups", params={"project_id": "p"}, headers=HEADERS
        ).json()
        assert body == {"fit_id": None, "data": []}

    def test_current_groups_returns_the_latest_fit(self, client, mock_ch):
        mock_ch.query.return_value = _result([("fit1", "g1", "Flights", [1.0, 0.0], 0.2, 12)])
        body = client.get(
            f"{BASE}/current-groups", params={"project_id": "p"}, headers=HEADERS
        ).json()
        assert body["fit_id"] == "fit1"
        assert body["data"][0] == {
            "group_id": "g1",
            "name": "Flights",
            "center": [1.0, 0.0],
            "reach": 0.2,
            "size": 12,
        }

    def test_members_accept_an_empty_group_for_noise(self, client, mock_ch):
        response = client.post(
            f"{BASE}/members",
            json={
                "project_id": "p",
                "fit_id": "f",
                "source": "assigned",
                "rows": [{"trace_id": "t", "trace_time_ms": 1, "group_id": "", "distance": 0.9}],
            },
            headers=HEADERS,
        )
        assert response.status_code == 200
        assert mock_ch.insert_rows.call_args.args[0] == "trace_group_members"

    def test_members_reject_an_unknown_source(self, client):
        response = client.post(
            f"{BASE}/members",
            json={"project_id": "p", "fit_id": "f", "source": "model", "rows": []},
            headers=HEADERS,
        )
        assert response.status_code == 422
