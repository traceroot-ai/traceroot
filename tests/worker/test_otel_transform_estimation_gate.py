"""Regression tests: text-based token estimation only applies to LLM-kind spans.

Wrapper spans (AGENT/CHAIN/TOOL kinds) can carry a model name and the conversation
text without token counts — e.g. the Vercel AI SDK's `ai.generateText` wrapper, which
the openinference-vercel mapping stamps with `llm.model_name` + `input.value` /
`output.value` while the real usage is reported only on the `doGenerate` LLM children.
Estimating tokens from a wrapper's text fabricates a duplicate of usage its LLM
children already report, silently doubling per-trace token totals and cost.

The estimation fallback must therefore fire only for spans classified as LLM.
API-provided token counts are unaffected: they are trusted on any span kind, because
some instrumentors legitimately report usage at the wrapper level.

Estimation tests use Claude model names: their token estimate is a deterministic,
offline `len(text) // 4`, so the tests never depend on tiktoken downloads or pricing DB.
"""

from unittest.mock import patch

from tests.fixtures.otel_payloads import make_attr, make_otel_payload, make_span
from worker.otel_transform import transform_otel_to_clickhouse

TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
MODEL = "claude-sonnet-4-20250514"
# Long enough that len(text) // 4 is comfortably non-zero.
INPUT_TEXT = "What is the weather in Tokyo and San Francisco today? " * 10
OUTPUT_TEXT = "The weather in Tokyo is sunny and San Francisco is foggy. " * 10


def _span_with(attrs: list[dict], span_id: str = "00f067aa0ba902b7", name: str = "span"):
    return make_span(TRACE_ID, span_id, name=name, attributes=attrs)


def _transform(spans: list[dict], scope_name: str = "openinference.instrumentation.test"):
    _, out = transform_otel_to_clickhouse(
        make_otel_payload(spans, scope_name=scope_name), project_id="proj-1"
    )
    return out


def _model_and_text(kind_attr: list[dict]) -> list[dict]:
    """Model name + I/O text, NO token-count attributes — the estimation bait."""
    return [
        *kind_attr,
        make_attr("llm.model_name", MODEL),
        make_attr("input.value", INPUT_TEXT),
        make_attr("output.value", OUTPUT_TEXT),
    ]


def _assert_no_fabricated_tokens(span: dict):
    assert span.get("input_tokens") is None, f"fabricated input_tokens: {span.get('input_tokens')}"
    assert span.get("output_tokens") is None, (
        f"fabricated output_tokens: {span.get('output_tokens')}"
    )
    assert span.get("total_tokens") is None, f"fabricated total_tokens: {span.get('total_tokens')}"
    assert span.get("cost") is None, f"fabricated cost: {span.get('cost')}"


def _assert_estimated_tokens(span: dict):
    assert span.get("input_tokens"), "expected text-estimated input_tokens"
    assert span.get("output_tokens"), "expected text-estimated output_tokens"
    assert span.get("total_tokens") == span["input_tokens"] + span["output_tokens"]


# ---------------------------------------------------------------------------
# Wrapper kinds must NOT be estimated
# ---------------------------------------------------------------------------


def test_agent_wrapper_span_gets_no_estimated_tokens():
    """The Vercel ai.generateText shape: AGENT kind + model + text, no counts."""
    spans = _transform(
        [_span_with(_model_and_text([make_attr("openinference.span.kind", "AGENT")]))]
    )
    _assert_no_fabricated_tokens(spans[0])
    assert spans[0]["span_kind"] == "AGENT"
    # The model name itself is still recorded — only counts are withheld.
    assert spans[0]["model_name"] == MODEL


def test_chain_wrapper_span_gets_no_estimated_tokens():
    spans = _transform(
        [_span_with(_model_and_text([make_attr("openinference.span.kind", "CHAIN")]))]
    )
    _assert_no_fabricated_tokens(spans[0])


def test_tool_span_with_model_gets_no_estimated_tokens():
    spans = _transform(
        [_span_with(_model_and_text([make_attr("openinference.span.kind", "TOOL")]))]
    )
    _assert_no_fabricated_tokens(spans[0])


def test_explicit_traceroot_agent_type_gets_no_estimated_tokens():
    """Explicit traceroot.span.type wins over everything, including the model-attr
    fallback that would otherwise classify a modeled span as LLM."""
    spans = _transform([_span_with(_model_and_text([make_attr("traceroot.span.type", "agent")]))])
    _assert_no_fabricated_tokens(spans[0])


# ---------------------------------------------------------------------------
# LLM-kind spans must KEEP estimation (no over-gating)
# ---------------------------------------------------------------------------


def test_llm_kind_span_still_gets_estimated_tokens():
    spans = _transform([_span_with(_model_and_text([make_attr("openinference.span.kind", "LLM")]))])
    _assert_estimated_tokens(spans[0])


def test_explicit_traceroot_llm_type_still_gets_estimated_tokens():
    """A user can explicitly opt a span into LLM kind; estimation must honor that."""
    spans = _transform([_span_with(_model_and_text([make_attr("traceroot.span.type", "llm")]))])
    _assert_estimated_tokens(spans[0])


def test_bare_model_attrs_without_kind_still_get_estimated_tokens():
    """Emitters that mark nothing: a span with model attrs and no explicit kind is
    classified LLM by the kind fallback, so estimation must still apply. Guards
    against the gate regressing sparse/unmarked emitters."""
    spans = _transform([_span_with(_model_and_text([]))])
    assert spans[0]["span_kind"] == "LLM"
    _assert_estimated_tokens(spans[0])


