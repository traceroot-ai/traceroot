"""Reading staged OTLP batches back from S3: raw protobuf, gzip and JSON."""

import gzip
import io
import json
import subprocess
import sys
import zlib
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from google.protobuf.json_format import MessageToDict
from google.protobuf.message import DecodeError
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)
from opentelemetry.proto.common.v1.common_pb2 import AnyValue, KeyValue

from rest.services.s3 import S3Service
from shared.bounded_gzip import GzipTooLargeError
from shared.config import settings
from worker.otel_transform import transform_otel_to_clickhouse
from worker.staged_batch import load_staged_batch

ROOT = Path(__file__).resolve().parents[2]
TRACE_ID = bytes.fromhex("0af7651916cd43dd8448eb211c80319c")
ROOT_SPAN = bytes.fromhex("b7ad6b7169203331")
CHILD_SPAN = bytes.fromhex("00f067aa0ba902b7")
KEY = "events/otel/proj-1/2026/10/29/12/0b8e4a8e-7a4e-4bbf-9b2a-3c0f6b0d8a11"


def _kv(key: str, **value) -> KeyValue:
    return KeyValue(key=key, value=AnyValue(**value))


def make_request() -> ExportTraceServiceRequest:
    """An OTLP request that exercises every attribute value type the wire allows."""
    req = ExportTraceServiceRequest()
    resource_spans = req.resource_spans.add()
    resource_spans.resource.attributes.extend(
        [
            _kv("service.name", string_value="checkout"),
            _kv("traceroot.environment", string_value="test"),
        ]
    )
    scope_spans = resource_spans.scope_spans.add()
    scope_spans.scope.name = "traceroot.manual"
    scope_spans.scope.version = "1.2.3"

    root = scope_spans.spans.add()
    root.trace_id = TRACE_ID
    root.span_id = ROOT_SPAN
    root.name = "plan trip"
    root.kind = 1
    root.start_time_unix_nano = 1_761_739_200_000_000_000
    root.end_time_unix_nano = 1_761_739_203_500_000_000
    root.attributes.extend(
        [
            _kv("traceroot.span.type", string_value="agent"),
            _kv("traceroot.span.input", string_value=json.dumps({"q": "Zürich → 東京 ✈"})),
            _kv("traceroot.span.output", string_value='{"answer": "ok"}'),
            _kv("traceroot.trace.user_id", string_value="user-7"),
            _kv("traceroot.trace.session_id", string_value="session-3"),
            _kv("retries", int_value=3),
            _kv("big.int", int_value=9_007_199_254_740_993),
            _kv("ratio", double_value=0.1),
            _kv("cached", bool_value=True),
            _kv("raw", bytes_value=b"\x00\xffbinary"),
        ]
    )
    tags = root.attributes.add()
    tags.key = "tags"
    tags.value.array_value.values.extend([AnyValue(string_value="a"), AnyValue(int_value=2)])
    nested = root.attributes.add()
    nested.key = "nested"
    nested.value.kvlist_value.values.extend([_kv("inner", string_value="v")])

    child = scope_spans.spans.add()
    child.trace_id = TRACE_ID
    child.span_id = CHILD_SPAN
    child.parent_span_id = ROOT_SPAN
    child.name = "search flights"
    child.kind = 3
    child.start_time_unix_nano = 1_761_739_200_100_000_000
    child.end_time_unix_nano = 1_761_739_201_100_000_000
    child.attributes.extend(
        [
            _kv("traceroot.span.type", string_value="tool"),
            _kv("traceroot.span.input", string_value='{"from": "ZRH"}'),
        ]
    )
    child.status.code = 2
    child.status.message = "upstream timeout"
    event = child.events.add()
    event.name = "exception"
    event.time_unix_nano = 1_761_739_201_000_000_000
    event.attributes.extend(
        [
            _kv("exception.type", string_value="TimeoutError"),
            _kv("exception.message", string_value="no answer in 1s"),
        ]
    )
    return req


class FakeS3:
    """Stores objects the way the API stages them and serves them back."""

    def __init__(self, objects: dict[str, bytes]):
        self.objects = objects
        self.calls: list[tuple[str, str]] = []

    def download_bytes(self, key: str) -> bytes:
        self.calls.append(("download_bytes", key))
        return self.objects[key]

    def download_json(self, key: str) -> dict:
        self.calls.append(("download_json", key))
        return json.loads(self.objects[key].decode("utf-8"))


def staged_three_ways(req: ExportTraceServiceRequest) -> FakeS3:
    body = req.SerializeToString()
    # The .json bytes are what upload_json writes for the decoded request.
    as_json = json.dumps(MessageToDict(req), ensure_ascii=False).encode("utf-8")
    return FakeS3(
        {
            f"{KEY}.json": as_json,
            f"{KEY}.pb": body,
            f"{KEY}.pb.gz": gzip.compress(body),
        }
    )


