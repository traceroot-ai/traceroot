"""Customer-metrics contract: ingesting internal traces changes nothing a customer sees, and
moves only the internal usage buckets. Requires the dev stack (REST :8000, ClickHouse :8123,
Redis :26379). Skipped unless TRACEROOT_E2E=1.
"""

import os
import time
import uuid

import httpx
import pytest
import redis

# TRACEROOT_E2E gates both collection-time env lookups below and test execution: a
# skipif marker alone only skips the test body, and this module would otherwise
# raise KeyError at collection on any run that hasn't opted into the live stack.
_E2E_ENABLED = os.getenv("TRACEROOT_E2E") == "1"
pytestmark = pytest.mark.skipif(not _E2E_ENABLED, reason="needs the dev stack")

REST = os.getenv("TRACEROOT_REST_URL", "http://localhost:8000")
CH = os.getenv("TRACEROOT_CH_URL", "http://localhost:8123/?user=clickhouse&password=clickhouse")
REDIS = os.getenv("TRACEROOT_REDIS_URL", "redis://localhost:26379/0")
if _E2E_ENABLED:
    PROJECT = os.environ["TRACEROOT_E2E_PROJECT_ID"]  # a seeded project with >= 1 user trace
    API_KEY = os.environ["TRACEROOT_E2E_API_KEY"]  # project access key (public API)
    PLATFORM_SECRET = os.environ["INTERNAL_API_SECRET"]
    AGENT_SECRET = os.environ["INTERNAL_API_SECRET_AGENT"]
else:
    PROJECT = API_KEY = PLATFORM_SECRET = AGENT_SECRET = ""


def _otlp_body(trace_id: bytes, name: str) -> bytes:
    from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

    req = ExportTraceServiceRequest()
    scope = req.resource_spans.add().scope_spans.add()
    span = scope.spans.add()
    span.trace_id = trace_id
    span.span_id = uuid.uuid4().bytes[:8]
    span.name = name
    attr = span.attributes.add()
    attr.key = "traceroot.project_id"
    attr.value.string_value = PROJECT
    span.start_time_unix_nano = time.time_ns()
    span.end_time_unix_nano = span.start_time_unix_nano + 1_000_000
    return req.SerializeToString()


def _snapshot() -> dict:
    h = {"Authorization": f"Bearer {API_KEY}"}
    return {
        "trace_list": httpx.get(
            f"{REST}/api/v1/public/traces", headers=h, params={"limit": 50}
        ).json(),
        "findings": httpx.get(f"{REST}/api/v1/public/detectors/findings", headers=h).json(),
        "usage": httpx.get(
            f"{REST}/api/v1/internal/usage/details",
            headers={"X-Internal-Secret": PLATFORM_SECRET},
            params={
                "project_ids": PROJECT,
                "start": "2000-01-01T00:00:00Z",
                "end": "2100-01-01T00:00:00Z",
            },
        ).json(),
    }


def _ch(sql: str) -> str:
    return httpx.post(CH, content=sql).text.strip()


def _detector_jobs(r) -> int:
    """Every state a queued detector job can occupy, so the count is stable.

    `wait` alone is not enough: BullMQ moves a picked-up job to `active`, and a
    pre-existing job whose EVALUATOR_DELAY elapses mid-test transitions
    delayed -> wait -> active. Counting all three keeps the before/after
    comparison measuring "did we enqueue", not "did an unrelated job advance".
    """
    return (
        r.zcard("bull:detector-run:delayed")
        + r.llen("bull:detector-run:wait")
        + r.llen("bull:detector-run:active")
    )


def test_internal_traces_do_not_change_customer_views_and_move_only_internal_buckets():
    r = redis.from_url(REDIS)
    jobs_before = _detector_jobs(r)
    before = _snapshot()

    agent_tid = uuid.uuid4().bytes
    det_tid = uuid.uuid4().bytes
    for secret, tid, name in (
        (AGENT_SECRET, agent_tid, "rca: test"),
        (PLATFORM_SECRET, det_tid, "detector-run: test"),
    ):
        resp = httpx.post(
            f"{REST}/api/v1/internal/traces",
            content=_otlp_body(tid, name),
            headers={"X-Internal-Secret": secret, "Content-Type": "application/x-protobuf"},
        )
        assert resp.status_code == 200, resp.text

    after = _snapshot()

    # Customer views: byte-identical.
    assert after["trace_list"] == before["trace_list"]
    assert after["findings"] == before["findings"]
    # Usage: user bucket unchanged; internal buckets grew by exactly one trace + one span each.
    assert after["usage"]["by_source"]["user"] == before["usage"]["by_source"]["user"]
    for src in ("agent", "detector"):
        assert (
            after["usage"]["by_source"][src]["traces"]
            == before["usage"]["by_source"][src]["traces"] + 1
        )
        assert (
            after["usage"]["by_source"][src]["spans"]
            == before["usage"]["by_source"][src]["spans"] + 1
        )
    # Totals moved by the same rows (billed whoever wrote them).
    assert after["usage"]["traces"] == before["usage"]["traces"] + 2
    assert after["usage"]["spans"] == before["usage"]["spans"] + 2
    # No detection was enqueued and no judge run exists for the agent trace.
    assert _detector_jobs(r) == jobs_before
    assert (
        _ch(
            f"SELECT count() FROM detector_runs WHERE project_id='{PROJECT}' AND trace_id='{agent_tid.hex()}'"
        )
        == "0"
    )
    # The rows are readable through the opt-in seam and stamped correctly.
    assert _ch(f"SELECT DISTINCT source FROM spans WHERE trace_id='{agent_tid.hex()}'") == "agent"
    assert _ch(f"SELECT DISTINCT source FROM spans WHERE trace_id='{det_tid.hex()}'") == "detector"