def test_genai_chat_operation_still_gets_estimated_tokens():
    """gen_ai.operation.name=chat classifies as LLM (GenAI semconv emitters)."""
    spans = _transform([_span_with(_model_and_text([make_attr("gen_ai.operation.name", "chat")]))])
    _assert_estimated_tokens(spans[0])


# ---------------------------------------------------------------------------
# API-provided counts are trusted on ANY span kind (the gate must not touch them)
# ---------------------------------------------------------------------------


def test_agent_span_with_api_counts_keeps_them():
    """Some instrumentors report real usage at the wrapper level; API-provided
    counts must survive on non-LLM spans — only ESTIMATION is gated."""
    spans = _transform(
        [
            _span_with(
                [
                    make_attr("openinference.span.kind", "AGENT"),
                    make_attr("llm.model_name", MODEL),
                    make_attr("llm.token_count.prompt", 120),
                    make_attr("llm.token_count.completion", 45),
                ]
            )
        ]
    )
    assert spans[0]["span_kind"] == "AGENT"
    assert spans[0]["input_tokens"] == 120
    assert spans[0]["output_tokens"] == 45
    assert spans[0]["total_tokens"] == 165


def test_agent_span_with_api_counts_still_gets_cost():
    mock_prices = {"input": 0.000003, "output": 0.000015}
    with patch("worker.tokens.pricing.get_model_price", return_value=mock_prices):
        spans = _transform(
            [
                _span_with(
                    [
                        make_attr("openinference.span.kind", "AGENT"),
                        make_attr("llm.model_name", MODEL),
                        make_attr("llm.token_count.prompt", 1000),
                        make_attr("llm.token_count.completion", 100),
                    ]
                )
            ]
        )
    assert spans[0]["cost"] is not None and spans[0]["cost"] > 0


# ---------------------------------------------------------------------------
# Full Vercel-shaped trace: totals must come from LLM spans only
# ---------------------------------------------------------------------------


def test_vercel_shaped_trace_totals_count_llm_spans_only():
    """End-to-end regression for the observed staging bug: a generateText call
    emits a wrapper AGENT span (model + full conversation text, no counts) plus
    LLM children with real usage and a tool span. The wrapper must contribute
    nothing, so summing total_tokens across the trace equals the real usage."""
    wrapper = make_span(
        TRACE_ID,
        "00f067aa0ba902b1",
        name="ai.generateText",
        attributes=_model_and_text([make_attr("openinference.span.kind", "AGENT")]),
    )
    llm_1 = make_span(
        TRACE_ID,
        "00f067aa0ba902b2",
        name="ai.generateText.doGenerate",
        parent_span_id_hex="00f067aa0ba902b1",
        attributes=[
            make_attr("openinference.span.kind", "LLM"),
            make_attr("llm.model_name", MODEL),
            make_attr("llm.token_count.prompt", 64),
            make_attr("llm.token_count.completion", 14),
        ],
    )
    tool = make_span(
        TRACE_ID,
        "00f067aa0ba902b3",
        name="ai.toolCall",
        parent_span_id_hex="00f067aa0ba902b1",
        attributes=[make_attr("openinference.span.kind", "TOOL")],
    )
    llm_2 = make_span(
        TRACE_ID,
        "00f067aa0ba902b4",
        name="ai.generateText.doGenerate",
        parent_span_id_hex="00f067aa0ba902b1",
        attributes=[
            make_attr("openinference.span.kind", "LLM"),
            make_attr("llm.model_name", MODEL),
            make_attr("llm.token_count.prompt", 100),
            make_attr("llm.token_count.completion", 16),
        ],
    )

    spans = _transform([wrapper, llm_1, tool, llm_2])
    by_name = {}
    for s in spans:
        by_name.setdefault(s["name"], []).append(s)

    _assert_no_fabricated_tokens(by_name["ai.generateText"][0])
    _assert_no_fabricated_tokens(by_name["ai.toolCall"][0])

    trace_total = sum(s.get("total_tokens") or 0 for s in spans)
    assert trace_total == (64 + 14) + (100 + 16), (
        f"trace total {trace_total} must equal the real LLM usage only"
    )


# ---------------------------------------------------------------------------
# Interplay with the scope-based skip: the python claude-agent-sdk instrumentor
# aggregates usage onto result-bearing spans and deliberately leaves its other LLM
# spans without counts, so its scope is excluded from estimation entirely. The kind
# gate must not replace that skip, and the skip must stay python-scope-only.
# ---------------------------------------------------------------------------


def test_claude_agent_sdk_python_scope_llm_span_still_skipped():
    """The scope skip-list protects deliberately-blank LLM spans; the kind gate
    must not replace it (those spans ARE LLM-kind)."""
    spans = _transform(
        [_span_with(_model_and_text([make_attr("openinference.span.kind", "LLM")]))],
        scope_name="traceroot.claude-agent-sdk",
    )
    _assert_no_fabricated_tokens(spans[0])


def test_claude_agent_sdk_typescript_scope_llm_span_still_estimated():
    """The skip is python-only; the TS scope must keep estimation on LLM spans."""
    spans = _transform(
        [_span_with(_model_and_text([make_attr("openinference.span.kind", "LLM")]))],
        scope_name="@traceroot-ai/claude-agent-sdk",
    )
    _assert_estimated_tokens(spans[0])
