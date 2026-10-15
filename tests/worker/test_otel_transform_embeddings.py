"""Embedding accounting regressions for legacy Vercel and GenAI emitters.

Fixtures mirror ai@7.0.141 / @ai-sdk/otel@1.0.141 captures, before and after
enrichment by OpenInference's Vercel instrumentation. Only provider calls own usage;
the operation wrapper restates the sum and may arrive in a different batch.
"""

import json
from unittest.mock import Mock

import pytest

from tests.fixtures.otel_payloads import make_attr, make_otel_payload, make_span
from worker.otel_transform import transform_otel_to_clickhouse

TRACE_ID = "aa" * 16
WRAPPER_ID = "bb" * 8
MODEL = "text-embedding-3-small"
# Test-only configured price, not a guarantee of an entry in the stock catalog.
INPUT_PRICE = 0.00000002


@pytest.fixture(autouse=True)
def embedding_prices(monkeypatch):
    monkeypatch.setattr(
        "worker.tokens.pricing.get_model_price", lambda model: {"input": INPUT_PRICE}
    )


@pytest.fixture
def text_estimate(monkeypatch):
    # Deterministic estimation bait: no tokenizer downloads or pricing DB access.
    estimate = Mock(
        return_value={
            "input_tokens": 14,
            "output_tokens": 10_496,
            "total_tokens": 10_510,
            "cost": 0.01,
        }
    )
    monkeypatch.setattr("worker.tokens.calculate_cost", estimate)
    return estimate


def _legacy_span(operation, span_id, tokens, *, enriched=True, parent=None, extra=()):
    provider_call = operation.endswith(".doEmbed")
    attrs = [
        make_attr("operation.name", operation),
        make_attr("ai.operationId", operation),
        make_attr("ai.model.id", MODEL),
        make_attr("ai.usage.tokens", tokens),
    ]
    if enriched:
        attrs += [
            make_attr("openinference.span.kind", "EMBEDDING" if provider_call else "CHAIN"),
            make_attr("embedding.model_name" if provider_call else "llm.model_name", MODEL),
        ]
    return make_span(
        TRACE_ID, span_id, name=operation, parent_span_id_hex=parent, attributes=[*attrs, *extra]
    )


def _transform(spans, scope="ai"):
    return transform_otel_to_clickhouse(make_otel_payload(spans, scope_name=scope), "proj-1")[1]


@pytest.mark.parametrize("operation,counts", [("ai.embed", [14]), ("ai.embedMany", [28, 14])])
@pytest.mark.parametrize("enriched", [False, True], ids=["raw", "openinference"])
@pytest.mark.parametrize("scope", ["ai", "custom-tracer"])
@pytest.mark.parametrize("batches", ["together", "children-first", "wrapper-first"])
def test_legacy_embedding_usage_is_counted_once(operation, counts, enriched, scope, batches):
    wrapper = _legacy_span(operation, WRAPPER_ID, sum(counts), enriched=enriched)
    children = [
        _legacy_span(
            operation + ".doEmbed", f"{i + 1:016x}", count, enriched=enriched, parent=WRAPPER_ID
        )
        for i, count in enumerate(counts)
    ]
    if batches == "together":
        rows = _transform([wrapper, *children], scope)
    else:
        ordered = [*children, wrapper] if batches == "children-first" else [wrapper, *children]
        rows = [row for span in ordered for row in _transform([span], scope)]

    by_id = {row["span_id"]: row for row in rows}
    assert len(rows) == len(children) + 1
    assert by_id[WRAPPER_ID].get("input_tokens") is None
    assert by_id[WRAPPER_ID].get("cost") is None
    for i, count in enumerate(counts):
        child = by_id[f"{i + 1:016x}"]
        assert child["span_kind"] == "LLM"
        assert child["model_name"] == MODEL
        assert child["parent_span_id"] == WRAPPER_ID
        assert child["input_tokens"] == count
        assert child["output_tokens"] == 0
        assert child["total_tokens"] == count
        assert child["cost"] == pytest.approx(count * INPUT_PRICE)
    assert sum(row.get("input_tokens") or 0 for row in rows) == sum(counts)
    assert sum(row.get("cost") or 0 for row in rows) == pytest.approx(sum(counts) * INPUT_PRICE)


def test_equal_independent_embedding_calls_are_both_priced():
    rows = _transform([_legacy_span("ai.embed.doEmbed", f"{i:016x}", 14) for i in (1, 2)])
    assert [row["input_tokens"] for row in rows] == [14, 14]
    assert sum(row["cost"] for row in rows) == pytest.approx(28 * INPUT_PRICE)


@pytest.mark.parametrize("tokens", [0, "14"])
def test_legacy_embedding_zero_and_numeric_string_usage(tokens):
    row = _transform([_legacy_span("ai.embed.doEmbed", "01" * 8, tokens)])[0]
    assert row["input_tokens"] == int(tokens)


