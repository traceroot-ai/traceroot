"""Endpoint tests for the internal alert-evaluate route."""

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from rest.schemas.alerts import (
    MAX_ALERT_WINDOW,
    MAX_ALERT_WINDOW_END_LAG,
    MAX_ALERTS_PER_REQUEST,
)
from rest.services import widget_query as wq
from shared.config import settings

URL = "/api/v1/internal/alert-evaluate"

WINDOW_END = datetime.now(UTC).replace(microsecond=0)
WINDOW_START = WINDOW_END - timedelta(hours=1)


def iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


@pytest.fixture()
def secret(monkeypatch):
    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    return "test-secret"


@pytest.fixture()
def fake_ch(monkeypatch):
    client = MagicMock()
    client.query.return_value = MagicMock(column_names=["value"], result_rows=[(7,)])
    monkeypatch.setattr(wq, "get_clickhouse_client", lambda: client)
    return client


@pytest.fixture()
def client(secret, fake_ch):
    return TestClient(app)


def alert(alert_id="alert-1", **overrides):
    payload = {
        "alert_id": alert_id,
        "view": "SPANS",
        "measure": "count",
        "aggregation": "count",
        "filters": [],
    }
    payload.update(overrides)
    return payload


def body(alerts=None, **overrides):
    payload = {
        "project_id": "proj-1",
        "window_start": iso(WINDOW_START),
        "window_end": iso(WINDOW_END),
        "alerts": alerts if alerts is not None else [alert()],
    }
    payload.update(overrides)
    return payload


def post(client, secret, payload):
    return client.post(URL, json=payload, headers={"X-Internal-Secret": secret})


def test_requires_the_internal_secret(client):
    """Anonymous callers must not read a project's numbers by naming its id in a body."""
    resp = client.post(URL, json=body())
    assert resp.status_code == 403


def test_wrong_secret_is_rejected(client):
    resp = client.post(URL, json=body(), headers={"X-Internal-Secret": "not-it"})
    assert resp.status_code == 403


def test_evaluates_a_batch_and_returns_one_result_per_alert(client, secret):
    """The tick matches results back to the rules it claimed, in request order."""
    resp = post(client, secret, body([alert("a"), alert("b"), alert("c")]))
    assert resp.status_code == 200
    results = resp.json()["results"]
    assert [r["alert_id"] for r in results] == ["a", "b", "c"]
    assert all(r["value"] == 7.0 and r["error"] is None for r in results)


def test_project_scope_comes_from_the_body(client, secret, fake_ch):
    """This route resolves no principal, so the body's project id is the only tenancy statement."""
    post(client, secret, body(project_id="proj-other"))
    assert fake_ch.query.call_args.kwargs["parameters"]["project_id"] == "proj-other"


def test_one_bad_alert_returns_beside_healthy_siblings(client, secret):
    """A stale rule is a 200 with that alert's error, not a failed batch."""
    resp = post(client, secret, body([alert("stale", measure="nonsense"), alert("good")]))
    assert resp.status_code == 200
    stale, good = resp.json()["results"]
    assert stale["error"] == "measure: Unknown alert measure 'nonsense'"
    assert stale["value"] is None
    assert good["error"] is None and good["value"] == 7.0


