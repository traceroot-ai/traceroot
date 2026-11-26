"""Convert Vapi end-of-call-report webhook payloads into TraceRoot OTel span plans."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any


@dataclass(frozen=True)
class SpanSpec:
    """Normalized span specification ready to emit via OpenTelemetry or OTLP."""

    name: str
    span_id: str
    parent_span_id: str | None
    start_time_ns: int
    end_time_ns: int
    attributes: dict[str, Any] = field(default_factory=dict)


_MAX_MESSAGES_PER_REPORT = 1_000
_MAX_CHILD_SPANS_PER_REPORT = 2_000


@dataclass(frozen=True)
class VapiTracePlan:
    """Complete trace plan derived from one Vapi end-of-call-report payload."""

    trace_id: str
    call_id: str
    root: SpanSpec
    children: list[SpanSpec]


def _deterministic_hex(seed: str, length: int) -> str:
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()[:length]


def _parse_timestamp_ns(value: Any, fallback_ns: int) -> int:
    """Parse an ISO-8601 string or epoch number (ms or s) into nanoseconds."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        # Vapi message `time` is epoch milliseconds (> 1e12) or seconds.
        if value > 1e12:
            return int(value * 1_000_000)
        if value > 1e9:
            return int(value * 1_000_000_000)
        return fallback_ns
    if isinstance(value, str) and value.strip():
        raw = value.strip()
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(raw)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=UTC)
            return int(dt.timestamp() * 1_000_000_000)
        except ValueError:
            return fallback_ns
    return fallback_ns


def _msg_start_ns(msg: dict[str, Any], call_start_ns: int, fallback_ns: int) -> int:
    if "time" in msg:
        parsed = _parse_timestamp_ns(msg["time"], -1)
        if parsed > 0:
            return parsed
    sec = msg.get("secondsFromStart")
    if isinstance(sec, (int, float)) and not isinstance(sec, bool) and sec >= 0:
        return call_start_ns + int(sec * 1_000_000_000)
    return fallback_ns


