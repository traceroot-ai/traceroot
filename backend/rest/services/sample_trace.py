"""A made-up agent trace a project with no traces can add, to explore the trace view."""

import hashlib
import json
from datetime import UTC, datetime, timedelta
from typing import Any

from shared.enums import SpanKind, SpanStatus
from worker.tokens.pricing import get_model_price

SAMPLE_TRACE_NAME = "sample-support-agent"
# The environment its spans carry, so dashboards and filters can leave it out.
SAMPLE_ENVIRONMENT = "sample"
SAMPLE_MODEL = "gpt-4o-mini"

_QUESTION = "Where is my order A-1042?"
_ANSWER = "Order A-1042 shipped yesterday and is due on Friday."


def _hex_id(seed: str, length: int) -> str:
    return hashlib.sha256(seed.encode()).hexdigest()[:length]


def sample_trace_id(project_id: str) -> str:
    """The one sample trace id of a project.

    Derived from the project, so adding the sample twice rewrites the same trace, and
    readers can tell it apart from the project's own traces.
    """
    return _hex_id(f"traceroot-sample-trace:{project_id}", 32)


def _cost(input_tokens: int, output_tokens: int) -> float | None:
    prices = get_model_price(SAMPLE_MODEL)
    if prices is None:
        return None
    return input_tokens * prices["input"] + output_tokens * prices["output"]


def build_sample_trace(
    project_id: str, now: datetime | None = None
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Build the sample's trace row and spans: an agent that plans, calls a tool and answers.

    Args:
        project_id (str): Project the rows belong to.
        now (datetime | None): When the sample run ends; the current time by default.

    Returns:
        tuple[dict[str, Any], list[dict[str, Any]]]: The trace record and its span
            records, as ``insert_traces_batch`` and ``insert_spans_batch`` take them.
    """
    trace_id = sample_trace_id(project_id)
    start = (now or datetime.now(UTC)) - timedelta(milliseconds=2400)
    root_id = _hex_id(f"{trace_id}:agent", 16)

    def span(
        key: str,
        name: str,
        kind: SpanKind,
        offset_ms: int,
        duration_ms: int,
        span_input: Any,
        span_output: Any,
        tokens: tuple[int, int] | None = None,
    ) -> dict[str, Any]:
        span_start = start + timedelta(milliseconds=offset_ms)
        record = {
            "span_id": root_id if key == "agent" else _hex_id(f"{trace_id}:{key}", 16),
            "trace_id": trace_id,
            "parent_span_id": None if key == "agent" else root_id,
            "project_id": project_id,
            "span_start_time": span_start,
            "span_end_time": span_start + timedelta(milliseconds=duration_ms),
            "name": name,
            "span_kind": kind.value,
            "status": SpanStatus.OK.value,
            "input": json.dumps(span_input),
            "output": json.dumps(span_output),
            "environment": SAMPLE_ENVIRONMENT,
        }
        if tokens is not None:
            input_tokens, output_tokens = tokens
            record.update(
                model_name=SAMPLE_MODEL,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                total_tokens=input_tokens + output_tokens,
                cost=_cost(input_tokens, output_tokens),
            )
        return record

    order = {"order_id": "A-1042", "status": "shipped", "due": "Friday"}
    spans = [
        span("agent", SAMPLE_TRACE_NAME, SpanKind.AGENT, 0, 2400, _QUESTION, _ANSWER),
        span(
            "plan",
            "plan",
            SpanKind.LLM,
            40,
            780,
            [{"role": "user", "content": _QUESTION}],
            {"tool": "lookup_order", "arguments": {"order_id": "A-1042"}},
            tokens=(184, 32),
        ),
        span("tool", "lookup_order", SpanKind.TOOL, 860, 420, {"order_id": "A-1042"}, order),
        span(
            "answer",
            "answer",
            SpanKind.LLM,
            1320,
            1040,
            [
                {"role": "user", "content": _QUESTION},
                {"role": "tool", "content": json.dumps(order)},
            ],
            _ANSWER,
            tokens=(263, 41),
        ),
    ]
    trace = {
        "trace_id": trace_id,
        "project_id": project_id,
        "trace_start_time": start,
        "name": SAMPLE_TRACE_NAME,
        "input": json.dumps(_QUESTION),
        "output": json.dumps(_ANSWER),
        "environment": SAMPLE_ENVIRONMENT,
    }
    return trace, spans
