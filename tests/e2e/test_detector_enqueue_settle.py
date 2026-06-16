"""E2E: enqueue detection exactly once, evaluate only after the trace settles.

A trace that arrives across multiple ingest batches must (a) enqueue detection
exactly once — only the batch carrying the root span claims it via a Redis NX lock —
and (b) be evaluated only once no span has arrived for ``EVALUATOR_DELAY`` (60s),
so early-finishing/streaming traces (root exports before its children) aren't judged
on a partial trace.

Two layers:
- **Lighter** (always runs under TRACEROOT_E2E=1): assert the enqueue-once claim
  via traceroot's own Redis lock and that nothing evaluates inside the window — no
  60s wait.
- **Full timing** (TRACEROOT_E2E_SLOW=1): wait out the window and assert exactly one
  run, fired ~60s after the *last* span — including the streaming case where the root
  arrives well before the last child. Requires the live TS detector worker; a working
  judge/BYOK provider lets the run complete, but the run-count/timing assertions hold
  even if the judge fails (a failed run row is still written by the eval-timeout path).
"""

from __future__ import annotations

import json
import os
import time

import pytest

from tests.e2e.harness import now_nanos, rand_span_id, rand_trace_id
from tests.fixtures.otel_payloads import make_attr, make_otel_payload, make_span

EVALUATOR_DELAY = 60  # seconds for our waits; the backend/TS constant is 60_000 ms
# Lower bound proving the worker waited the quiescence window rather than evaluating
# immediately or off the early root. Loose enough to absorb poll/clock slop.
MIN_WAIT = 55.0


def _requires_slow():
    if os.getenv("TRACEROOT_E2E_SLOW") != "1":
        pytest.skip("slow timing test: set TRACEROOT_E2E_SLOW=1 (waits out the 60s window)")


def _requires_always_trigger(detector: dict):
    if detector.get("conditions"):
        pytest.skip(
            "detector has trigger conditions; these tests need an always-triggering "
            "detector (empty conditions) so sampling is the only gate"
        )


def _root_span(trace_id: str, span_id: str, start_ns: int) -> dict:
    return make_span(
        trace_id_hex=trace_id,
        span_id_hex=span_id,
        name="root",
        start_nanos=start_ns,
        end_nanos=start_ns + 500_000_000,
        attributes=[
            make_attr("traceroot.span.type", "AGENT"),
            make_attr("traceroot.environment", "e2e"),
        ],
    )


def _child_span(trace_id: str, span_id: str, parent_id: str, start_ns: int) -> dict:
    return make_span(
        trace_id_hex=trace_id,
        span_id_hex=span_id,
        parent_span_id_hex=parent_id,
        name="child",
        start_nanos=start_ns,
        end_nanos=start_ns + 200_000_000,
        attributes=[make_attr("traceroot.span.type", "TOOL")],
    )


def _lock_state(redis_client, project_id: str, trace_id: str):
    raw = redis_client.get(f"detector-enq:{project_id}:{trace_id}")
    if raw is None:
        return None
    return json.loads(raw).get("state")


def _run_count(ch, project_id: str, trace_id: str, detector_id: str) -> int:
    result = ch.query(
        """
        SELECT count() FROM detector_runs FINAL
        WHERE project_id = {p:String} AND detector_id = {d:String} AND trace_id = {t:String}
        """,
        parameters={"p": project_id, "d": detector_id, "t": trace_id},
    )
    return int(result.result_rows[0][0])


def _finding_count(ch, project_id: str, trace_id: str) -> int:
    result = ch.query(
        """
        SELECT count() FROM detector_findings FINAL
        WHERE project_id = {p:String} AND trace_id = {t:String}
        """,
        parameters={"p": project_id, "t": trace_id},
    )
    return int(result.result_rows[0][0])


def _wait_for_run(ch, project_id, trace_id, detector_id, *, timeout) -> float | None:
    """Poll until a run row appears; return seconds waited (monotonic), or None."""
    t0 = time.monotonic()
    deadline = t0 + timeout
    while time.monotonic() < deadline:
        if _run_count(ch, project_id, trace_id, detector_id) >= 1:
            return time.monotonic() - t0
        time.sleep(2.0)
    return None


# --------------------------------------------------------------------------
# Lighter layer — no 60s wait
# --------------------------------------------------------------------------


def test_multibatch_trace_claims_enqueue_once(client, detector, redis_client, ch):
    """Root + two child batches → a single 'pending' enqueue claim, no early eval."""
    _requires_always_trigger(detector)
    cfg = client.cfg
    trace_id = rand_trace_id()
    root_id = rand_span_id()
    start = now_nanos()

    # Batch 1 carries the root (this is the batch that claims + enqueues).
    client.emit(make_otel_payload([_root_span(trace_id, root_id, start)], scope_name="ai"))
    # Batches 2 and 3 are children only — must NOT enqueue again.
    client.emit(
        make_otel_payload(
            [_child_span(trace_id, rand_span_id(), root_id, start + 300_000_000)],
            scope_name="ai",
        )
    )
    client.emit(
        make_otel_payload(
            [_child_span(trace_id, rand_span_id(), root_id, start + 600_000_000)],
            scope_name="ai",
        )
    )

    # Give ingestion + the synchronous enqueue claim a moment to land.
    deadline = time.monotonic() + 30.0
    state = None
    while time.monotonic() < deadline:
        state = _lock_state(redis_client, cfg.project_id, trace_id)
        if state == "pending":
            break
        time.sleep(2.0)

    assert state == "pending", f"expected a single 'pending' enqueue claim, got {state!r}"
    # Inside the 60s window nothing may have evaluated yet.
    assert _run_count(ch, cfg.project_id, trace_id, detector["id"]) == 0, "evaluated early"


