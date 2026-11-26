"""Tests for the Vapi end-of-call-report webhook converter and TraceRoot OTel ingest."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

from worker.otel_transform import transform_otel_to_clickhouse

VAPI_EXAMPLE_DIR = Path(__file__).resolve().parents[2] / "examples" / "python" / "vapi-webhook"
if str(VAPI_EXAMPLE_DIR) not in sys.path:
    sys.path.insert(0, str(VAPI_EXAMPLE_DIR))

from converter import SpanSpec, VapiTracePlan, build_vapi_trace_plan  # noqa: E402


def _to_otel_attr(key: str, value: Any) -> dict[str, Any]:
    if isinstance(value, bool):
        return {"key": key, "value": {"boolValue": value}}
    if isinstance(value, int):
        return {"key": key, "value": {"intValue": str(value)}}
    if isinstance(value, float):
        return {"key": key, "value": {"doubleValue": value}}
    return {"key": key, "value": {"stringValue": str(value)}}


def _plan_to_otel_payload(plan: VapiTracePlan) -> dict[str, Any]:
    def _span_dict(spec: SpanSpec) -> dict[str, Any]:
        d: dict[str, Any] = {
            "traceId": plan.trace_id,
            "spanId": spec.span_id,
            "name": spec.name,
            "kind": 1,
            "startTimeUnixNano": str(spec.start_time_ns),
            "endTimeUnixNano": str(spec.end_time_ns),
            "attributes": [_to_otel_attr(k, v) for k, v in spec.attributes.items()],
            "status": {"code": 1},
        }
        if spec.parent_span_id:
            d["parentSpanId"] = spec.parent_span_id
        return d

    spans = [_span_dict(plan.root), *[_span_dict(c) for c in plan.children]]
    return {
        "resourceSpans": [
            {
                "resource": {"attributes": []},
                "scopeSpans": [{"scope": {"name": "traceroot.vapi"}, "spans": spans}],
            }
        ]
    }


def _sample_vapi_report() -> dict[str, Any]:
    return {
        "message": {
            "type": "end-of-call-report",
            "endedReason": "customer-ended-call",
            "call": {
                "id": "call-vapi-123",
                "startedAt": "2026-11-26T01:00:00Z",
                "endedAt": "2026-11-26T01:00:12Z",
                "cost": 0.0425,
            },
            "assistant": {
                "id": "asst-support",
                "name": "Order Support",
                "model": {"provider": "openai", "model": "gpt-4o"},
            },
            "analysis": {
                "summary": "Checked order #42 status and confirmed delivery.",
            },
            "artifact": {
                "transcript": "User: Where is order 42?\nAI: Order 42 is out for delivery.",
                "messages": [
                    {
                        "role": "user",
                        "message": "Where is order 42?",
                        "secondsFromStart": 1.0,
                        "duration": 1000,
                    },
                    {
                        "role": "bot",
                        "message": "Let me check order 42.",
                        "secondsFromStart": 2.5,
                        "duration": 800,
                        "toolCalls": [
                            {
                                "id": "tc-1",
                                "type": "function",
                                "function": {
                                    "name": "lookup_order",
                                    "arguments": '{"order_id": "42"}',
                                },
                            }
                        ],
                    },
                    {
                        "role": "tool_call_result",
                        "toolCallId": "tc-1",
                        "name": "lookup_order",
                        "result": '{"status": "out_for_delivery"}',
                        "secondsFromStart": 3.5,
                        "duration": 250,
                    },
                    {
                        "role": "bot",
                        "message": "Order 42 is out for delivery.",
                        "secondsFromStart": 4.0,
                        "duration": 1200,
                    },
                ],
            },
        }
    }


def test_ignores_non_end_of_call_events() -> None:
    assert build_vapi_trace_plan({"message": {"type": "status-update"}}) is None
    assert build_vapi_trace_plan({}) is None


def test_rejects_report_missing_call_id() -> None:
    with pytest.raises(ValueError, match="missing a non-empty call ID"):
        build_vapi_trace_plan({"message": {"type": "end-of-call-report", "call": {"id": "  "}}})


def test_prefers_envelope_cost_over_call_cost() -> None:
    payload = _sample_vapi_report()
    payload["message"]["cost"] = 0.0875
    plan = build_vapi_trace_plan(payload)
    assert plan is not None
    assert plan.root.attributes["llm.cost.total"] == 0.0875


def test_caps_messages_and_spans_per_report() -> None:
    payload = _sample_vapi_report()
    payload["message"]["artifact"]["messages"] = [
        {"role": "user", "message": f"Question {i}"} for i in range(1500)
    ]
    plan = build_vapi_trace_plan(payload)
    assert plan is not None
    assert len(plan.children) <= 1000


def test_vapi_report_transforms_into_traceroot_trace_with_session_llm_tool_and_cost() -> None:
    plan = build_vapi_trace_plan(_sample_vapi_report())
    assert plan is not None
    assert plan.call_id == "call-vapi-123"

    traces, spans = transform_otel_to_clickhouse(_plan_to_otel_payload(plan), "proj-1")
    assert len(traces) == 1
    assert traces[0]["session_id"] == "call-vapi-123"

    by_kind = {}
    for s in spans:
        by_kind.setdefault(s["span_kind"], []).append(s)

    assert len(by_kind["AGENT"]) == 1
    root = by_kind["AGENT"][0]
    assert root["name"] == "vapi.call (Order Support)"
    assert root["cost"] == 0.0425
    assert "Where is order 42?" in root["input"]
    assert root["output"] == "Checked order #42 status and confirmed delivery."

    assert len(by_kind["LLM"]) == 2
    assert all(s["model_name"] == "gpt-4o" for s in by_kind["LLM"])
    assert by_kind["LLM"][0]["input"] == "Where is order 42?"
    assert by_kind["LLM"][1]["output"] == "Order 42 is out for delivery."

    assert len(by_kind["TOOL"]) == 1
    tool = by_kind["TOOL"][0]
    assert tool["name"] == "lookup_order"
    assert tool["input"] == '{"order_id": "42"}'
    assert tool["output"] == '{"status": "out_for_delivery"}'
