"""E2E harness: emit OTLP to a live traceroot stack and assert on stored results.

These helpers drive the *running* stack (backend at ``localhost:8000``, ClickHouse,
Redis, the Celery + TS detector workers) the same way a real SDK does:

- :meth:`E2EClient.emit` builds an OTLP/JSON payload with the existing
  ``tests.fixtures.otel_payloads`` builders, converts it to protobuf via
  ``ParseDict`` (the exact reverse of the backend's ``MessageToDict`` decode), and
  POSTs it to the public ingest endpoint with a Bearer API key. One ``emit`` call is
  one ingest *batch*, so a multi-batch trace is several ``emit`` calls sharing a
  ``trace_id``.
- Assertions read back through the same surfaces production uses: the internal-secret
  trace read (per-span ``usage_details`` + ``cost``), the settle-status
  endpoint, and ClickHouse for detector runs/findings.

Token attribute shapes and the LLM-kind gate mirror ``backend/worker/otel_transform.py``;
cache pricing mirrors ``backend/worker/tokens/pricing.py``.
"""

from __future__ import annotations

import functools
import json
import re
import secrets
import time
from dataclasses import dataclass
from pathlib import Path

import httpx
from google.protobuf.json_format import ParseDict
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)

DEFAULT_HOST = "http://localhost:8000"

# tests/e2e/harness.py -> parents[2] == repo root
_PRICE_FILE = (
    Path(__file__).resolve().parents[2] / "frontend/packages/core/src/standard-model-prices.json"
)


def rand_trace_id() -> str:
    """A fresh 16-byte (32 hex char) OTLP trace id."""
    return secrets.token_hex(16)


def rand_span_id() -> str:
    """A fresh 8-byte (16 hex char) OTLP span id."""
    return secrets.token_hex(8)


def now_nanos() -> int:
    return time.time_ns()


@dataclass(frozen=True)
class E2EConfig:
    host: str
    api_key: str
    internal_secret: str
    project_id: str


@functools.lru_cache(maxsize=1)
def _price_catalog() -> list[dict]:
    return json.loads(_PRICE_FILE.read_text())


def model_prices(model_name: str) -> dict | None:
    """Return the price block for ``model_name`` by regex-matching the catalog.

    Mirrors the worker's lookup (each entry carries a case-insensitive, anchored
    ``matchPattern``) so cost assertions track the real price table rather than
    hard-coded rates.
    """
    for entry in _price_catalog():
        pattern = entry.get("matchPattern")
        if pattern and re.match(pattern, model_name):
            return entry.get("prices")
    return None


def expected_cost(
    prices: dict,
    *,
    input_uncached: int,
    cache_read: int,
    cache_write: int,
    output: int,
) -> float:
    """Cost from disjoint buckets, mirroring ``cost_from_buckets``.

    Each per-cache rate falls back to the base input rate when absent, exactly as
    the worker does; reasoning tokens are display-only and never priced here.
    """
    input_rate = prices["input"]
    return (
        input_uncached * input_rate
        + cache_read * prices.get("cacheRead", input_rate)
        + cache_write * prices.get("cacheWrite", input_rate)
        + output * prices["output"]
    )


class E2EClient:
    """Thin client over the live stack: emit OTLP, read back spans/findings."""

    def __init__(self, cfg: E2EConfig):
        self.cfg = cfg
        self._http = httpx.Client(base_url=cfg.host, timeout=30.0)

    # -- emission -----------------------------------------------------------

    def emit(self, payload: dict) -> None:
        """POST one OTLP/JSON payload (one ingest batch) as protobuf."""
        request = ParseDict(payload, ExportTraceServiceRequest())
        body = request.SerializeToString()
        resp = self._http.post(
            "/api/v1/public/traces",
            content=body,
            headers={
                "Authorization": f"Bearer {self.cfg.api_key}",
                "Content-Type": "application/x-protobuf",
            },
        )
        resp.raise_for_status()

    # -- trace reads (internal-secret admin bypass) -------------------------

    def get_trace(self, trace_id: str) -> dict | None:
        resp = self._http.get(
            f"/api/v1/projects/{self.cfg.project_id}/traces/{trace_id}",
            headers={"X-Internal-Secret": self.cfg.internal_secret},
        )
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()

    def get_span(self, trace_id: str, span_id: str) -> dict | None:
        trace = self.get_trace(trace_id)
        if not trace:
            return None
        for span in trace.get("spans", []):
            if span.get("span_id") == span_id:
                return span
        return None

    def poll_span(
        self,
        trace_id: str,
        span_id: str,
        predicate=None,
        *,
        timeout: float = 45.0,
        interval: float = 2.0,
    ) -> dict | None:
        """Poll until the span exists (and ``predicate`` passes). Ingestion is
        async (Celery), so reads need a bounded wait. Returns the last-seen span
        (or ``None``) on timeout so callers get a useful assertion message."""
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            last = self.get_span(trace_id, span_id)
            if last is not None and (predicate is None or predicate(last)):
                return last
            time.sleep(interval)
        return last

    def settle_age_seconds(self, trace_id: str) -> float | None:
        resp = self._http.get(
            f"/api/v1/internal/traces/{trace_id}/settle-status",
            params={"project_id": self.cfg.project_id},
            headers={"X-Internal-Secret": self.cfg.internal_secret},
        )
        resp.raise_for_status()
        return resp.json().get("last_arrival_age_seconds")

    def close(self) -> None:
        self._http.close()


def usage(span: dict) -> dict:
    """``usage_details`` map for a span, defaulting missing keys to 0."""
    details = span.get("usage_details") or {}
    return {
        "cache_read_tokens": int(details.get("cache_read_tokens", 0) or 0),
        "cache_write_tokens": int(details.get("cache_write_tokens", 0) or 0),
        "reasoning_tokens": int(details.get("reasoning_tokens", 0) or 0),
    }