@pytest.mark.parametrize("tokens", [True, -1, 10**9 + 1, "bad", "", float("nan"), float("inf")])
def test_invalid_legacy_embedding_usage_is_not_priced(tokens):
    row = _transform([_legacy_span("ai.embed.doEmbed", "01" * 8, tokens)])[0]
    assert not row.get("input_tokens")
    assert not row.get("cost")


@pytest.mark.parametrize("key", ["llm.token_count.prompt", "gen_ai.usage.input_tokens"])
@pytest.mark.parametrize("tokens", [0, 14])
def test_normalized_embedding_usage_takes_priority(key, tokens):
    row = _transform(
        [_legacy_span("ai.embed.doEmbed", "01" * 8, 999, extra=[make_attr(key, tokens)])]
    )[0]
    assert row["input_tokens"] == tokens


def test_invalid_normalized_embedding_usage_falls_back_to_reported_legacy_usage():
    row = _transform(
        [
            _legacy_span(
                "ai.embed.doEmbed", "01" * 8, 14, extra=[make_attr("llm.token_count.prompt", "bad")]
            )
        ]
    )[0]
    assert row["input_tokens"] == 14


def test_normalized_openinference_embedding_without_legacy_operation_is_priced():
    row = _transform(
        [
            make_span(
                TRACE_ID,
                "01" * 8,
                attributes=[
                    make_attr("openinference.span.kind", "EMBEDDING"),
                    make_attr("embedding.model_name", MODEL),
                    make_attr("llm.token_count.prompt", 14),
                ],
            )
        ]
    )[0]
    assert row["span_kind"] == "LLM"
    assert row["model_name"] == MODEL
    assert row["input_tokens"] == 14
    assert row["cost"] == pytest.approx(14 * INPUT_PRICE)


def test_explicit_span_kind_takes_priority_over_embedding_inference():
    row = _transform(
        [
            _legacy_span(
                "ai.embed.doEmbed", "01" * 8, 14, extra=[make_attr("traceroot.span.type", "tool")]
            )
        ]
    )[0]
    assert row["span_kind"] == "TOOL"
    assert row.get("input_tokens") is None


def test_legacy_embedding_usage_takes_priority_over_manual_usage():
    row = _transform(
        [
            _legacy_span(
                "ai.embed.doEmbed",
                "01" * 8,
                14,
                extra=[make_attr("traceroot.llm.usage", json.dumps({"input_tokens": 999}))],
            )
        ]
    )[0]
    assert row["input_tokens"] == 14


def test_embedding_model_is_a_fallback_and_vector_attributes_are_preserved():
    row = _transform(
        [
            _legacy_span(
                "ai.embed.doEmbed",
                "01" * 8,
                14,
                extra=[
                    make_attr("traceroot.llm.model", "custom-embedding-model"),
                    make_attr("embedding.embeddings.0.embedding.vector", "[0.1,0.2]"),
                ],
            )
        ]
    )[0]
    assert row["model_name"] == "custom-embedding-model"
    assert "embedding.embeddings.0.embedding.vector" in json.loads(row["metadata"])


def test_embedding_usage_survives_unknown_pricing(monkeypatch):
    monkeypatch.setattr("worker.tokens.pricing.get_model_price", lambda model: None)
    row = _transform([_legacy_span("ai.embed.doEmbed", "01" * 8, 14)])[0]
    assert row["input_tokens"] == 14
    assert row.get("cost") is None


@pytest.mark.parametrize("operation", ["ai.embed.doEmbed", "ai.embedMany.doEmbed"])
def test_legacy_operation_name_with_function_id_identifies_provider_call(operation):
    row = _transform(
        [
            make_span(
                TRACE_ID,
                "01" * 8,
                attributes=[
                    make_attr("operation.name", operation + " my-function"),
                    make_attr("ai.model.id", MODEL),
                    make_attr("ai.usage.tokens", 14),
                ],
            )
        ]
    )[0]
    assert row["input_tokens"] == 14


@pytest.mark.parametrize("operation", ["ai.embed", "ai.embedMany", "ai.generateText.doGenerate"])
def test_other_legacy_operations_do_not_adopt_embedding_token_alias(operation):
    row = _transform(
        [
            _legacy_span(
                operation,
                "01" * 8,
                999,
                extra=[make_attr("traceroot.span.type", "llm"), make_attr("llm.model_name", MODEL)],
            )
        ]
    )[0]
    assert not row.get("input_tokens")


def test_errored_embedding_without_usage_does_not_estimate_prompt():
    span = _legacy_span(
        "ai.embed.doEmbed", "01" * 8, "", extra=[make_attr("input.value", "prompt " * 100)]
    )
    span["status"] = {"code": 2}
    row = _transform([span])[0]
    assert row.get("input_tokens") is None
    assert row.get("cost") is None