def _stringify(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def _extract_tool_calls(msg: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract OpenAI/Vapi-style tool call dicts from an assistant message."""
    raw = msg.get("toolCalls") or msg.get("tool_calls") or []
    return [tc for tc in raw if isinstance(tc, dict)]


def build_vapi_trace_plan(
    payload: dict[str, Any], now_ns: int | None = None
) -> VapiTracePlan | None:
    """Convert a Vapi server webhook payload into a ``VapiTracePlan``.

    Returns ``None`` when the payload is not an ``end-of-call-report`` event.
    """
    envelope = payload.get("message")
    if not isinstance(envelope, dict):
        return None
    if envelope.get("type") != "end-of-call-report":
        return None

    call = envelope.get("call") if isinstance(envelope.get("call"), dict) else {}
    assistant = envelope.get("assistant") if isinstance(envelope.get("assistant"), dict) else {}
    artifact = envelope.get("artifact") if isinstance(envelope.get("artifact"), dict) else {}
    analysis = envelope.get("analysis") if isinstance(envelope.get("analysis"), dict) else {}

    raw_call_id = call.get("id") or envelope.get("callId")
    if not isinstance(raw_call_id, str) or not raw_call_id.strip():
        raise ValueError("Vapi end-of-call-report is missing a non-empty call ID")
    call_id = raw_call_id.strip()
    trace_id = _deterministic_hex(f"vapi-trace:{call_id}", 32)
    root_span_id = _deterministic_hex(f"vapi-root:{call_id}", 16)

    default_now_ns = now_ns if now_ns is not None else int(datetime.now(UTC).timestamp() * 1e9)
    call_start_ns = _parse_timestamp_ns(
        call.get("startedAt") or envelope.get("startedAt"),
        default_now_ns,
    )
    call_end_ns = _parse_timestamp_ns(
        call.get("endedAt") or envelope.get("endedAt"),
        call_start_ns + 1_000_000_000,
    )
    if call_end_ns <= call_start_ns:
        call_end_ns = call_start_ns + 1_000_000

    model_cfg = assistant.get("model") if isinstance(assistant.get("model"), dict) else {}
    model_name = model_cfg.get("model")
    model_provider = model_cfg.get("provider")

    messages = artifact.get("messages")
    if not isinstance(messages, list):
        messages = []
    elif len(messages) > _MAX_MESSAGES_PER_REPORT:
        messages = messages[:_MAX_MESSAGES_PER_REPORT]

    # Index tool results by toolCallId so each tool call span carries both args and result.
    tool_results_by_id: dict[str, dict[str, Any]] = {}
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        if msg.get("role") in ("tool_call_result", "tool"):
            tc_id = msg.get("toolCallId") or msg.get("tool_call_id")
            if tc_id:
                tool_results_by_id[str(tc_id)] = msg

    children: list[SpanSpec] = []
    last_user_text: str | None = None

    for idx, msg in enumerate(messages):
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role") or "")
        text = msg.get("message") if msg.get("message") is not None else msg.get("content")

        if role == "user":
            if text is not None:
                last_user_text = _stringify(text)
            continue

        if role not in ("bot", "assistant"):
            continue

        span_start = _msg_start_ns(msg, call_start_ns, call_start_ns + idx * 1_000_000)
        duration_ms = msg.get("duration")
        if (
            isinstance(duration_ms, (int, float))
            and not isinstance(duration_ms, bool)
            and duration_ms > 0
        ):
            span_end = span_start + int(duration_ms * 1_000_000)
        elif idx + 1 < len(messages) and isinstance(messages[idx + 1], dict):
            next_start = _msg_start_ns(messages[idx + 1], call_start_ns, span_start + 500_000_000)
            span_end = max(next_start, span_start + 1_000_000)
        else:
            span_end = max(call_end_ns, span_start + 1_000_000)

        llm_span_id = _deterministic_hex(f"vapi-llm:{call_id}:{idx}", 16)
        llm_attrs: dict[str, Any] = {
            "traceroot.span.type": "LLM",
            "traceroot.trace.session_id": call_id,
        }
        if model_name:
            llm_attrs["gen_ai.request.model"] = str(model_name)
        if model_provider:
            llm_attrs["gen_ai.system"] = str(model_provider)
        if last_user_text is not None:
            llm_attrs["traceroot.span.input"] = last_user_text
        if text is not None:
            llm_attrs["traceroot.span.output"] = _stringify(text)

        children.append(
            SpanSpec(
                name=f"llm.{model_name}" if model_name else "vapi.llm",
                span_id=llm_span_id,
                parent_span_id=root_span_id,
                start_time_ns=span_start,
                end_time_ns=span_end,
                attributes=llm_attrs,
            )
        )
        if len(children) >= _MAX_CHILD_SPANS_PER_REPORT:
            break

        for tc_idx, tc in enumerate(_extract_tool_calls(msg)):
            fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
            tool_name = str(fn.get("name") or tc.get("name") or "vapi_tool")
            tool_args = fn.get("arguments") if "arguments" in fn else tc.get("arguments")
            tc_id = tc.get("id")
            result_msg = tool_results_by_id.get(str(tc_id)) if tc_id else None
            tool_result = result_msg.get("result") if result_msg else None

            tool_start = span_end if result_msg else span_start
            if result_msg:
                tool_start = _msg_start_ns(result_msg, call_start_ns, span_start)
                res_dur = result_msg.get("duration")
                if (
                    isinstance(res_dur, (int, float))
                    and not isinstance(res_dur, bool)
                    and res_dur > 0
                ):
                    tool_end = tool_start + int(res_dur * 1_000_000)
                else:
                    tool_end = tool_start + 1_000_000
            else:
                tool_end = span_end

            tool_attrs: dict[str, Any] = {
                "traceroot.span.type": "TOOL",
                "traceroot.trace.session_id": call_id,
                "gen_ai.tool.name": tool_name,
            }
            if tool_args is not None:
                tool_attrs["gen_ai.tool.call.arguments"] = _stringify(tool_args)
            if tool_result is not None:
                tool_attrs["gen_ai.tool.call.result"] = _stringify(tool_result)

            children.append(
                SpanSpec(
                    name=tool_name,
                    span_id=_deterministic_hex(f"vapi-tool:{call_id}:{idx}:{tc_idx}", 16),
                    parent_span_id=llm_span_id,
                    start_time_ns=tool_start,
                    end_time_ns=max(tool_end, tool_start + 1_000_000),
                    attributes=tool_attrs,
                )
            )
            if len(children) >= _MAX_CHILD_SPANS_PER_REPORT:
                break
        if len(children) >= _MAX_CHILD_SPANS_PER_REPORT:
            break

    assistant_name = assistant.get("name")
    root_name = f"vapi.call ({assistant_name})" if assistant_name else "vapi.call"
    root_attrs: dict[str, Any] = {
        "traceroot.span.type": "AGENT",
        "traceroot.trace.session_id": call_id,
        "vapi.call.id": call_id,
    }
    if envelope.get("endedReason"):
        root_attrs["vapi.call.ended_reason"] = str(envelope["endedReason"])
    if assistant.get("id"):
        root_attrs["vapi.assistant.id"] = str(assistant["id"])
    if artifact.get("transcript"):
        root_attrs["traceroot.span.input"] = _stringify(artifact["transcript"])
    if analysis.get("summary"):
        root_attrs["traceroot.span.output"] = _stringify(analysis["summary"])
    elif artifact.get("transcript"):
        root_attrs["traceroot.span.output"] = _stringify(artifact["transcript"])

    env_breakdown = (
        envelope.get("costBreakdown") if isinstance(envelope.get("costBreakdown"), dict) else {}
    )
    call_breakdown = (
        call.get("costBreakdown") if isinstance(call.get("costBreakdown"), dict) else {}
    )
    call_cost = next(
        (
            val
            for val in (
                envelope.get("cost"),
                call.get("cost"),
                env_breakdown.get("total"),
                call_breakdown.get("total"),
            )
            if val is not None
        ),
        None,
    )
    if isinstance(call_cost, (int, float)) and not isinstance(call_cost, bool) and call_cost >= 0:
        root_attrs["llm.cost.total"] = float(call_cost)

    root = SpanSpec(
        name=root_name,
        span_id=root_span_id,
        parent_span_id=None,
        start_time_ns=call_start_ns,
        end_time_ns=call_end_ns,
        attributes=root_attrs,
    )
    return VapiTracePlan(trace_id=trace_id, call_id=call_id, root=root, children=children)
