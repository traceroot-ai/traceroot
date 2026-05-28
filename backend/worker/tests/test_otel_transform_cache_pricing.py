import base64
import json
from unittest.mock import patch

from worker.otel_transform import transform_otel_to_clickhouse


def _make_trace_id() -> str:
    return base64.b64encode(b"\x01" * 16).decode()


def _make_span_id(byte: int = 0x02) -> str:
    return base64.b64encode(bytes([byte] * 8)).decode()


def _attr(key: str, value) -> dict:
    if isinstance(value, str):
        return {"key": key, "value": {"stringValue": value}}
    if isinstance(value, bool):
        return {"key": key, "value": {"boolValue": value}}
    if isinstance(value, int):
        return {"key": key, "value": {"intValue": str(value)}}
    if isinstance(value, float):
        return {"key": key, "value": {"doubleValue": value}}
    return {
        "key": key,
        "value": {"stringValue": json.dumps(value) if not isinstance(value, str) else value},
    }


def _otel_payload(span_attributes: list[dict]) -> dict:
    span = {
        "traceId": _make_trace_id(),
        "spanId": _make_span_id(),
        "name": "test-span",
        "kind": "SPAN_KIND_INTERNAL",
        "startTimeUnixNano": "1700000000000000000",
        "endTimeUnixNano": "1700000001000000000",
        "attributes": span_attributes,
        "status": {},
    }
    return {
        "resourceSpans": [
            {
                "resource": {"attributes": []},
                "scopeSpans": [{"scope": {"name": "test"}, "spans": [span]}],
            }
        ]
    }


def test_otel_transform_includes_cache_pricing():
    """Verify that OTel transformation correctly calculates prompt caching costs and rescues cache keys into metadata."""
    span_attributes = [
        _attr("gen_ai.request.model", "claude-3-5-sonnet"),
        _attr("gen_ai.usage.input_tokens", 1000),
        _attr("gen_ai.usage.output_tokens", 200),
        _attr("gen_ai.usage.details.cache_read_tokens", 400),
        _attr("gen_ai.usage.details.cache_write_tokens", 100),
    ]
    payload = _otel_payload(span_attributes)

    mock_prices = {
        "input": 0.000003,
        "output": 0.000015,
        "cacheRead": 0.0000003,
        "cacheWrite": 0.00000375,
    }

    with patch("worker.tokens.pricing.get_model_price", return_value=mock_prices):
        _traces, spans = transform_otel_to_clickhouse(payload, project_id="proj-1")

    assert len(spans) == 1
    span = spans[0]

    assert span["input_tokens"] == 1000
    assert span["output_tokens"] == 200

    # Expected cost:
    # 1000 * 0.000003 + 200 * 0.000015 + 400 * 0.0000003 + 100 * 0.00000375
    # = 0.003 + 0.003 + 0.00012 + 0.000375
    # = 0.006495
    expected_cost = 1000 * 0.000003 + 200 * 0.000015 + 400 * 0.0000003 + 100 * 0.00000375
    assert abs(span["cost"] - expected_cost) < 1e-9

    # Verify that cache keys are rescued/preserved in metadata
    assert "metadata" in span
    meta = json.loads(span["metadata"])
    assert meta["gen_ai.usage.details.cache_read_tokens"] == 400
    assert meta["gen_ai.usage.details.cache_write_tokens"] == 100


def test_otel_transform_fallback_caching():
    """Verify that OTel transformation fallback calculate_cost path uses cache tokens."""
    span_attributes = [
        _attr("gen_ai.request.model", "claude-3-5-sonnet"),
        _attr("gen_ai.usage.details.cache_read_tokens", 500),
        _attr("gen_ai.usage.details.cache_write_tokens", 200),
    ]
    payload = _otel_payload(span_attributes)

    mock_prices = {
        "input": 0.000003,
        "output": 0.000015,
        "cacheRead": 0.0000003,
        "cacheWrite": 0.00000375,
    }

    # Under fallback path, input_text / output_text are used to estimate tokens (both 0 tokens if None).
    # Since input/output are None, estimated tokens are 0.
    # Cost should be calculated purely on the cache read and write tokens.
    with patch("worker.tokens.pricing.get_model_price", return_value=mock_prices):
        _traces, spans = transform_otel_to_clickhouse(payload, project_id="proj-1")

    assert len(spans) == 1
    span = spans[0]

    # Expected cost: 500 * 0.0000003 + 200 * 0.00000375 = 0.00015 + 0.00075 = 0.0009
    expected_cost = 500 * 0.0000003 + 200 * 0.00000375
    assert abs(span["cost"] - expected_cost) < 1e-9
