"""FastAPI webhook receiver that converts Vapi end-of-call reports to TraceRoot traces."""

from __future__ import annotations

import hmac
import os
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
    if expected_secret and (
        not x_vapi_secret or not hmac.compare_digest(x_vapi_secret, expected_secret)
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid webhook secret",
        )

    payload = await request.json()
    plan = build_vapi_trace_plan(payload)
    if plan is None:
        return {"status": "ignored"}

    emit_vapi_trace_plan(plan)
    return {"status": "exported", "call_id": plan.call_id}
