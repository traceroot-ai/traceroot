"""Robustness and anti-abuse tests for trace ingestion.

Two questions this file answers:

1. How does the platform protect itself from malformed / adversarial traces
   sent by a customer over the public ingest path?
2. What happens to the transform code if a malformed OTLP structure ever
   reaches it (defense-in-depth characterization)?

The wire-level protection is layered: the public route requires an API key
(project is bound from the key, never the payload), demands
``application/x-protobuf``, and runs ``ParseFromString`` + ``MessageToDict``.
Protobuf's schema is therefore the first gate — a customer cannot produce a
structurally malformed attribute dict, because the proto type system rejects
it before the transform ever runs. These tests pin both the gate and the
transform's own behavior on decoded input.
"""

import pytest
from google.protobuf.message import DecodeError
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)

from rest.routers.public.traces import decode_otlp_protobuf
from tests.fixtures.otel_payloads import make_attr, make_otel_payload, make_span
from worker.otel_transform import (
    attributes_to_dict,
    extract_attribute_value,
    transform_otel_to_clickhouse,
)

TRACE_HEX = "abcdef0123456789abcdef0123456789"
SPAN_HEX = "1122334455667788"


# ---------------------------------------------------------------------------
# The protobuf decode gate — the first line of defense on the wire
# ---------------------------------------------------------------------------
class TestProtobufGate:
    def test_garbage_bytes_are_rejected(self):
        with pytest.raises(DecodeError):
            decode_otlp_protobuf(b"this is not a protobuf at all")

    def test_truncated_protobuf_is_rejected(self):
        req = ExportTraceServiceRequest()
        rs = req.resource_spans.add()
        span = rs.scope_spans.add().spans.add()
        span.trace_id = bytes.fromhex(TRACE_HEX)
        span.span_id = bytes.fromhex(SPAN_HEX)
        span.name = "x"
        body = req.SerializeToString()
        # Lopping off the tail leaves a structurally invalid message.
        with pytest.raises(DecodeError):
            decode_otlp_protobuf(body[: len(body) // 2])

    def test_decoded_int_attribute_is_always_a_numeric_string(self):
        """MessageToDict renders int64 as a *valid* decimal string, so the
        ``int(...)`` cast in extract_attribute_value can never see 'abc' from a
        real wire payload — the proto schema guarantees it."""
        req = ExportTraceServiceRequest()
        span = req.resource_spans.add().scope_spans.add().spans.add()
        span.trace_id = bytes.fromhex(TRACE_HEX)
        span.span_id = bytes.fromhex(SPAN_HEX)
        span.name = "x"
        attr = span.attributes.add()
        attr.key = "gen_ai.usage.input_tokens"
        attr.value.int_value = 4048

        decoded = decode_otlp_protobuf(req.SerializeToString())
        span_dict = decoded["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
        (int_attr,) = [a for a in span_dict["attributes"] if a["key"].endswith("input_tokens")]
        raw = int_attr["value"]["intValue"]
        assert isinstance(raw, str) and raw.isdigit()
        assert extract_attribute_value(int_attr["value"]) == 4048

    def test_decoded_attributes_are_always_a_list(self):
        """A span always decodes to an attributes *list*, so attributes_to_dict
        never sees a non-iterable — the crash it would take is unreachable from
        the wire."""
        req = ExportTraceServiceRequest()
        span = req.resource_spans.add().scope_spans.add().spans.add()
        span.trace_id = bytes.fromhex(TRACE_HEX)
        span.span_id = bytes.fromhex(SPAN_HEX)
        span.name = "x"
        decoded = decode_otlp_protobuf(req.SerializeToString())
        span_dict = decoded["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
        # No attributes at all → key absent, and attributes_to_dict tolerates it.
        assert attributes_to_dict(span_dict.get("attributes", [])) == {}


# ---------------------------------------------------------------------------
# Anti-spoof: a customer cannot classify or reroute their own traffic
# ---------------------------------------------------------------------------
class TestPublicPathAntiSpoof:
    def _spoofed_payload(self):
        span = make_span(
            TRACE_HEX,
            SPAN_HEX,
            attributes=[
                make_attr("traceroot.source", "detector"),  # hide from lists/metering
                make_attr("traceroot.project_id", "victim-project"),  # reroute
                make_attr("legit.attr", "keep-me"),
            ],
        )
        return make_otel_payload([span])

    def test_spoofed_source_is_coerced_to_user(self):
        """The public path calls the transform with trust_source=False, so a
        customer-supplied traceroot.source=detector can never classify traffic
        as detector-sourced (which would hide it from lists and metering)."""
        traces, spans = transform_otel_to_clickhouse(
            self._spoofed_payload(), project_id="caller-project"
        )
        assert spans and all(s["source"] == "user" for s in spans)
        assert traces and all(t["source"] == "user" for t in traces)

    def test_spoofed_project_id_does_not_reroute(self):
        """traceroot.project_id is not a routing input on the public transform
        (only the detector wrapper consumes it). Every record is stamped with
        the caller's project; the attribute survives only as inert metadata."""
        traces, spans = transform_otel_to_clickhouse(
            self._spoofed_payload(), project_id="caller-project"
        )
        assert all(s["project_id"] == "caller-project" for s in spans)
        assert all(t["project_id"] == "caller-project" for t in traces)
        assert not any(s["project_id"] == "victim-project" for s in spans)


# ---------------------------------------------------------------------------
# Defense-in-depth characterization: what the transform does with malformed
# structures the protobuf gate would normally reject. These pin CURRENT
# behavior — if a non-protobuf JSON source is ever added upstream, they are the
# exposure map (the transform trusts its input, so the gate must stay in front).
# ---------------------------------------------------------------------------
class TestMalformedStructureCharacterization:
    def test_non_numeric_int_value_raises(self):
        # Unreachable from the wire (proto renders int64 as digits); documents
        # that the transform does not itself guard the cast.
        with pytest.raises(ValueError):
            extract_attribute_value({"intValue": "not-a-number"})

    def test_non_list_attributes_raise(self):
        with pytest.raises(AttributeError):
            attributes_to_dict("not-a-list")

    def test_unknown_value_kind_becomes_none(self):
        # An attribute value with no recognized type key is tolerated as None.
        assert extract_attribute_value({}) is None
        assert attributes_to_dict([{"key": "k", "value": {}}]) == {"k": None}
