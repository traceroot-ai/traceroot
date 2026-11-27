"""OTLP ``bytes_value`` attributes must survive ingest.

``AnyValue`` has seven variants; ``bytes_value`` is the one that
``MessageToDict`` renders as a base64 string under ``bytesValue``. These tests
pin that wire shape and check the value reaches span metadata instead of being
dropped as ``None``.
"""

import base64
import json

from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)

from tests.fixtures.otel_payloads import make_otel_payload, make_span
from worker.otel_transform import (
    attributes_to_dict,
    extract_attribute_value,
    transform_otel_to_clickhouse,
)
from worker.staged_batch import decode_otlp_protobuf

TRACE_HEX = "abcdef0123456789abcdef0123456789"
SPAN_HEX = "1122334455667788"
RAW = b"\x00\x01\x02\xff"
B64 = base64.b64encode(RAW).decode()


class TestExtractBytesValue:
    def test_scalar_bytes_value_is_kept_as_base64(self):
        assert extract_attribute_value({"bytesValue": B64}) == B64

    def test_bytes_value_inside_array(self):
        result = extract_attribute_value(
            {"arrayValue": {"values": [{"bytesValue": B64}, {"stringValue": "x"}]}}
        )
        assert result == [B64, "x"]

    def test_bytes_value_inside_kvlist(self):
        result = extract_attribute_value(
            {"kvlistValue": {"values": [{"key": "digest", "value": {"bytesValue": B64}}]}}
        )
        assert result == {"digest": B64}

    def test_attributes_to_dict_keeps_bytes_attribute(self):
        attrs = [{"key": "app.digest", "value": {"bytesValue": B64}}]
        assert attributes_to_dict(attrs) == {"app.digest": B64}


class TestBytesValueFromWire:
    def test_protobuf_bytes_attribute_decodes_to_base64_and_is_extracted(self):
        """Pin the MessageToDict wire shape this branch relies on."""
        req = ExportTraceServiceRequest()
        span = req.resource_spans.add().scope_spans.add().spans.add()
        span.trace_id = bytes.fromhex(TRACE_HEX)
        span.span_id = bytes.fromhex(SPAN_HEX)
        span.name = "x"
        attr = span.attributes.add()
        attr.key = "app.digest"
        attr.value.bytes_value = RAW

        decoded = decode_otlp_protobuf(req.SerializeToString())
        span_dict = decoded["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
        (bytes_attr,) = span_dict["attributes"]

        assert bytes_attr["value"] == {"bytesValue": B64}
        assert base64.b64decode(extract_attribute_value(bytes_attr["value"])) == RAW

    def test_bytes_attribute_reaches_span_metadata(self):
        span = make_span(
            TRACE_HEX,
            SPAN_HEX,
            attributes=[
                {"key": "app.digest", "value": {"bytesValue": B64}},
                {"key": "app.label", "value": {"stringValue": "hello"}},
            ],
        )

        _traces, spans = transform_otel_to_clickhouse(
            make_otel_payload([span]), project_id="proj-1"
        )

        assert len(spans) == 1
        meta = json.loads(spans[0]["metadata"])
        assert meta["app.digest"] == B64
        assert meta["app.label"] == "hello"
