"""Embedding accounting regressions for legacy Vercel and GenAI emitters.

Fixtures mirror ai@7.0.141 / @ai-sdk/otel@1.0.141 captures, before and after
@arizeai/openinference-vercel@2.7.2 enrichment. Only provider calls own usage;
the operation wrapper restates the sum and may arrive in a different batch.
"""

import json

import pytest

from tests.fixtures.otel_payloads import make_attr, make_otel_payload, make_span
from worker.otel_transform import transform_otel_to_clickhouse

TRACE_ID = "aa" * 16
WRAPPER_ID = "bb" * 8
MODEL = "text-embedding-3-small"
INPUT_PRICE = 0.00000002


@pytest.fixture(autouse=True)
def embedding_prices(monkeypatch):
    monkeypatch.setattr(
        "worker.tokens.pricing.get_model_price", lambda model: {"input": INPUT_PRICE}
    )


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
