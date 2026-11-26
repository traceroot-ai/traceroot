"""FastAPI webhook receiver that converts Vapi end-of-call reports to TraceRoot traces."""

from __future__ import annotations

import asyncio
import hmac
import json
import os
from collections import OrderedDict
from typing import Any

from converter import SpanSpec, VapiTracePlan, build_vapi_trace_plan
from dotenv import find_dotenv, load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request, status
from opentelemetry import trace
from opentelemetry.trace import SpanContext, TraceFlags, set_span_in_context

import traceroot

dotenv_path = find_dotenv()
if dotenv_path:
    load_dotenv(dotenv_path)

traceroot.initialize()
_tracer = trace.get_tracer("traceroot.vapi")

app = FastAPI(title="TraceRoot Vapi Webhook Importer")

_MAX_SEEN_CALL_IDS = 10_000
_seen_call_ids: OrderedDict[str, None] = OrderedDict()
_seen_lock = asyncio.Lock()

_MAX_BODY_BYTES = 5 * 1024 * 1024  # 5 MiB cap on incoming JSON reports


async def _read_capped_json(request: Request) -> dict[str, Any]:
    """Read request body capped at _MAX_BODY_BYTES to prevent memory exhaustion."""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > _MAX_BODY_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Payload exceeds 5 MiB limit",
        )
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > _MAX_BODY_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="Payload exceeds 5 MiB limit",
            )
        chunks.append(chunk)
    body = b"".join(chunks)
    try:
        payload = json.loads(body)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid JSON payload",
        ) from exc
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="JSON payload must be an object",
        )
    return payload


def _emit_span(spec: SpanSpec, parent_context: Any | None = None) -> Any:
    span = _tracer.start_span(
        name=spec.name,
        context=parent_context,
        start_time=spec.start_time_ns,
        attributes=spec.attributes,
    )
    span.end(end_time=spec.end_time_ns)
    return span


def emit_vapi_trace_plan(plan: VapiTracePlan) -> None:
    """Emit all spans in a ``VapiTracePlan`` through the active OTel tracer."""
    root_span = _emit_span(plan.root)
    span_contexts: dict[str, Any] = {plan.root.span_id: set_span_in_context(root_span)}

    for child in plan.children:
        parent_ctx = span_contexts.get(child.parent_span_id or plan.root.span_id)
        if parent_ctx is None:
            parent_ctx = set_span_in_context(
                trace.NonRecordingSpan(
                    SpanContext(
                        trace_id=int(plan.trace_id, 16),
                        span_id=int(plan.root.span_id, 16),
                        is_remote=False,
                        trace_flags=TraceFlags(TraceFlags.SAMPLED),
                    )
                )
            )
        child_span = _emit_span(child, parent_context=parent_ctx)
        span_contexts[child.span_id] = set_span_in_context(child_span)

    traceroot.flush()


@app.post("/vapi/webhook")
async def vapi_webhook(
    request: Request,
    x_vapi_secret: str | None = Header(default=None),
) -> dict[str, str]:
    """Receive Vapi server webhook events and export end-of-call reports to TraceRoot."""
    expected_secret = os.getenv("VAPI_WEBHOOK_SECRET")
    if (
        not expected_secret
        or not x_vapi_secret
        or not hmac.compare_digest(x_vapi_secret, expected_secret)
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing webhook secret",
        )

    payload = await _read_capped_json(request)
    try:
        plan = build_vapi_trace_plan(payload)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
    if plan is None:
        return {"status": "ignored"}

    async with _seen_lock:
        if plan.call_id in _seen_call_ids:
            return {"status": "duplicate", "call_id": plan.call_id}
        _seen_call_ids[plan.call_id] = None
        if len(_seen_call_ids) > _MAX_SEEN_CALL_IDS:
            _seen_call_ids.popitem(last=False)

    try:
        await asyncio.to_thread(emit_vapi_trace_plan, plan)
    except Exception:
        async with _seen_lock:
            _seen_call_ids.pop(plan.call_id, None)
        raise
    return {"status": "exported", "call_id": plan.call_id}
