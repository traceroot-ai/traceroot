"""Tiered, workspace-keyed rate limiting for the Traceroot REST API.

Design
------
* **Library**  ``slowapi`` (wraps ``limits``) with Redis storage shared across
  REST replicas, plus an in-memory fallback so a Redis outage degrades to
  per-process limiting instead of failing requests.
* **Key**      the *workspace* (resolved from the API key for ingestion, and
  from the authenticated user for dashboard reads) — never the raw API key, so
  a customer cannot multiply quota by minting more keys.
* **Tiers**    per ``(bucket, billing-plan)`` limits resolved at request time
  from ``settings.rate_limit`` (see ``RateLimitSettings``).
* **Self-host** deployments (``ENABLE_BILLING=false``) have no billing tiers, so
  rate limiting is disabled entirely — the limiter is built with
  ``enabled=False`` (see ``_build_limiter``); the operator's own infra is the
  ceiling. Limits therefore apply on cloud (billing-enabled) deployments only.
* **Buckets**  ``ingest`` (POST /public/traces) and ``read`` (dashboard GETs,
  which share one budget via ``shared_limit(scope="read")``).
* **Response** HTTP 429 with a JSON envelope plus ``Retry-After`` and
  ``X-RateLimit-*`` headers; OTLP exporters honor ``Retry-After`` and back off.

Mechanics
---------
slowapi evaluates the limit *after* FastAPI resolves the route's dependencies,
so the dependency layer stashes the resolved ``workspace_id``/``billing_plan``
onto ``request.state`` (read by ``key_func``). The dynamic-limit resolver only
receives the *key* (not the request), so the plan is embedded in the key.
Trusted internal service-to-service calls are exempted via a request-scoped
``ContextVar`` (slowapi's ``exempt_when`` receives no request).

Failure mode is fail-open: ``in_memory_fallback_enabled`` covers Redis outages
and ``swallow_errors`` ensures a broken limiter never turns into a 500.
"""

import logging
import time
from contextvars import ContextVar
from math import ceil
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from ee.license import is_billing_enabled
from shared.config import normalize_plan, settings

logger = logging.getLogger(__name__)

BUCKET_INGEST = "ingest"
BUCKET_READ = "read"
_KEY_PREFIX = "rl"

# Request-scoped exemption flag, set True by the access dependency for trusted
# internal service-to-service calls. ``exempt_when()`` receives no request, so a
# ContextVar is the clean way to pass per-request state to slowapi here. Each
# request runs in its own task with a fresh copy of the context, so the default
# (False) holds for normal traffic and there is no cross-request bleed.
_rate_limit_exempt: ContextVar[bool] = ContextVar("rate_limit_exempt", default=False)


# --- OpenTelemetry counter (no-op until a MeterProvider is configured) -------
# Instrument with the OTel metrics API only; wiring a MeterProvider/exporter is
# a separate, platform-wide concern. The structured log line below guarantees
# observability even before a provider exists.
def _build_exceeded_counter():
    try:
        from opentelemetry import metrics

        return metrics.get_meter("traceroot.rest.rate_limit").create_counter(
            "traceroot.rate_limit.exceeded",
            unit="1",
            description="Requests rejected with HTTP 429 by the REST rate limiter.",
        )
    except Exception:  # pragma: no cover - metrics are best-effort
        return None


_exceeded_counter = _build_exceeded_counter()


def clear_request_rate_limit_exempt() -> None:
    """Reset the exemption to the default for the current request.

    Per-task context isolation already prevents cross-request bleed, but the
    entry dependencies call this first so each request explicitly establishes
    its own exemption state (defense-in-depth) rather than inheriting any.
    """
    _rate_limit_exempt.set(False)


def mark_request_rate_limit_exempt() -> None:
    """Exempt the current request from rate limiting (trusted internal call)."""
    _rate_limit_exempt.set(True)


def is_request_rate_limit_exempt() -> bool:
    """Return whether the current request is exempt (slowapi ``exempt_when``)."""
    return _rate_limit_exempt.get()