class TestDownloadBytes:
    def test_returns_the_object_body_unchanged(self):
        service = S3Service(bucket_name="bucket")
        client = MagicMock()
        client.get_object.return_value = {"Body": io.BytesIO(b"\x1f\x8b raw bytes")}
        service._client = client

        assert service.download_bytes("events/otel/p/k.pb.gz") == b"\x1f\x8b raw bytes"
        client.get_object.assert_called_once_with(Bucket="bucket", Key="events/otel/p/k.pb.gz")


class TestFormatsAreEquivalent:
    def test_every_format_loads_to_the_same_dict(self):
        s3 = staged_three_ways(make_request())
        from_json = load_staged_batch(s3, f"{KEY}.json")
        assert load_staged_batch(s3, f"{KEY}.pb") == from_json
        assert load_staged_batch(s3, f"{KEY}.pb.gz") == from_json

    def test_every_format_transforms_identically(self):
        s3 = staged_three_ways(make_request())
        expected = transform_otel_to_clickhouse(load_staged_batch(s3, f"{KEY}.json"), "proj-1")
        traces, spans = expected
        assert len(traces) == 1
        assert len(spans) == 2
        for suffix in (".pb", ".pb.gz"):
            got = transform_otel_to_clickhouse(load_staged_batch(s3, f"{KEY}{suffix}"), "proj-1")
            assert got == expected, suffix

    def test_json_keys_still_read_as_json(self):
        s3 = staged_three_ways(make_request())
        load_staged_batch(s3, f"{KEY}.json")
        assert s3.calls == [("download_json", f"{KEY}.json")]

    def test_protobuf_keys_read_raw_bytes(self):
        s3 = staged_three_ways(make_request())
        load_staged_batch(s3, f"{KEY}.pb")
        load_staged_batch(s3, f"{KEY}.pb.gz")
        assert s3.calls == [("download_bytes", f"{KEY}.pb"), ("download_bytes", f"{KEY}.pb.gz")]

    def test_concatenated_gzip_members_load(self):
        body = make_request().SerializeToString()
        half = len(body) // 2
        s3 = FakeS3({f"{KEY}.pb.gz": gzip.compress(body[:half]) + gzip.compress(body[half:])})
        assert load_staged_batch(s3, f"{KEY}.pb.gz") == MessageToDict(make_request())


class TestBadBatchesRaise:
    """Each of these raises, so the Celery task retries and then fails."""

    def test_unknown_suffix(self):
        s3 = FakeS3({f"{KEY}.bin": b"whatever"})
        with pytest.raises(ValueError, match="Unknown staged batch format"):
            load_staged_batch(s3, f"{KEY}.bin")
        assert s3.calls == []

    def test_not_gzip(self):
        s3 = FakeS3({f"{KEY}.pb.gz": make_request().SerializeToString()})
        with pytest.raises(zlib.error):
            load_staged_batch(s3, f"{KEY}.pb.gz")

    def test_gzip_checksum_mismatch(self):
        body = bytearray(gzip.compress(make_request().SerializeToString()))
        body[-8] ^= 0xFF  # first byte of the CRC32 trailer
        s3 = FakeS3({f"{KEY}.pb.gz": bytes(body)})
        with pytest.raises(zlib.error):
            load_staged_batch(s3, f"{KEY}.pb.gz")

    def test_truncated_gzip(self):
        body = gzip.compress(make_request().SerializeToString())
        s3 = FakeS3({f"{KEY}.pb.gz": body[: len(body) // 2]})
        with pytest.raises(EOFError):
            load_staged_batch(s3, f"{KEY}.pb.gz")

    def test_corrupt_protobuf(self):
        s3 = FakeS3({f"{KEY}.pb": b"this is not a protobuf at all"})
        with pytest.raises(DecodeError):
            load_staged_batch(s3, f"{KEY}.pb")

    def test_corrupt_protobuf_inside_valid_gzip(self):
        s3 = FakeS3({f"{KEY}.pb.gz": gzip.compress(b"this is not a protobuf at all")})
        with pytest.raises(DecodeError):
            load_staged_batch(s3, f"{KEY}.pb.gz")

    def test_gzip_past_the_unzipped_limit(self, monkeypatch):
        monkeypatch.setattr(settings.ingest, "max_unzipped_bytes", 1024)
        s3 = FakeS3({f"{KEY}.pb.gz": gzip.compress(b"\x00" * 4096)})
        with pytest.raises(GzipTooLargeError):
            load_staged_batch(s3, f"{KEY}.pb.gz")


def test_worker_module_does_not_import_the_api_routers():
    """The worker loads this module; it must not drag in the REST routers."""
    code = (
        "import sys, worker.staged_batch; "
        "loaded = [m for m in sys.modules if m.startswith('rest.routers')]; "
        "assert not loaded, loaded"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=ROOT,
        env={"PYTHONPATH": f"{ROOT}:{ROOT / 'backend'}", "TRACEROOT_ENABLED": "false"},
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
