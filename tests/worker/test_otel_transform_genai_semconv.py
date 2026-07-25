"""Regression tests for Vercel AI SDK v7 GenAI semconv telemetry.

The v7 ``@ai-sdk/otel`` emitter (instrumentation scope ``"gen_ai"``) stamps
aggregate ``gen_ai.usage.*`` attributes on BOTH the operation root span (AGENT)
and its inference children (LLM). The root span's counts restate the sum of its
LLM children. Extracting and pricing both produces 2x token totals and cost.

The fix: when scope is ``"gen_ai"`` and the span kind is not LLM, skip token
extraction entirely (model name is still recorded). Only LLM-kind children carry
real per-call usage and must keep working.

This is the ``"gen_ai"``-scope analogue of the ``"ai"``-scope guard (#1187).
"""

from unittest.mock import patch

from tests.fixtures.otel_payloads import make_attr, make_otel_payload, make_span
from worker.otel_transform import transform_otel_to_clickhouse

TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
MODEL = "claude-sonnet-4-20250514"


def _span_with(
    attrs: list[dict], span_id: str = "00f067aa0ba902b7", name: str = "span"
):
    return make_span(TRACE_ID, span_id, name=name, attributes=attrs)


def _transform(spans: list[dict], scope_name: str = "gen_ai"):
    _, out = transform_otel_to_clickhouse(
        make_otel_payload(spans, scope_name=scope_name), project_id="proj-1"
    )
    return out


def _token_attrs() -> list[dict]:
    return [
        make_attr("gen_ai.usage.input_tokens", 100),
        make_attr("gen_ai.usage.output_tokens", 50),
    ]


def _assert_no_tokens(span: dict, label: str):
    assert span.get("input_tokens") is None, (
        f"{label}: expected no input_tokens, got {span.get('input_tokens')}"
    )
    assert span.get("output_tokens") is None, (
        f"{label}: expected no output_tokens, got {span.get('output_tokens')}"
    )
    assert span.get("total_tokens") is None, (
        f"{label}: expected no total_tokens, got {span.get('total_tokens')}"
    )
    # Model name MUST still be recorded
    assert span.get("model_name") == MODEL, (
        f"{label}: model_name should survive, got {span.get('model_name')}"
    )


# ---------------------------------------------------------------------------
# Non-LLM spans with gen_ai scope must skip token extraction
# ---------------------------------------------------------------------------


def test_gen_ai_agent_span_skips_tokens():
    spans = _transform(
        [
            _span_with(
                [
                    make_attr("openinference.span.kind", "AGENT"),
                    make_attr("gen_ai.request.model", MODEL),
                    *_token_attrs(),
                ]
            )
        ]
    )
    _assert_no_tokens(spans[0], "AGENT span with gen_ai scope")


def test_gen_ai_chain_span_skips_tokens():
    spans = _transform(
        [
            _span_with(
                [
                    make_attr("openinference.span.kind", "CHAIN"),
                    make_attr("gen_ai.request.model", MODEL),
                    *_token_attrs(),
                ]
            )
        ]
    )
    _assert_no_tokens(spans[0], "CHAIN span with gen_ai scope")


def test_gen_ai_tool_span_skips_tokens():
    spans = _transform(
        [
            _span_with(
                [
                    make_attr("openinference.span.kind", "TOOL"),
                    make_attr("gen_ai.request.model", MODEL),
                    *_token_attrs(),
                ]
            )
        ]
    )
    _assert_no_tokens(spans[0], "TOOL span with gen_ai scope")


# ---------------------------------------------------------------------------
# LLM-kind spans with gen_ai scope MUST keep extracting tokens
# ---------------------------------------------------------------------------


def test_gen_ai_llm_span_extracts_tokens():
    spans = _transform(
        [
            _span_with(
                [
                    make_attr("openinference.span.kind", "LLM"),
                    make_attr("gen_ai.request.model", MODEL),
                    *_token_attrs(),
                ]
            )
        ]
    )
    assert spans[0]["input_tokens"] == 100
    assert spans[0]["output_tokens"] == 50
    assert spans[0]["total_tokens"] == 150
    assert spans[0]["model_name"] == MODEL


def test_gen_ai_llm_span_cache_details_persist():
    """LLM span with gen_ai scope: cache and reasoning details in usage_details."""
    with patch("worker.tokens.pricing.get_model_price") as mock_price:
        mock_price.return_value = {
            "input": 0.000003,
            "output": 0.000015,
            "cacheRead": 0.0000003,
            "cacheWrite": 0.00000375,
        }
        spans = _transform(
            [
                _span_with(
                    [
                        make_attr("openinference.span.kind", "LLM"),
                        make_attr("gen_ai.request.model", "claude-sonnet-4-5"),
                        make_attr("gen_ai.usage.input_tokens", 28466),
                        make_attr("gen_ai.usage.output_tokens", 120),
                        make_attr("gen_ai.usage.cache_read.input_tokens", 22041),
                        make_attr("gen_ai.usage.cache_creation.input_tokens", 6422),
                    ]
                )
            ]
        )
    assert spans[0]["input_tokens"] == 28466
    assert spans[0]["output_tokens"] == 120
    assert spans[0]["usage_details"]["cache_read_tokens"] == 22041
    assert spans[0]["usage_details"]["cache_write_tokens"] == 6422