def set_rate_limit_identity(
    request: Request, workspace_id: str | None, billing_plan: str | None
) -> None:
    """Stash the resolved workspace + plan on the request for the key/limit funcs.

    Called from the dependency layer, which runs before slowapi evaluates the
    limit, so ``key_func`` can read these off ``request.state``. Both enforced
    paths guarantee a workspace — ingest and dashboard-read auth each 503 on a
    missing one — so no fallback bucket is needed here. Trusted internal calls
    are exempt and may legitimately carry no workspace; that is fine because the
    key is never evaluated for them.

    Note: on self-host the limiter is disabled (see ``_build_limiter``), so this
    runs but is never read; it only matters on cloud (billing-enabled).
    """
    request.state.rl_workspace_id = workspace_id or ""
    request.state.rl_billing_plan = normalize_plan(billing_plan)


def _identity(request: Request) -> tuple[str, str]:
    # The dependency layer always stamps rl_workspace_id before slowapi calls
    # key_func, so the default is inert defensive code, never an enforced bucket.
    workspace_id = getattr(request.state, "rl_workspace_id", "")
    plan = normalize_plan(getattr(request.state, "rl_billing_plan", None))
    return workspace_id, plan


def key_ingest(request: Request) -> str:
    """Bucket key for ingestion: per workspace, with the plan embedded."""
    workspace_id, plan = _identity(request)
    request.state.rl_bucket = BUCKET_INGEST
    return f"{_KEY_PREFIX}:{BUCKET_INGEST}:{plan}:{workspace_id}"


def key_read(request: Request) -> str:
    """Bucket key for dashboard reads: per workspace, with the plan embedded."""
    workspace_id, plan = _identity(request)
    request.state.rl_bucket = BUCKET_READ
    return f"{_KEY_PREFIX}:{BUCKET_READ}:{plan}:{workspace_id}"


def resolve_limit(key: str) -> str:
    """Resolve the limit string from a bucket key (slowapi dynamic limit).

    slowapi passes the key (the output of ``key_func``), not the request, to a
    dynamic-limit callable — hence the plan is encoded in the key.
    Key format: ``rl:{bucket}:{plan}:{workspace_id}``.

    WARNING: the parameter MUST be named ``key`` — slowapi only forwards the
    bucket key when the callable's signature contains a literal ``key`` param
    (otherwise it calls this with no args). Renaming it would silently disable
    enforcement (errors are swallowed). ``test_resolve_limit_signature_is_literal_key``
    (signature) and ``test_resolve_limit_applies_per_plan_limits`` (behavior)
    guard against this; do not rename without updating those tests.
    """
    parts = key.split(":", 3)
    if len(parts) == 4:
        _, bucket, plan, _ = parts
    else:
        bucket, plan = BUCKET_READ, "free"
    return settings.rate_limit.limit_for(bucket, plan)


def _storage_state(request: Request) -> str:
    """ "ok" / "degraded": whether the limiter is on its in-memory fallback.

    slowapi flips ``_storage_dead`` when Redis is unreachable and it falls back
    to per-process in-memory counters — which multiplies the effective limit by
    the replica count. Surfacing it on every throttle lets ops alert on
    degraded-mode rate limiting (best-effort: only observable via throttle events).
    """
    app_state = getattr(getattr(request, "app", None), "state", None)
    limiter_obj = getattr(app_state, "limiter", None)
    return "degraded" if getattr(limiter_obj, "_storage_dead", False) else "ok"


def _record_exceeded(request: Request, retry_after: int) -> None:
    bucket = getattr(request.state, "rl_bucket", "unknown")
    workspace_id = getattr(request.state, "rl_workspace_id", "unknown")
    plan = getattr(request.state, "rl_billing_plan", "unknown")
    storage = _storage_state(request)
    logger.warning(
        "rate limit exceeded: bucket=%s workspace=%s plan=%s retry_after=%ss storage=%s",
        bucket,
        workspace_id,
        plan,
        retry_after,
        storage,
    )
    if _exceeded_counter is not None:
        try:
            # Only bounded-cardinality attributes here. workspace_id is high
            # cardinality and would blow up a metrics backend — it stays in the
            # log line above for debugging, not on the metric.
            _exceeded_counter.add(1, {"bucket": bucket, "plan": plan, "storage": storage})
        except Exception:  # pragma: no cover - best-effort metric
            logger.debug("failed to record rate_limit.exceeded counter", exc_info=True)


