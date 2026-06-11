"""Tests for skipping text-based token estimation in otel_transform.

The in-house claude-agent-sdk (python) instrumentor deliberately leaves intermediate
LLM spans without token counts (the authoritative usage is aggregated onto the
result-bearing spans). The platform must NOT fabricate text-based token estimates for
those spans, or the trace stops looking sparse and the per-trace tokens/cost inflate.
The skip is python-only; the TypeScript instrumentor reports real per-turn usage and
must be unaffected.
"""

import base64

from worker.otel_transform import transform_otel_to_clickhouse

CLAUDE_AGENT_SDK_SCOPE = "traceroot.claude-agent-sdk"  # python in-house instrumentor (skipped)
CLAUDE_AGENT_SDK_TS_SCOPE = "@traceroot-ai/claude-agent-sdk"  # TypeScript (must NOT be skipped)
OTHER_SCOPE = "openinference.instrumentation.anthropic"


def _b64(byte: int, n: int) -> str:
    return base64.b64encode(bytes([byte] * n)).decode()


def _payload(scope_name: str) -> dict:
    """One LLM span: has a model name + output text, but NO token-count attributes."""
    return {
        "resourceSpans": [
            {
                "scopeSpans": [
                    {
                        "scope": {"name": scope_name},
                        "spans": [
                            {
                                "traceId": _b64(0x01, 16),
                                "spanId": _b64(0x02, 8),
                                "name": "anthropic.messages.create",
                                "startTimeUnixNano": "1700000000000000000",
                                "endTimeUnixNano": "1700000001000000000",
                                "attributes": [
                                    {
                                        "key": "openinference.span.kind",
                                        "value": {"stringValue": "LLM"},
                                    },
                                    {
                                        "key": "llm.model_name",
                                        "value": {"stringValue": "claude-sonnet-4-20250514"},
                                    },
                                    {
                                        "key": "output.value",
                                        "value": {
                                            "stringValue": "This is a fairly long assistant turn "
                                            * 20
                                        },
                                    },
                                    # NOTE: intentionally NO llm.token_count.* attributes.
                                ],
                                "status": {"code": "STATUS_CODE_OK"},
                            }
                        ],
                    }
                ]
            }
        ]
    }


def _llm_span(scope_name: str) -> dict:
    _, spans = transform_otel_to_clickhouse(_payload(scope_name), project_id="proj-1")
    llm = [s for s in spans if s["name"] == "anthropic.messages.create"]
    assert len(llm) == 1
    return llm[0]


def test_claude_agent_sdk_python_llm_span_gets_no_estimated_tokens():
    span = _llm_span(CLAUDE_AGENT_SDK_SCOPE)
    assert span.get("output_tokens") in (None, 0), span.get("output_tokens")
    assert span.get("input_tokens") in (None, 0), span.get("input_tokens")
    assert span.get("cost") in (None, 0), span.get("cost")


def test_other_scope_llm_span_still_gets_estimated_tokens():
    """Control: a non-claude-agent-sdk scope with the same shape DOES get text-based
    estimation, so the change is narrowly scoped."""
    span = _llm_span(OTHER_SCOPE)
    assert span.get("output_tokens"), "expected text-estimated output_tokens for other scopes"
    assert span.get("cost"), "expected text-estimated cost for other scopes"


def test_claude_agent_sdk_typescript_is_not_skipped():
    """The skip is PYTHON ONLY. The TS integration uses a different scope and reports
    real per-turn usage, so it must keep getting estimation when a count is missing."""
    span = _llm_span(CLAUDE_AGENT_SDK_TS_SCOPE)
    assert span.get("output_tokens"), "TS claude-agent-sdk must NOT be skipped (python-only)"
    assert span.get("cost"), "TS claude-agent-sdk must NOT be skipped (python-only)"