# ---------------------------------------------------------------------------
# Full trace: totals must come from LLM spans only
# ---------------------------------------------------------------------------


def test_gen_ai_full_trace_totals_from_llm_spans_only():
    """End-to-end: a Vercel v7 trace with AGENT root + LLM children + tool.
    The root and tool must contribute zero tokens; trace total equals children."""
    root = make_span(
        TRACE_ID,
        "00f067aa0ba902b1",
        name="chat",
        attributes=[
            make_attr("openinference.span.kind", "AGENT"),
            make_attr("gen_ai.request.model", MODEL),
            *_token_attrs(),
        ],
    )
    child_1 = make_span(
        TRACE_ID,
        "00f067aa0ba902b2",
        name="chat claude-haiku-4-5-20251001",
        parent_span_id_hex="00f067aa0ba902b1",
        attributes=[
            make_attr("openinference.span.kind", "LLM"),
            make_attr("gen_ai.request.model", MODEL),
            make_attr("gen_ai.usage.input_tokens", 64),
            make_attr("gen_ai.usage.output_tokens", 14),
        ],
    )
    child_2 = make_span(
        TRACE_ID,
        "00f067aa0ba902b3",
        name="chat claude-sonnet-4-5-20251001",
        parent_span_id_hex="00f067aa0ba902b1",
        attributes=[
            make_attr("openinference.span.kind", "LLM"),
            make_attr("gen_ai.request.model", MODEL),
            make_attr("gen_ai.usage.input_tokens", 100),
            make_attr("gen_ai.usage.output_tokens", 16),
        ],
    )
    tool = make_span(
        TRACE_ID,
        "00f067aa0ba902b4",
        name="execute_tool",
        parent_span_id_hex="00f067aa0ba902b1",
        attributes=[
            make_attr("openinference.span.kind", "TOOL"),
            make_attr("gen_ai.request.model", MODEL),
            *_token_attrs(),
        ],
    )

    spans = _transform([root, child_1, child_2, tool])
    by_name = {}
    for s in spans:
        by_name.setdefault(s["name"], []).append(s)

    _assert_no_tokens(by_name["chat"][0], "root span")
    _assert_no_tokens(by_name["execute_tool"][0], "tool span")

    assert by_name["chat claude-haiku-4-5-20251001"][0]["input_tokens"] == 64
    assert by_name["chat claude-sonnet-4-5-20251001"][0]["input_tokens"] == 100

    trace_total = sum(s.get("total_tokens") or 0 for s in spans)
    expected = (64 + 14) + (100 + 16)
    assert trace_total == expected, (
        f"trace total {trace_total} must equal real LLM usage {expected}"
    )


# ---------------------------------------------------------------------------
# Other scopes must be unaffected
# ---------------------------------------------------------------------------


def test_openinference_scope_agent_keeps_tokens():
    """openinference instrumentors legitimately report on AGENT spans."""
    spans = _transform(
        [
            _span_with(
                [
                    make_attr("openinference.span.kind", "AGENT"),
                    make_attr("gen_ai.request.model", MODEL),
                    *_token_attrs(),
                ]
            )
        ],
        scope_name="openinference.instrumentation.test",
    )
    assert spans[0]["input_tokens"] == 100
    assert spans[0]["output_tokens"] == 50


def test_legacy_ai_scope_agent_keeps_tokens():
    """Legacy Vercel AI SDK (scope 'ai') has its own guard (#1187)."""
    spans = _transform(
        [
            _span_with(
                [
                    make_attr("openinference.span.kind", "AGENT"),
                    make_attr("gen_ai.request.model", MODEL),
                    *_token_attrs(),
                ]
            )
        ],
        scope_name="ai",
    )
    assert spans[0]["input_tokens"] == 100
    assert spans[0]["output_tokens"] == 50


# ---------------------------------------------------------------------------
# Edge: no token attrs at all — must not crash, no tokens extracted
# ---------------------------------------------------------------------------


def test_gen_ai_span_without_token_attrs_no_crash():
    """LLM span with no token attrs falls back to text estimation (0 for empty text)."""
    spans = _transform(
        [
            _span_with(
                [
                    make_attr("openinference.span.kind", "LLM"),
                    make_attr("gen_ai.request.model", MODEL),
                ]
            )
        ]
    )
    # Text estimation on empty text produces 0 tokens — no crash, no error
    assert spans[0]["input_tokens"] == 0
    assert spans[0]["output_tokens"] == 0
    assert spans[0]["model_name"] == MODEL


# ---------------------------------------------------------------------------
# Embeddings: both root and leaf classify as LLM kind, so our guard does not
# fire. They keep today's double-counted behavior (separate follow-up).
# ---------------------------------------------------------------------------


def test_gen_ai_embeddings_span_extracts_tokens():
    """Embeddings spans classify as LLM-kind — tokens extracted (unchanged)."""
    spans = _transform(
        [
            _span_with(
                [
                    make_attr("gen_ai.operation.name", "embeddings"),
                    make_attr("gen_ai.request.model", MODEL),
                    *_token_attrs(),
                ]
            )
        ]
    )
    assert spans[0]["input_tokens"] == 100
    assert spans[0]["output_tokens"] == 50
