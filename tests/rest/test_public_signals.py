"""Integration tests for the public signal reads and the signal status write.

Same harnesses as the alert tests: the REAL credential dependencies, with the
internal Next.js routes mocked by ``respx``. Reads go to the secret-authed
``project-signals`` route keyed by the resolved project; the status write goes
to the internal write route with the actor envelope. The tests pin the
outgoing bodies, the response translation, the 422 surface (only "resolved"
and "open" are settable), the credential rules (no project API key on the
write), and service-message parity on passthrough errors.
"""

import json
import re
from datetime import datetime, timedelta
from pathlib import Path

import httpx
import respx
from fastapi.testclient import TestClient
from httpx import Response

from rest.main import app
from rest.schemas.public_write import SIGNAL_NOTE_MAX_LENGTH, SignalResolveReason

BASE_URL = "http://localhost:3000"
READ_URL = f"{BASE_URL}/api/internal/project-signals"
WRITE_URL = f"{BASE_URL}/api/internal/write/signals/sig-1/status"

USER_HEADER = {"Authorization": "Bearer user-session-token"}
KEY_HEADER = {"Authorization": "Bearer tr-some-key"}

KEY_OK_BODY = {
    "valid": True,
    "projectId": "proj-A",
    "workspaceId": "ws-1",
    "billingPlan": "enterprise",
    "ingestionBlocked": False,
}
ACCOUNT_OK_BODY = {"valid": True, "userId": "u1", "email": "u@example.com"}

SIGNAL_UPSTREAM = {
    "id": "sig-1",
    "detectorId": "det-1",
    "detectorName": "Tool failures",
    "title": "Invokes a tool with an invalid date input",
    "status": "open",
    "hitCount": 4,
    "reopenCount": 1,
    "firstSeenAt": "2026-10-14T06:28:29Z",
    "lastSeenAt": "2026-10-14T07:12:00Z",
    "createTime": "2026-10-14T06:28:29Z",
    "rcaState": "done",
}
SIGNAL_PUBLIC = {
    "signal_id": "sig-1",
    "detector_id": "det-1",
    "detector_name": "Tool failures",
    "title": "Invokes a tool with an invalid date input",
    "status": "open",
    "hit_count": 4,
    "reopen_count": 1,
    "first_seen_at": "2026-10-14T06:28:29Z",
    "last_seen_at": "2026-10-14T07:12:00Z",
    "created_at": "2026-10-14T06:28:29Z",
    "rca_state": "done",
}
STATUS_ROW = {
    "id": "sig-1",
    "projectId": "proj-1",
    "detectorId": "det-1",
    "title": "Invokes a tool with an invalid date input",
    "status": "resolved",
    "resolvedAt": "2026-10-14T08:00:00.000Z",
    "reopenCount": 1,
}


def _client():
    return TestClient(app, raise_server_exceptions=False)


def _mock_key_auth():
    return respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
        return_value=Response(200, json=KEY_OK_BODY)
    )


def _mock_account_auth():
    return respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(200, json=ACCOUNT_OK_BODY)
    )


def _sent(route):
    return json.loads(route.calls.last.request.content)


# ── reads ───────────────────────────────────────────────────────────────


@respx.mock
def test_list_signals_with_an_api_key_forwards_filters_and_translates_rows():
    _mock_key_auth()
    read = respx.post(READ_URL).mock(
        return_value=Response(
            200,
            json={"signals": [SIGNAL_UPSTREAM], "meta": {"page": 1, "limit": 10, "total": 11}},
        )
    )

    resp = _client().get(
        "/api/v1/public/signals",
        params={"status": "open", "detector_id": "det-1", "limit": 10, "page": 1},
        headers=KEY_HEADER,
    )

    assert resp.status_code == 200
    assert resp.json() == {
        "data": [SIGNAL_PUBLIC],
        "meta": {"page": 1, "limit": 10, "total": 11},
    }
    assert _sent(read) == {
        "projectId": "proj-A",
        "limit": 10,
        "page": 1,
        "status": "open",
        "detectorId": "det-1",
    }


@respx.mock
def test_list_signals_rejects_an_unknown_status_with_422():
    _mock_key_auth()
    read = respx.post(READ_URL).mock(return_value=Response(200, json={}))

    resp = _client().get("/api/v1/public/signals", params={"status": "closed"}, headers=KEY_HEADER)

    assert resp.status_code == 422
    assert read.call_count == 0


@respx.mock
def test_list_signals_fails_closed_on_a_malformed_body():
    _mock_key_auth()
    respx.post(READ_URL).mock(
        return_value=Response(200, json={"signals": [{"id": "sig-1"}], "meta": {}})
    )

    resp = _client().get("/api/v1/public/signals", headers=KEY_HEADER)

    assert resp.status_code == 503
    assert resp.json() == {"detail": "Signal service error"}


