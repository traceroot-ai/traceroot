"""The structural budget check that runs on a staged batch before it is decoded."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from google.protobuf import descriptor_pb2
from google.protobuf.message import DecodeError
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)
from opentelemetry.proto.common.v1.common_pb2 import AnyValue, KeyValue

from shared.config import IngestSettings
from worker import batch_budget
from worker.batch_budget import BudgetExceededError, check_batch_budget
from worker.staged_batch import decode_otlp_protobuf

ROOT = Path(__file__).resolve().parents[2]
NO_LIMIT = 10**9


def _kv(key: str, value: str = "v") -> KeyValue:
    return KeyValue(key=key, value=AnyValue(string_value=value))


def every_kind() -> ExportTraceServiceRequest:
    """One of every repeated entry the trace schema has, at every level."""
    req = ExportTraceServiceRequest()
    resource_spans = req.resource_spans.add()  # other 1
    resource = resource_spans.resource
    resource.attributes.extend([_kv("service.name"), _kv("host")])  # attributes 2
    ref = resource.entity_refs.add()  # other 2
    ref.type = "service"
    ref.id_keys.extend(["service.name", "service.namespace"])  # other 4
    ref.description_keys.append("host")  # other 5
    scope_spans = resource_spans.scope_spans.add()  # other 6
    scope_spans.scope.name = "manual"
    scope_spans.scope.attributes.append(_kv("scope.attr"))  # attributes 3

    span = scope_spans.spans.add()  # spans 1
    span.trace_id = b"\x01" * 16
    span.span_id = b"\x02" * 8
    span.start_time_unix_nano = 1_761_739_200_000_000_000  # fixed64
    span.kind = 2  # varint
    span.flags = 1  # fixed32
    span.attributes.append(_kv("plain"))  # attributes 4
    listed = span.attributes.add()  # attributes 5
    listed.key = "list"
    listed.value.array_value.values.extend(  # attributes 7
        [AnyValue(string_value="a"), AnyValue(int_value=2)]
    )
    nested = span.attributes.add()  # attributes 8
    nested.key = "map"
    inner = KeyValue(key="inner")  # attributes 9
    inner.value.kvlist_value.values.append(_kv("deepest"))  # attributes 10
    nested.value.kvlist_value.values.append(inner)
    event = span.events.add()  # events 1
    event.name = "exception"
    event.attributes.append(_kv("exception.type"))  # attributes 11
    link = span.links.add()  # links 1
    link.trace_id = b"\x03" * 16
    link.attributes.append(_kv("link.attr"))  # attributes 12
    span.status.code = 2

    scope_spans.spans.add().name = "second"  # spans 2
    return req


def _entries(message) -> int:
    """Count repeated entries the way decoding builds them, from a parsed message."""
    total = 0
    for field, value in message.ListFields():
        if field.is_repeated:
            total += len(value)
            if field.message_type is not None:
                total += sum(_entries(item) for item in value)
        elif field.message_type is not None:
            total += _entries(value)
    return total


class TestCounts:
    def test_counts_every_repeated_entry_by_kind(self):
        counts = check_batch_budget(every_kind().SerializeToString(), NO_LIMIT, NO_LIMIT)

        assert counts == {
            "spans": 2,
            "events": 1,
            "links": 1,
            "attributes": 12,
            "other": 6,
            "total": 22,
        }

    def test_total_matches_what_protobuf_decodes(self):
        req = every_kind()
        counts = check_batch_budget(req.SerializeToString(), NO_LIMIT, NO_LIMIT)
        assert counts["total"] == _entries(req)

    def test_unknown_fields_are_skipped(self):
        unknown = b"\xfa\x3e\x03abc" + b"\x80\x3f\x01"  # field 1007 as bytes, 1008 as varint
        body = every_kind().SerializeToString() + unknown

        assert check_batch_budget(body, NO_LIMIT, NO_LIMIT)["total"] == 22
        ExportTraceServiceRequest().ParseFromString(body)  # protobuf accepts it too

    def test_empty_body_counts_nothing(self):
        assert check_batch_budget(b"", 1, 1)["total"] == 0


class TestBudgets:
    def test_spans_at_the_budget_pass(self):
        assert check_batch_budget(every_kind().SerializeToString(), 2, NO_LIMIT)["spans"] == 2

    def test_one_span_over_the_budget_is_refused(self):
        with pytest.raises(BudgetExceededError, match=r"more than 1 spans \(INGEST_MAX_SPANS\)"):
            check_batch_budget(every_kind().SerializeToString(), 1, NO_LIMIT)

    def test_objects_at_the_budget_pass(self):
        assert check_batch_budget(every_kind().SerializeToString(), NO_LIMIT, 22)["total"] == 22

    def test_one_object_over_the_budget_is_refused(self):
        with pytest.raises(
            BudgetExceededError, match=r"more than 21 objects \(INGEST_MAX_OBJECTS\)"
        ):
            check_batch_budget(every_kind().SerializeToString(), NO_LIMIT, 21)

    @pytest.mark.parametrize(
        ("item", "kind"),
        [
            (b"\x4a\x00", "attributes"),  # Span.attributes: KeyValue{}
            (b"\x5a\x00", "events"),  # Span.events: Event{}
            (b"\x6a\x00", "links"),  # Span.links: Link{}
        ],
    )
    def test_a_flood_of_empty_entries_stops_at_the_budget(self, item, kind):
        span = item * 1_000_000
        body = b"\x0a" + _len(b"\x12" + _len(b"\x12" + _len(span)))

        with pytest.raises(BudgetExceededError, match=rf"1000 {kind}"):
            check_batch_budget(body, NO_LIMIT, 1002)

    def test_message_names_every_kind_counted_so_far(self):
        with pytest.raises(BudgetExceededError) as raised:
            check_batch_budget(every_kind().SerializeToString(), NO_LIMIT, 10)
        assert "counted so far:" in str(raised.value)
        assert "spans" in str(raised.value) and "other" in str(raised.value)


def _len(data: bytes) -> bytes:
    """A length prefix followed by ``data``."""
    n, out = len(data), bytearray()
    while n > 127:
        out.append((n & 127) | 128)
        n >>= 7
    out.append(n)
    return bytes(out) + data


def _nested_to(depth: int, innermost: bytes) -> bytes:
    """A request whose deepest message is an attribute value ``depth`` levels below it.

    The value holds arrays within arrays down to ``innermost``. A resource attribute's
    value sits 4 levels below the request and a span attribute's 5, so one of the two
    reaches any depth from 4 on.
    """
    start = 4 if depth % 2 == 0 else 5
    value = innermost
    for _ in range((depth - start) // 2):  # AnyValue.array_value -> ArrayValue.values
        value = b"\x2a" + _len(b"\x0a" + _len(value))
    attribute = b"\x0a\x01k\x12" + _len(value)  # KeyValue.key, KeyValue.value
    if start == 4:  # ResourceSpans.resource -> Resource.attributes
        resource_spans = b"\x0a" + _len(b"\x0a" + _len(attribute))
    else:  # ResourceSpans.scope_spans -> ScopeSpans.spans -> Span.attributes
        resource_spans = b"\x12" + _len(b"\x12" + _len(b"\x4a" + _len(attribute)))
    return b"\x0a" + _len(resource_spans)


class TestMalformed:
    @pytest.mark.parametrize(
        ("body", "message"),
        [
            (b"\x0a", "Truncated varint"),  # a tag with no length
            (b"\x0a\x05ab", "Truncated length-delimited field"),
            (b"\x0a\x07\x12\x05\x12\x03\x39\x01\x02", "Truncated fixed-width field"),
            (b"\x0b", "Unsupported wire type 3"),  # a group, which OTLP never uses
            (b"\x08" + b"\xff" * 10 + b"\x01", "Varint is too long"),
        ],
    )
    def test_malformed_encoding_raises_decode_error(self, body, message):
        with pytest.raises(DecodeError, match=message):
            check_batch_budget(body, NO_LIMIT, NO_LIMIT)

    def test_nesting_past_the_limit_raises_decode_error(self):
        value = b""
        for _ in range(batch_budget.MAX_DEPTH):  # array_value -> values -> array_value ...
            value = b"\x2a" + _len(b"\x0a" + _len(value))
        attribute = b"\x4a" + _len(b"\x12" + _len(value))
        body = b"\x0a" + _len(b"\x12" + _len(b"\x12" + _len(attribute)))

        with pytest.raises(DecodeError, match="nested deeper than 100"):
            check_batch_budget(body, NO_LIMIT, NO_LIMIT)

    @pytest.mark.parametrize("depth", [batch_budget.MAX_DEPTH, batch_budget.MAX_DEPTH + 1])
    @pytest.mark.parametrize("innermost", [b"\x0a\x01x", b""], ids=["string", "empty"])
    def test_depth_limit_matches_the_decoder(self, depth, innermost):
        """A batch the worker's decoder accepts is never refused for its depth."""
        body = _nested_to(depth, innermost)
        try:
            decode_otlp_protobuf(body)
        except DecodeError:
            decodes = False
        else:
            decodes = True

        assert decodes == (depth <= batch_budget.MAX_DEPTH)
        if decodes:
            check_batch_budget(body, NO_LIMIT, NO_LIMIT)
        else:
            with pytest.raises(DecodeError, match="nested deeper than 100"):
                check_batch_budget(body, NO_LIMIT, NO_LIMIT)


