"""The ingest route stages the original request body, and the worker reads it back."""

import gzip
import json
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from google.protobuf.json_format import MessageToDict
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)
from opentelemetry.proto.common.v1.common_pb2 import AnyValue, KeyValue

from rest.main import app
from rest.routers.public.traces import AuthResult, authenticate_api_key
from rest.services.s3 import S3Service
from worker.otel_transform import transform_otel_to_clickhouse
from worker.staged_batch import load_staged_batch


class TestUploadBytes:
    def test_stores_the_bytes_as_given_without_a_content_encoding(self):
        service = S3Service(bucket_name="bucket")
        client = MagicMock()
        service._client = client

        service.upload_bytes("events/otel/p/k.pb.gz", b"\x1f\x8b body", "application/x-protobuf")

        client.put_object.assert_called_once_with(
            Bucket="bucket",
            Key="events/otel/p/k.pb.gz",
            Body=b"\x1f\x8b body",
            ContentType="application/x-protobuf",
        )


TRACE_ID = bytes.fromhex("4bf92f3577b34da6a3ce929d0e0e4736")
ROOT_SPAN = bytes.fromhex("00f067aa0ba902b7")
CHILD_SPAN = bytes.fromhex("b7ad6b7169203331")
INGEST_URL = "/api/v1/public/traces"
PROTOBUF = {"Content-Type": "application/x-protobuf"}
GZIP_PROTOBUF = {**PROTOBUF, "Content-Encoding": "gzip"}


def _kv(key: str, **value) -> KeyValue:
    return KeyValue(key=key, value=AnyValue(**value))


def make_request() -> ExportTraceServiceRequest:
    """A two-span OTLP request with text, numbers and a non-ASCII payload."""
    req = ExportTraceServiceRequest()
    resource_spans = req.resource_spans.add()
    resource_spans.resource.attributes.append(_kv("service.name", string_value="checkout"))
    scope_spans = resource_spans.scope_spans.add()
    scope_spans.scope.name = "traceroot.manual"

    root = scope_spans.spans.add()
    root.trace_id = TRACE_ID
    root.span_id = ROOT_SPAN
    root.name = "answer question"
    root.start_time_unix_nano = 1_761_739_200_000_000_000
    root.end_time_unix_nano = 1_761_739_202_000_000_000
    root.attributes.extend(
        [
            _kv("traceroot.span.type", string_value="agent"),
            _kv("traceroot.span.input", string_value='{"q": "Grüße aus 東京"}'),
            _kv("traceroot.trace.user_id", string_value="user-1"),
            _kv("attempt", int_value=2),
            _kv("score", double_value=0.75),
        ]
    )
    child = scope_spans.spans.add()
    child.trace_id = TRACE_ID
    child.span_id = CHILD_SPAN
    child.parent_span_id = ROOT_SPAN
    child.name = "lookup"
    child.start_time_unix_nano = 1_761_739_200_500_000_000
    child.end_time_unix_nano = 1_761_739_201_000_000_000
    child.attributes.append(_kv("traceroot.span.type", string_value="tool"))
    return req


@pytest.fixture()
def ingest(monkeypatch):
    """The ingest route with auth stubbed, and S3 and Celery mocked."""
    app.dependency_overrides[authenticate_api_key] = lambda: AuthResult(
        project_id="test-project",
        workspace_id="test-workspace",
        billing_plan="pro",
        ingestion_blocked=False,
    )
    s3 = MagicMock()
    monkeypatch.setattr("rest.routers.public.traces.get_s3_service", lambda: s3)
    task = MagicMock()
    monkeypatch.setattr("rest.routers.public.traces.process_s3_traces", task)
    return TestClient(app), s3, task


class _StagedObjects:
    """Serves what the route uploaded back to ``load_staged_batch``."""

    def __init__(self, uploads: MagicMock):
        self.objects = {c.args[0]: c.args[1] for c in uploads.call_args_list}

    def download_bytes(self, key: str) -> bytes:
        return self.objects[key]


def _old_json_path(req: ExportTraceServiceRequest) -> dict:
    """What the API staged before: the decoded request, written and read as JSON."""
    return json.loads(json.dumps(MessageToDict(req), ensure_ascii=False))


class TestStagesTheOriginalBody:
    def test_gzip_request_is_staged_byte_identical(self, ingest):
        client, s3, task = ingest
        body = gzip.compress(make_request().SerializeToString())

        response = client.post(INGEST_URL, content=body, headers=GZIP_PROTOBUF)

        assert response.status_code == 200
        key, staged = s3.upload_bytes.call_args.args
        assert key.endswith(".pb.gz")
        assert staged == body
        assert s3.upload_bytes.call_args.kwargs == {"content_type": "application/x-protobuf"}
        assert response.json() == {"status": "ok", "file_key": key}
        task.delay.assert_called_once_with(s3_key=key, project_id="test-project")
        s3.upload_json.assert_not_called()

    def test_uncompressed_request_is_staged_byte_identical(self, ingest):
        client, s3, _ = ingest
        body = make_request().SerializeToString()

        response = client.post(INGEST_URL, content=body, headers=PROTOBUF)

        assert response.status_code == 200
        key, staged = s3.upload_bytes.call_args.args
        assert key.endswith(".pb")
        assert not key.endswith(".pb.gz")
        assert staged == body
        assert response.json() == {"status": "ok", "file_key": key}

    def test_valid_gzip_with_invalid_protobuf_is_accepted(self, ingest):
        """Without a decode in the API, a bad protobuf is only found by the worker."""
        client, s3, task = ingest
        body = gzip.compress(b"this is not a protobuf at all")

        response = client.post(INGEST_URL, content=body, headers=GZIP_PROTOBUF)

        assert response.status_code == 200
        assert s3.upload_bytes.call_args.args[1] == body
        task.delay.assert_called_once()


class TestApiToWorkerRoundTrip:
    @pytest.mark.parametrize(
        ("headers", "encode"),
        [(PROTOBUF, lambda b: b), (GZIP_PROTOBUF, gzip.compress)],
        ids=["pb", "pb.gz"],
    )
    def test_staged_bytes_transform_like_the_old_json_path(self, ingest, headers, encode):
        client, s3, _ = ingest
        req = make_request()

        response = client.post(INGEST_URL, content=encode(req.SerializeToString()), headers=headers)
        assert response.status_code == 200

        key = response.json()["file_key"]
        loaded = load_staged_batch(_StagedObjects(s3.upload_bytes), key)
        expected = transform_otel_to_clickhouse(_old_json_path(req), "test-project")
        assert transform_otel_to_clickhouse(loaded, "test-project") == expected
        traces, spans = expected
        assert len(traces) == 1
        assert len(spans) == 2

    def test_concatenated_gzip_members_round_trip(self, ingest):
        client, s3, _ = ingest
        req = make_request()
        raw = req.SerializeToString()
        body = gzip.compress(raw[:10]) + gzip.compress(raw[10:])

        response = client.post(INGEST_URL, content=body, headers=GZIP_PROTOBUF)
        assert response.status_code == 200

        key = response.json()["file_key"]
        assert load_staged_batch(_StagedObjects(s3.upload_bytes), key) == _old_json_path(req)