def test_no_evaluation_inside_window(client, detector, ch):
    """No detector run is written within the quiescence window."""
    _requires_always_trigger(detector)
    cfg = client.cfg
    trace_id = rand_trace_id()
    root_id = rand_span_id()
    start = now_nanos()
    client.emit(make_otel_payload([_root_span(trace_id, root_id, start)], scope_name="ai"))

    time.sleep(20.0)  # well inside the 60s window
    assert _run_count(ch, cfg.project_id, trace_id, detector["id"]) == 0


def _bullmq_jobs_for_trace(redis_client, trace_id: str) -> list:
    """Every detector-run BullMQ job whose payload references this trace.

    Scans the queue's job hashes rather than trusting the deterministic jobId, so a
    stray enqueue under a *different* jobId would still be caught.
    """
    prefix = "bull:detector-run:"
    out = []
    for key in redis_client.scan_iter(f"{prefix}*"):
        k = key.decode() if isinstance(key, bytes) else key
        if redis_client.type(k) != b"hash":
            continue
        data = redis_client.hget(k, "data")
        if not data:
            continue
        try:
            payload = json.loads(data)
        except (ValueError, TypeError):
            continue
        if payload.get("traceId") == trace_id:
            out.append(payload)
    return out


def test_no_duplicate_enqueue_across_batches(client, detector, redis_client):
    """Duplicate root deliveries + child-only batches enqueue exactly ONE job.

    Directly counts BullMQ jobs (not just the downstream run count, which the
    deterministic runId would collapse anyway) so a genuine double-enqueue is visible.
    """
    _requires_always_trigger(detector)
    trace_id = rand_trace_id()
    root_id = rand_span_id()
    start = now_nanos()

    root_payload = make_otel_payload([_root_span(trace_id, root_id, start)], scope_name="ai")
    # Adversarial: deliver the root span in 3 separate batches...
    for _ in range(3):
        client.emit(root_payload)
    # ...plus child-only batches, which must not enqueue.
    client.emit(
        make_otel_payload(
            [_child_span(trace_id, rand_span_id(), root_id, start + 300_000_000)], scope_name="ai"
        )
    )
    client.emit(
        make_otel_payload(
            [_child_span(trace_id, rand_span_id(), root_id, start + 600_000_000)], scope_name="ai"
        )
    )

    # Poll (inside the 60s window, before the job is consumed) until it appears.
    deadline = time.monotonic() + 30.0
    jobs = []
    while time.monotonic() < deadline:
        jobs = _bullmq_jobs_for_trace(redis_client, trace_id)
        if jobs:
            break
        time.sleep(2.0)
    assert len(jobs) == 1, f"expected exactly one enqueued detector job, got {len(jobs)}"


# --------------------------------------------------------------------------
# Full timing layer — waits out the 60s window (TRACEROOT_E2E_SLOW=1)
# --------------------------------------------------------------------------


def test_exactly_one_run_after_quiescence(client, detector, ch):
    """A multi-batch trace yields exactly one run, fired after the quiet window."""
    _requires_slow()
    _requires_always_trigger(detector)
    cfg = client.cfg
    trace_id = rand_trace_id()
    root_id = rand_span_id()
    start = now_nanos()

    client.emit(make_otel_payload([_root_span(trace_id, root_id, start)], scope_name="ai"))
    client.emit(
        make_otel_payload(
            [_child_span(trace_id, rand_span_id(), root_id, start + 300_000_000)],
            scope_name="ai",
        )
    )
    client.emit(
        make_otel_payload(
            [_child_span(trace_id, rand_span_id(), root_id, start + 600_000_000)],
            scope_name="ai",
        )
    )
    t_last = time.monotonic()

    waited = _wait_for_run(ch, cfg.project_id, trace_id, detector["id"], timeout=150.0)
    assert waited is not None, "no detector run appeared (is the TS worker running?)"
    elapsed = time.monotonic() - t_last
    assert elapsed >= MIN_WAIT, f"evaluated too early ({elapsed:.1f}s < {MIN_WAIT}s window)"

    # Let any duplicate enqueue/retry settle, then assert exactly one logical run.
    time.sleep(5.0)
    assert _run_count(ch, cfg.project_id, trace_id, detector["id"]) == 1
    assert _finding_count(ch, cfg.project_id, trace_id) <= 1


def test_streaming_waits_for_last_span_not_early_root(client, detector, ch):
    """Streaming trace: root exports early, last child ~35s later.

    Evaluation must wait 60s after the *last child*, not 60s after the early root
    (which would fire ~25s after the child). We prove it by asserting the run is
    observed >= ~55s after the last child arrives.
    """
    _requires_slow()
    _requires_always_trigger(detector)
    cfg = client.cfg
    trace_id = rand_trace_id()
    root_id = rand_span_id()
    start = now_nanos()

    # Root arrives first (and starts the would-be early timer).
    client.emit(make_otel_payload([_root_span(trace_id, root_id, start)], scope_name="ai"))
    time.sleep(35.0)
    # Last child arrives well into the root's window.
    client.emit(
        make_otel_payload(
            [_child_span(trace_id, rand_span_id(), root_id, now_nanos())],
            scope_name="ai",
        )
    )
    t_last_child = time.monotonic()

    waited = _wait_for_run(ch, cfg.project_id, trace_id, detector["id"], timeout=150.0)
    assert waited is not None, "no detector run appeared (is the TS worker running?)"
    elapsed = time.monotonic() - t_last_child
    assert elapsed >= MIN_WAIT, (
        f"evaluated {elapsed:.1f}s after the last child — looks like it fired off the "
        f"early root instead of waiting for quiescence"
    )
    assert _run_count(ch, cfg.project_id, trace_id, detector["id"]) == 1