def rate_limit_exceeded_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    """Return a JSON 429 with accurate ``Retry-After`` / ``X-RateLimit-*`` headers.

    slowapi sets ``request.state.view_rate_limit = (limit_item, args)`` just
    before raising, letting us query the storage for the true time-until-reset
    and remaining count rather than the window *size*.

    ``Retry-After`` is always derived from the limit, never hardcoded: it starts
    from the limit's own window (``get_expiry()``) and is refined to the exact
    time-until-reset when the live window stats are readable.
    """
    limit_amount: int | None = None
    remaining: int | None = None
    reset_at: int | None = None

    # Base ``Retry-After``: the limit's own window size, always derivable from
    # the exception. ``exc.limit`` is typed None at the class level in slowapi,
    # but the instance always carries a Limit; ``get_expiry()`` returns the
    # window in seconds. This is a coarse over-estimate (the full window, not the
    # time remaining) used only until the live stats below refine it, or as the
    # floor when those are unreadable.
    try:
        limit_obj: Any = exc.limit
        retry_after = ceil(limit_obj.limit.get_expiry())
    except Exception:  # pragma: no cover - the window is effectively always present
        retry_after = 1

    view_rate_limit = getattr(request.state, "view_rate_limit", None)
    if view_rate_limit is not None:
        try:
            # Header values are best-effort: during a storage failover the
            # active limiter (`.limiter`) may differ from the one that recorded
            # the hit, so remaining/reset can be slightly off. The 429 decision
            # itself is always correct; only these advisory headers may drift.
            limit_item, args = view_rate_limit
            reset_epoch, remaining = request.app.state.limiter.limiter.get_window_stats(
                limit_item, *args
            )
            # slowapi convention: reset_in = 1 + reset_epoch.
            reset_at = int(reset_epoch) + 1
            # Refine to the exact time-until-reset.
            retry_after = max(1, reset_at - int(time.time()))
            limit_amount = limit_item.amount
        except Exception:  # pragma: no cover - keep the window-size base above
            logger.debug("failed to read window stats for 429 headers", exc_info=True)

    _record_exceeded(request, retry_after)

    body: dict[str, object] = {
        "error": "too_many_requests",
        "detail": "Rate limit exceeded. Slow down and retry after the cooldown.",
        "retry_after": retry_after,
    }
    headers = {"Retry-After": str(retry_after)}
    if limit_amount is not None:
        remaining_count = remaining if remaining is not None else 0
        body["limit"] = limit_amount
        body["remaining"] = remaining_count
        headers["X-RateLimit-Limit"] = str(limit_amount)
        headers["X-RateLimit-Remaining"] = str(remaining_count)
        if reset_at is not None:
            headers["X-RateLimit-Reset"] = str(reset_at)

    return JSONResponse(status_code=429, content=body, headers=headers)


def _build_limiter() -> Limiter:
    """Construct the application-wide limiter (Redis + in-memory fallback).

    Rate limiting is a cloud-only construct: on self-host (``ENABLE_BILLING``
    unset/false) there are no billing tiers, so the limiter is built disabled and
    every route decorator becomes inert; the operator's own infra is the ceiling.
    ``RATE_LIMIT_ENABLED=false`` also disables it on cloud.
    The billing gate is read once at startup; it does not change at runtime.
    """
    enabled = settings.rate_limit.enabled and is_billing_enabled()
    storage_uri = settings.rate_limit.storage_uri or settings.redis.url
    logger.info(
        "Initialising REST rate limiter (enabled=%s, billing_enabled=%s, storage=%s)",
        enabled,
        is_billing_enabled(),
        "redis" if storage_uri.startswith("redis") else storage_uri,
    )
    return Limiter(
        key_func=get_remote_address,  # default; each route overrides via key_func=
        enabled=enabled,
        storage_uri=storage_uri,
        headers_enabled=True,  # X-RateLimit-* on success responses
        in_memory_fallback_enabled=True,  # degrade to per-process on Redis outage
        swallow_errors=True,  # fail-open: never 500 because limiting itself broke
    )


limiter: Limiter = _build_limiter()