def test_a_repeated_numeric_field_is_refused_when_the_tables_are_built():
    """No trace field is a repeated number; if one appears, counting must be extended."""
    with pytest.raises(TypeError, match="public_dependency"):
        batch_budget._build_tables(descriptor_pb2.FileDescriptorProto.DESCRIPTOR)


class TestSettings:
    def test_defaults(self, monkeypatch):
        monkeypatch.delenv("INGEST_MAX_SPANS", raising=False)
        monkeypatch.delenv("INGEST_MAX_OBJECTS", raising=False)
        ingest = IngestSettings()
        assert ingest.max_spans == 50_000
        assert ingest.max_objects == 500_000

    def test_env_overrides(self, monkeypatch):
        monkeypatch.setenv("INGEST_MAX_SPANS", "10")
        monkeypatch.setenv("INGEST_MAX_OBJECTS", "20")
        ingest = IngestSettings()
        assert (ingest.max_spans, ingest.max_objects) == (10, 20)

    @pytest.mark.parametrize("name", ["INGEST_MAX_SPANS", "INGEST_MAX_OBJECTS"])
    def test_zero_is_rejected(self, monkeypatch, name):
        monkeypatch.setenv(name, "0")
        with pytest.raises(ValueError):
            IngestSettings()


# Decodes a gzip flood of two-byte empty messages just under the 32 MiB unzipped cap
# through the worker's real loader, in a fresh process, and prints its peak RSS.
_DECODE_FLOOD = """
import gzip, json, resource, sys
from worker.staged_batch import BatchOverBudgetError, load_staged_batch

def peak():
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return rss if sys.platform == "darwin" else rss * 1024

item, wrap = bytes.fromhex(sys.argv[1]), int(sys.argv[2])
def length(data):
    n, out = len(data), bytearray()
    while n > 127:
        out.append((n & 127) | 128)
        n >>= 7
    out.append(n)
    return bytes(out) + data
body = item * ((32 * 1024 * 1024 - 64) // len(item))
for tag in [0x12, 0x12, 0x0a][-wrap:]:
    body = bytes([tag]) + length(body)
compressed = gzip.compress(body, compresslevel=1)
del body

class S3:
    def download_bytes(self, key):
        return compressed

before = peak()
try:
    load_staged_batch(S3(), "events/ingest/p/2026/11/01/00/batch.pb.gz")
    refused = False
except BatchOverBudgetError:
    refused = True
print(json.dumps({"before": before, "peak": peak(), "refused": refused}))
"""

# Each of these cost over 1 GiB to decode before the budget check: 16 million empty
# spans took 2.9 GiB in ParseFromString alone, and 16 million empty attributes 2.1 GiB
# by the end of MessageToDict.
_FLOODS = {
    "spans": ("1200", 2),  # ScopeSpans.spans: Span{}, inside one scope and resource group
    "attributes": ("4a00", 3),  # Span.attributes: KeyValue{}, inside one span
}
_DECODE_BOUND = 256 * 1024 * 1024


@pytest.mark.parametrize("flood", sorted(_FLOODS))
def test_decoding_a_flood_under_the_caps_stays_within_the_memory_bound(flood):
    item, wrap = _FLOODS[flood]
    env = {k: v for k, v in os.environ.items() if not k.startswith("INGEST_")}
    env.update(TRACEROOT_ENABLED="false", PYTHONPATH=f"{ROOT}:{ROOT / 'backend'}")

    result = subprocess.run(
        [sys.executable, "-c", _DECODE_FLOOD, item, str(wrap)],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )

    assert result.returncode == 0, result.stderr
    measured = json.loads(result.stdout.strip().splitlines()[-1])
    assert measured["refused"]
    assert measured["peak"] - measured["before"] < _DECODE_BOUND, measured