def test_reversed_window_is_a_422_with_a_structured_detail(client, secret, fake_ch):
    """One fault in the request, reported once, not N identical per-alert errors."""
    resp = post(
        client,
        secret,
        body(window_start=iso(WINDOW_END), window_end=iso(WINDOW_START)),
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == {
        "step": "time_range",
        "message": "window_end must be after window_start",
    }
    assert fake_ch.query.call_count == 0


def test_empty_window_is_a_422(client, secret, fake_ch):
    resp = post(
        client,
        secret,
        body(window_start=iso(WINDOW_END), window_end=iso(WINDOW_END)),
    )
    assert resp.status_code == 422
    assert resp.json()["detail"]["step"] == "time_range"
    assert fake_ch.query.call_count == 0


def test_window_past_the_alert_ceiling_is_a_422_with_a_structured_detail(client, secret, fake_ch):
    resp = post(
        client,
        secret,
        body(
            window_start=iso(WINDOW_END - MAX_ALERT_WINDOW - timedelta(seconds=1)),
            window_end=iso(WINDOW_END),
        ),
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == {
        "step": "time_range",
        "message": f"window must span at most {int(MAX_ALERT_WINDOW.total_seconds())} seconds",
    }
    assert fake_ch.query.call_count == 0


def test_a_window_at_the_alert_ceiling_is_accepted(client, secret):
    resp = post(
        client,
        secret,
        body(window_start=iso(WINDOW_END - MAX_ALERT_WINDOW), window_end=iso(WINDOW_END)),
    )
    assert resp.status_code == 200
    assert resp.json()["results"][0]["error"] is None


def test_window_anchored_past_the_lag_is_a_422_with_a_structured_detail(client, secret, fake_ch):
    stale_end = datetime.now(UTC) - MAX_ALERT_WINDOW_END_LAG - timedelta(seconds=1)
    resp = post(
        client,
        secret,
        body(window_start=iso(stale_end - timedelta(minutes=10)), window_end=iso(stale_end)),
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == {
        "step": "time_range",
        "message": (
            "window_end must be within "
            f"{int(MAX_ALERT_WINDOW_END_LAG.total_seconds())} seconds of now"
        ),
    }
    assert fake_ch.query.call_count == 0


def test_a_window_ending_just_inside_the_lag_is_accepted(client, secret):
    # Anchored on a fresh clock read: the margin is one minute and the suite's runtime eats it.
    end = datetime.now(UTC).replace(microsecond=0) - MAX_ALERT_WINDOW_END_LAG + timedelta(minutes=1)
    resp = post(
        client,
        secret,
        body(window_start=iso(end - timedelta(minutes=10)), window_end=iso(end)),
    )
    assert resp.status_code == 200
    assert resp.json()["results"][0]["error"] is None


def test_oversize_batch_is_rejected_before_any_query_runs(client, secret, fake_ch):
    """Each alert costs up to two timeout-capped reads, so an unbounded batch is unbounded."""
    resp = post(client, secret, body([alert(f"a{i}") for i in range(MAX_ALERTS_PER_REQUEST + 1)]))
    assert resp.status_code == 422
    assert fake_ch.query.call_count == 0


def test_a_batch_at_the_bound_is_accepted(client, secret):
    """The cap is a ceiling the caller chunks against, not an off-by-one trap."""
    resp = post(client, secret, body([alert(f"a{i}") for i in range(MAX_ALERTS_PER_REQUEST)]))
    assert resp.status_code == 200
    assert len(resp.json()["results"]) == MAX_ALERTS_PER_REQUEST


def test_empty_batch_is_rejected(client, secret, fake_ch):
    """An empty request is a caller bug worth surfacing rather than an expensive no-op."""
    resp = post(client, secret, body([]))
    assert resp.status_code == 422
    assert fake_ch.query.call_count == 0


def test_unknown_field_in_an_alert_is_rejected(client, secret):
    """extra=forbid: a rule that silently lost one of its terms must fail loudly."""
    resp = post(client, secret, body([alert(filter=[])]))
    assert resp.status_code == 422


def test_unknown_aggregation_is_rejected(client, secret, fake_ch):
    """Aggregation is a closed enum, so no valid stored rule can carry a value outside it."""
    resp = post(client, secret, body([alert(aggregation="median")]))
    assert resp.status_code == 422
    assert fake_ch.query.call_count == 0


def test_missing_window_is_rejected(client, secret):
    payload = body()
    del payload["window_end"]
    resp = post(client, secret, payload)
    assert resp.status_code == 422


def test_an_unexpected_service_failure_is_a_500_without_internals(client, secret, monkeypatch):
    """Its detail crosses into a worker log: no stack, no host, no SQL."""

    def boom(**kwargs):
        raise ValueError("Code: 241. DB::Exception: host=10.0.0.4")

    monkeypatch.setattr("rest.routers.internal.alerts.evaluate_alerts", boom)
    resp = post(client, secret, body())
    assert resp.status_code == 500
    assert resp.json()["detail"] == "Alert evaluation failed"
