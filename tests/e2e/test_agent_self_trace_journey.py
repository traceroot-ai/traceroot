"""Feature journey for agent self-tracing: a detector finding's completed RCA hands out
an execution (attempt, trace id, trace_status) through the app's finding endpoint — the
public findings API deliberately says nothing about it — whose trace is readable only
through the opt-in ``source=agent`` seam, never re-enters the customer surface, and never
re-triggers a detector. Requires a seeded dev stack with at least one finding whose RCA has
finished (UI :3000, REST :8000, ClickHouse :8123) and a login for the app endpoint.
Skipped unless TRACEROOT_E2E=1.
"""

import os

import httpx
import pytest

_E2E_ENABLED = os.getenv("TRACEROOT_E2E") == "1"
pytestmark = pytest.mark.skipif(not _E2E_ENABLED, reason="needs the dev stack")

REST = os.getenv("TRACEROOT_REST_URL", "http://localhost:8000")
UI = os.getenv("TRACEROOT_UI_URL", "http://localhost:3000")
CH = os.getenv("TRACEROOT_CH_URL", "http://localhost:8123/?user=clickhouse&password=clickhouse")
if _E2E_ENABLED:
    PROJECT = os.environ["TRACEROOT_E2E_PROJECT_ID"]  # a seeded project with >= 1 done RCA
    API_KEY = os.environ["TRACEROOT_E2E_API_KEY"]  # project access key (public API)
    PLATFORM_SECRET = os.environ["INTERNAL_API_SECRET"]
    EMAIL = os.environ["TRACEROOT_E2E_EMAIL"]  # a workspace member (app endpoints)
    PASSWORD = os.environ["TRACEROOT_E2E_PASSWORD"]
else:
    PROJECT = API_KEY = PLATFORM_SECRET = EMAIL = PASSWORD = ""

_PUBLIC = {"Authorization": f"Bearer {API_KEY}"}
_APP = {"X-Internal-Secret": PLATFORM_SECRET}


def _ch(sql: str) -> str:
    return httpx.post(CH, content=sql).text.strip()


@pytest.fixture(scope="module")
def app() -> httpx.Client:
    """A signed-in browser session; the finding→execution link is only served to the app."""
    client = httpx.Client(base_url=UI)
    resp = client.post("/api/auth/sign-in/email", json={"email": EMAIL, "password": PASSWORD})
    assert resp.status_code == 200, resp.text
    assert "better-auth.session_token" in client.cookies, "sign-in returned no session cookie"
    yield client
    client.close()


def _done_findings() -> list[dict]:
    """Public finding details whose RCA has completed; the journey needs >= 1.

    The public contract stops at ``rca.status``/``rca.result``: the agent trace behind an
    RCA is not readable through the public trace endpoints, so it is not advertised there.
    """
    listing = httpx.get(f"{REST}/api/v1/public/detectors/findings", headers=_PUBLIC)
    assert listing.status_code == 200, listing.text
    details = []
    for row in listing.json()["data"]:
        detail = httpx.get(
            f"{REST}/api/v1/public/detectors/findings/{row['finding_id']}", headers=_PUBLIC
        )
        assert detail.status_code == 200, detail.text
        assert set(detail.json()["rca"]) == {"status", "result"}, detail.json()["rca"]
        if detail.json()["rca"]["status"] == "done":
            details.append(detail.json())
    if not details:
        pytest.skip("no finding with a completed RCA is seeded yet")
    return details


def _executions(app: httpx.Client) -> list[dict]:
    """The current execution of every completed finding, as the finding page reads it."""
    rows = []
    for finding in _done_findings():
        resp = app.get(f"/api/projects/{PROJECT}/findings/{finding['finding_id']}/rca")
        assert resp.status_code == 200, resp.text
        rows.append(resp.json()["rca"])
    return rows


def test_completed_rca_hands_out_an_available_agent_trace(app):
    for rca in _executions(app):
        assert rca["status"] == "done", rca
        assert rca["result"]  # the analysis text customers read
        assert rca["attempt"] >= 1, rca
        assert rca["traceStatus"] == "available", rca
        assert rca["traceId"], rca


def test_agent_trace_is_readable_only_through_the_source_agent_seam(app):
    for rca in _executions(app):
        tid = rca["traceId"]
        base = f"{REST}/api/v1/projects/{PROJECT}/traces/{tid}"

        opted_in = httpx.get(base, params={"source": "agent"}, headers=_APP)
        assert opted_in.status_code == 200, opted_in.text
        trace = opted_in.json()
        assert trace["name"].startswith("rca:"), trace["name"]
        assert trace["spans"], "agent trace must carry its span tree"

        # The same id without the opt-in — and through the customer's public
        # API — must look like the trace does not exist (fail-closed reads).
        assert httpx.get(base, headers=_APP).status_code == 404
        assert httpx.get(base, params={"source": "user"}, headers=_APP).status_code == 404
        assert httpx.get(f"{REST}/api/v1/public/traces/{tid}", headers=_PUBLIC).status_code == 404


def test_agent_trace_records_the_prompt_and_final_answer(app):
    tid = _executions(app)[0]["traceId"]
    resp = httpx.get(
        f"{REST}/api/v1/projects/{PROJECT}/traces/{tid}",
        params={"source": "agent", "fields": "full"},
        headers=_APP,
    )
    assert resp.status_code == 200, resp.text
    root = next(s for s in resp.json()["spans"] if not s.get("parent_span_id"))
    assert root.get("input"), "root span must record the prompt the RCA agent was given"
    assert root.get("output"), "root span must record the final answer"


def test_agent_traces_never_reenter_the_customer_surface_or_the_detectors(app):
    agent_tids = {rca["traceId"] for rca in _executions(app)}

    listing = httpx.get(f"{REST}/api/v1/public/traces", headers=_PUBLIC, params={"limit": 200})
    assert listing.status_code == 200, listing.text
    listed = {t["trace_id"] for t in listing.json()["data"]}
    assert not listed & agent_tids, "agent traces leaked into the customer trace list"

    in_list = ",".join(f"'{t}'" for t in agent_tids)
    assert _ch(f"SELECT count() FROM detector_runs WHERE trace_id IN ({in_list})") == "0", (
        "an RCA self-trace re-triggered a detector"
    )


def test_digest_summary_self_trace_lands_under_source_detector():
    """The digest-summary LLM call is made by the worker, which authenticates with the
    platform secret — so its self-trace is classified ``detector`` (source is derived
    from the credential, never chosen by the client), unlike the agent service's RCA
    traces above.
    """
    count = _ch(
        "SELECT count() FROM traces "
        f"WHERE project_id='{PROJECT}' AND source='detector' AND name = 'digest-summary'"
    )
    if count == "0":
        pytest.skip("no digest flush has run yet (needs alert_emails and a closed window)")
    tid = _ch(
        "SELECT trace_id FROM traces "
        f"WHERE project_id='{PROJECT}' AND source='detector' AND name = 'digest-summary' LIMIT 1"
    )
    # Same seam contract as RCA traces: invisible without the opt-in.
    base = f"{REST}/api/v1/projects/{PROJECT}/traces/{tid}"
    assert httpx.get(base, params={"source": "detector"}, headers=_APP).status_code == 200
    assert httpx.get(base, headers=_APP).status_code == 404
    assert httpx.get(f"{REST}/api/v1/public/traces/{tid}", headers=_PUBLIC).status_code == 404