@respx.mock
def test_get_signal_returns_resolved_at_and_merged_into_id():
    _mock_key_auth()
    read = respx.post(READ_URL).mock(
        return_value=Response(
            200,
            json={
                "signal": {
                    **SIGNAL_UPSTREAM,
                    "status": "resolved",
                    "resolvedAt": "2026-10-14T08:00:00Z",
                    "mergedIntoId": None,
                }
            },
        )
    )

    resp = _client().get("/api/v1/public/signals/sig-1", headers=KEY_HEADER)

    assert resp.status_code == 200
    assert resp.json() == {
        **SIGNAL_PUBLIC,
        "status": "resolved",
        "resolved_at": "2026-10-14T08:00:00Z",
        "merged_into_id": None,
        "recent_hits": [],
    }
    assert _sent(read) == {"projectId": "proj-A", "signalId": "sig-1"}


DETAIL_UPSTREAM = {**SIGNAL_UPSTREAM, "resolvedAt": None, "mergedIntoId": None, "recentHits": []}


def _get_signal(upstream):
    _mock_key_auth()
    read = respx.post(READ_URL).mock(return_value=Response(200, json={"signal": upstream}))
    return _client().get("/api/v1/public/signals/sig-1", headers=KEY_HEADER), read


@respx.mock
def test_get_signal_returns_recent_hits_in_the_services_order():
    """The service bounds, sorts and caps the hits; the public read keeps them as given."""
    hits = [
        {
            "traceId": f"trace-{i:02d}",
            "findingId": f"finding-{i:02d}",
            "traceStartTime": f"2026-10-14T07:{59 - i:02d}:00.000Z",
        }
        for i in range(20)
    ]

    resp, read = _get_signal({**DETAIL_UPSTREAM, "recentHits": hits})

    assert resp.status_code == 200
    recent = resp.json()["recent_hits"]
    assert recent[0] == {
        "trace_id": "trace-00",
        "finding_id": "finding-00",
        "trace_start_time": "2026-10-14T07:59:00Z",
    }
    assert [h["trace_id"] for h in recent] == [f"trace-{i:02d}" for i in range(20)]
    # The retention bound is the service's own: no window or cutoff is sent.
    assert _sent(read) == {"projectId": "proj-A", "signalId": "sig-1"}


@respx.mock
def test_get_signal_returns_trace_start_times_with_a_utc_offset():
    hit = {"traceId": "t", "findingId": "f", "traceStartTime": "2026-10-14T07:59:00.000Z"}

    resp, _ = _get_signal({**DETAIL_UPSTREAM, "recentHits": [hit]})

    assert resp.status_code == 200
    start = datetime.fromisoformat(resp.json()["recent_hits"][0]["trace_start_time"])
    assert start.utcoffset() == timedelta(0)


@respx.mock
def test_get_signal_reads_a_service_without_recent_hits_as_none():
    """A web app deployed before the field leaves it out; the read still answers."""
    upstream = {k: v for k, v in DETAIL_UPSTREAM.items() if k != "recentHits"}

    resp, _ = _get_signal(upstream)

    assert resp.status_code == 200
    assert resp.json()["recent_hits"] == []


@respx.mock
def test_get_signal_fails_closed_on_malformed_recent_hits():
    for recent_hits in [
        None,
        {},
        "trace-1",
        [{"traceId": "t", "findingId": "f"}],
        [{"traceId": "t", "findingId": None, "traceStartTime": "2026-10-14T07:59:00.000Z"}],
        [{"traceId": "t", "findingId": "f", "traceStartTime": "yesterday"}],
    ]:
        resp, _ = _get_signal({**DETAIL_UPSTREAM, "recentHits": recent_hits})
        assert resp.status_code == 503, recent_hits
        assert resp.json() == {"detail": "Signal service error"}


@respx.mock
def test_get_signal_passes_the_404_through():
    _mock_key_auth()
    respx.post(READ_URL).mock(return_value=Response(404, json={"error": "Signal not found"}))

    resp = _client().get("/api/v1/public/signals/sig-x", headers=KEY_HEADER)

    assert resp.status_code == 404
    assert resp.json() == {"detail": "Signal not found"}


# ── status write ────────────────────────────────────────────────────────

RESOLVE_BODY = {"project_id": "proj-1", "status": "resolved", "reason": "fixed_by_pr"}


def _patch(body, headers=USER_HEADER):
    return _client().patch("/api/v1/public/signals/sig-1/status", json=body, headers=headers)


@respx.mock
def test_set_status_requires_authorization():
    write = respx.patch(WRITE_URL).mock(return_value=Response(200, json={}))
    resp = _client().patch("/api/v1/public/signals/sig-1/status", json=RESOLVE_BODY)
    assert resp.status_code == 401
    assert write.call_count == 0


@respx.mock
def test_set_status_refuses_a_project_api_key_before_any_write():
    """Project keys live in customer applications and can leak; they must not close signals."""
    write = respx.patch(WRITE_URL).mock(return_value=Response(200, json={}))
    resp = _patch(RESOLVE_BODY, headers=KEY_HEADER)
    assert resp.status_code == 403
    assert write.call_count == 0