def test_current_semconv_embeddings_remain_billable_without_legacy_attributes():
    def span(span_id, tokens=None, parent=None):
        attrs = [
            make_attr("gen_ai.operation.name", "embeddings"),
            make_attr("gen_ai.request.model", MODEL),
        ]
        if tokens is not None:
            attrs.append(make_attr("gen_ai.usage.input_tokens", tokens))
        return make_span(TRACE_ID, span_id, parent_span_id_hex=parent, attributes=attrs)

    rows = _transform([span(WRAPPER_ID), span("01" * 8, 14, WRAPPER_ID)], "gen_ai")
    assert sum(row.get("input_tokens") or 0 for row in rows) == 14
    assert _transform([span("02" * 8, 14)], "custom-tracer")[0]["input_tokens"] == 14


@pytest.mark.parametrize(
    "markers",
    [
        [("openinference.span.kind", "EMBEDDING"), ("embedding.model_name", MODEL)],
        [("gen_ai.operation.name", "embeddings"), ("gen_ai.request.model", MODEL)],
        [("ai.operationId", "ai.embed.doEmbed"), ("ai.model.id", MODEL)],
        [("operation.name", "ai.embedMany.doEmbed my-function"), ("ai.model.id", MODEL)],
    ],
    ids=["openinference", "genai", "legacy-embed", "legacy-embed-many"],
)
@pytest.mark.parametrize("usage", [None, "invalid", -1], ids=["missing", "invalid", "negative"])
def test_embedding_without_valid_usage_does_not_estimate_text_or_vectors(
    markers, usage, text_estimate
):
    vector = json.dumps([0.123456] * 1536)
    attrs = [
        *(make_attr(key, value) for key, value in markers),
        make_attr("input.value", json.dumps(["Text to embed " * 30])),
        make_attr("output.value", vector),
    ]
    if usage is not None:
        attrs.append(make_attr("llm.token_count.prompt", usage))
    row = _transform([make_span(TRACE_ID, "01" * 8, attributes=attrs)])[0]

    assert row["span_kind"] == "LLM"
    assert row["model_name"] == MODEL
    assert row["output"] == vector
    for field in ("input_tokens", "output_tokens", "total_tokens", "cost"):
        assert row.get(field) is None, f"fabricated {field}: {row.get(field)}"
    text_estimate.assert_not_called()


@pytest.mark.parametrize("batches", ["together", "parent-first", "child-first"])
def test_llamaindex_embedding_parent_does_not_duplicate_openai_child_usage(batches, text_estimate):
    parent = make_span(
        TRACE_ID,
        WRAPPER_ID,
        name="get_text_embedding",
        attributes=[
            make_attr("openinference.span.kind", "EMBEDDING"),
            make_attr("embedding.model_name", MODEL),
            make_attr("input.value", json.dumps({"texts": ["Text to embed " * 30]})),
        ],
    )
    child = make_span(
        TRACE_ID,
        "01" * 8,
        name="Embeddings",
        parent_span_id_hex=WRAPPER_ID,
        attributes=[
            make_attr("openinference.span.kind", "EMBEDDING"),
            make_attr("embedding.model_name", MODEL),
            make_attr("llm.token_count.prompt", 14),
            make_attr("output.value", json.dumps([0.123456] * 1536)),
        ],
    )
    parent_payload = make_otel_payload(
        [parent], scope_name="openinference.instrumentation.llama_index"
    )
    child_payload = make_otel_payload([child], scope_name="openinference.instrumentation.openai")
    if batches == "together":
        parent_payload["resourceSpans"][0]["scopeSpans"].extend(
            child_payload["resourceSpans"][0]["scopeSpans"]
        )
        payloads = [parent_payload]
    else:
        payloads = (
            [parent_payload, child_payload]
            if batches == "parent-first"
            else [child_payload, parent_payload]
        )
    rows = [
        row for payload in payloads for row in transform_otel_to_clickhouse(payload, "proj-1")[1]
    ]
    by_id = {row["span_id"]: row for row in rows}
    for field in ("input_tokens", "output_tokens", "total_tokens", "cost"):
        assert by_id[WRAPPER_ID].get(field) is None
    assert by_id["01" * 8]["input_tokens"] == 14
    assert by_id["01" * 8]["output_tokens"] == 0
    assert by_id["01" * 8]["parent_span_id"] == WRAPPER_ID
    assert sum(row.get("total_tokens") or 0 for row in rows) == 14
    assert sum(row.get("cost") or 0 for row in rows) == pytest.approx(14 * INPUT_PRICE)
    text_estimate.assert_not_called()


def test_reported_manual_embedding_usage_is_preserved(text_estimate):
    row = _transform(
        [
            make_span(
                TRACE_ID,
                "01" * 8,
                attributes=[
                    make_attr("openinference.span.kind", "EMBEDDING"),
                    make_attr("embedding.model_name", MODEL),
                    make_attr("traceroot.llm.usage", json.dumps({"input_tokens": 14})),
                ],
            )
        ]
    )[0]
    assert row["input_tokens"] == 14
    assert row["output_tokens"] == 0
    assert row["cost"] == pytest.approx(14 * INPUT_PRICE)
    text_estimate.assert_not_called()