@respx.mock
def test_set_status_resolve_forwards_the_envelope_and_translates_the_row():
    _mock_account_auth()
    write = respx.patch(WRITE_URL).mock(
        return_value=Response(
            200, json={"updated": True, "changed": ["status"], "signal": STATUS_ROW}
        )
    )

    resp = _patch(
        {**RESOLVE_BODY, "note": "Fixed in #42", "expected_status": "open"},
    )

    assert resp.status_code == 200
    assert resp.json() == {
        "updated": True,
        "changed": ["status"],
        "signal": {
            "signal_id": "sig-1",
            "project_id": "proj-1",
            "detector_id": "det-1",
            "title": "Invokes a tool with an invalid date input",
            "status": "resolved",
            "resolved_at": "2026-10-14T08:00:00.000Z",
            "reopen_count": 1,
        },
    }
    assert _sent(write) == {
        "actorUserId": "u1",
        "projectId": "proj-1",
        "change": {"status": "resolved", "reason": "fixed_by_pr", "note": "Fixed in #42"},
        "expectedStatus": "open",
        "transport": "public-api",
    }


@respx.mock
def test_set_status_reopen_sends_only_the_status():
    _mock_account_auth()
    write = respx.patch(WRITE_URL).mock(
        return_value=Response(
            200,
            json={
                "updated": True,
                "changed": ["status"],
                "signal": {**STATUS_ROW, "status": "open", "resolvedAt": None},
            },
        )
    )

    resp = _patch({"project_id": "proj-1", "status": "open"})

    assert resp.status_code == 200
    assert resp.json()["signal"] == {
        "signal_id": "sig-1",
        "project_id": "proj-1",
        "detector_id": "det-1",
        "title": "Invokes a tool with an invalid date input",
        "status": "open",
        "resolved_at": None,
        "reopen_count": 1,
    }
    assert _sent(write)["change"] == {"status": "open"}
    assert "expectedStatus" not in _sent(write)


@respx.mock
def test_set_status_refuses_dismissed_with_422():
    """A dismissed signal never reopens, so dismissing stays in the web app."""
    _mock_account_auth()
    write = respx.patch(WRITE_URL).mock(return_value=Response(200, json={}))

    resp = _patch({"project_id": "proj-1", "status": "dismissed", "reason": "expected_behavior"})

    assert resp.status_code == 422
    assert write.call_count == 0


@respx.mock
def test_set_status_rejects_an_unknown_reason_and_unknown_keys_with_422():
    _mock_account_auth()
    write = respx.patch(WRITE_URL).mock(return_value=Response(200, json={}))

    assert _patch({**RESOLVE_BODY, "reason": "because"}).status_code == 422
    assert _patch({**RESOLVE_BODY, "change": {}}).status_code == 422
    assert _patch({**RESOLVE_BODY, "note": "x" * (SIGNAL_NOTE_MAX_LENGTH + 1)}).status_code == 422
    assert write.call_count == 0


@respx.mock
def test_set_status_passes_the_services_errors_through():
    """The write service decides the role and the reason rules; its words reach the caller."""
    _mock_account_auth()
    for status_code, message in [
        (400, "reason: Invalid option"),
        (403, "Requires MEMBER role or higher"),
        (404, "Signal not found"),
        (409, 'The signal\'s status changed: it is now "dismissed"'),
    ]:
        respx.patch(WRITE_URL).mock(return_value=Response(status_code, json={"error": message}))
        resp = _patch(RESOLVE_BODY)
        assert resp.status_code == status_code
        assert resp.json() == {"detail": message}


@respx.mock
def test_set_status_fails_closed_on_a_network_error():
    _mock_account_auth()
    respx.patch(WRITE_URL).mock(side_effect=httpx.ConnectError("Connection refused"))

    resp = _patch(RESOLVE_BODY)

    assert resp.status_code == 503
    assert resp.json() == {"detail": "Write service unavailable"}


# ── parity with the TypeScript allowlists ───────────────────────────────


def test_python_signal_constants_mirror_the_core_constants():
    """The Python schemas mirror RESOLVE_REASONS and SIGNAL_NOTE_MAX_LENGTH."""
    root = Path(__file__).resolve().parents[2]
    constants = (root / "frontend/packages/core/src/ee/signals/constants.ts").read_text()
    reasons_block = re.search(r"RESOLVE_REASONS = \[(.*?)\]", constants, re.S).group(1)
    ts_reasons = re.findall(r'"([a-z_]+)"', reasons_block)
    assert ts_reasons == list(SignalResolveReason.__args__)
    ts_max = int(re.search(r"SIGNAL_NOTE_MAX_LENGTH = (\d+)", constants).group(1))
    assert ts_max == SIGNAL_NOTE_MAX_LENGTH
