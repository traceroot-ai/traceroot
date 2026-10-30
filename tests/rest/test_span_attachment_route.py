"""Tests for GET /projects/{project_id}/traces/{trace_id}/spans/{span_id}/attachments/{hash}.

The reader service and S3 are mocked, so no ClickHouse or object store is needed.
"""

import hashlib
import io
import json
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock

import pytest
import respx
from botocore.exceptions import ClientError
from botocore.response import StreamingBody
from fastapi.testclient import TestClient
from httpx import Response as HttpxResponse

import rest.routers.traces as traces_mod
from rest.main import app
from rest.openapi_public import build_docs_schema, build_public_schema
from rest.routers.deps import ProjectAccessInfo, get_project_access
from rest.services.s3 import S3ObjectStream
from shared.attachments import format_attachment_ref
from shared.config import settings
from tests.fixtures.images import make_gif, make_jpeg, make_png, make_webp_vp8x

PROJECT = "test-project"
TRACE = "trace-a"
SPAN = "span-a"
PNG = make_png(2, 2)
HASH = hashlib.sha256(PNG).hexdigest()
OTHER_HASH = hashlib.sha256(b"another image").hexdigest()
URL = f"/api/v1/projects/{PROJECT}/traces/{TRACE}/spans/{SPAN}/attachments/{HASH}"
# The UI proxy asks for the bytes as stored. Without this the app's gzip middleware
# re-encodes the stream and drops Content-Length.
IDENTITY = {"Accept-Encoding": "identity"}


def _ref(sha256_hex: str = HASH, mime: str = "image/png", size: int = len(PNG)) -> str:
    return format_attachment_ref(sha256_hex, mime, size)


def _span_io(input_=None, output=None, metadata=None) -> dict:
    return {
        "span_id": SPAN,
        "trace_id": TRACE,
        "input": input_,
        "output": output,
        "metadata": metadata,
    }


def _stored(data: bytes = PNG, content_type: str | None = "image/png", length: bool = True):
    """An S3ObjectStream over in-memory bytes, plus the raw stream to check it was closed."""
    raw = io.BytesIO(data)
    stored = S3ObjectStream(
        body=StreamingBody(raw, len(data)),
        content_type=content_type,
        content_length=len(data) if length else None,
    )
    return stored, raw


def _access(billing_plan: str):
    async def mock_get_access(project_id: str, x_user_id=None):
        return ProjectAccessInfo(
            project_id=project_id,
            user_id="test-user",
            role="ADMIN",
            workspace_id="ws-test",
            billing_plan=billing_plan,
        )

    return mock_get_access


@pytest.fixture()
def reader():
    service = MagicMock()
    service.get_trace_start_time.return_value = datetime.now(UTC).replace(tzinfo=None)
    service.get_span_io.return_value = _span_io(output=json.dumps({"image": _ref()}))
    return service


@pytest.fixture()
def s3():
    service = MagicMock()
    service.get_object_stream.return_value = _stored()[0]
    return service


@pytest.fixture()
def services(monkeypatch, reader, s3):
    monkeypatch.setattr(traces_mod, "get_trace_reader_service", lambda: reader)
    monkeypatch.setattr(traces_mod, "get_s3_service", lambda: s3)


@pytest.fixture()
def client(services):
    app.dependency_overrides[get_project_access] = _access("enterprise")
    return TestClient(app)


@pytest.fixture()
def free_plan_client(services):
    app.dependency_overrides[get_project_access] = _access("free")
    return TestClient(app)


class TestServesReferencedImage:
    def test_streams_the_stored_bytes_with_their_type(self, client, s3):
        stored, raw = _stored()
        s3.get_object_stream.return_value = stored

        response = client.get(URL, headers=IDENTITY)

        assert response.status_code == 200
        assert response.content == PNG
        assert response.headers["content-type"] == "image/png"
        assert response.headers["content-length"] == str(len(PNG))
        s3.get_object_stream.assert_called_once_with(f"attachments/{PROJECT}/sha256/{HASH}")
        # Streamed to the end, then the connection to the store is released.
        assert raw.closed

    def test_never_cached_and_never_sniffed(self, client):
        response = client.get(URL, headers=IDENTITY)

        assert response.headers["cache-control"] == "private, no-store"
        assert response.headers["x-content-type-options"] == "nosniff"
        assert response.headers["content-disposition"] == "inline"

    @pytest.mark.parametrize("field", ["input", "output", "metadata"])
    def test_a_reference_in_any_span_field_is_enough(self, client, reader, field):
        text = f"before {_ref()} after"
        reader.get_span_io.return_value = {**_span_io(), field: text}

        response = client.get(URL, headers=IDENTITY)

        assert response.status_code == 200
        kw = reader.get_span_io.call_args.kwargs
        assert kw == {"project_id": PROJECT, "trace_id": TRACE, "span_id": SPAN}

    @pytest.mark.parametrize(
        ("mime", "data"),
        [
            ("image/png", make_png()),
            ("image/jpeg", make_jpeg()),
            ("image/gif", make_gif()),
            ("image/webp", make_webp_vp8x()),
        ],
    )
    def test_every_allowed_image_type(self, client, reader, s3, mime, data):
        sha = hashlib.sha256(data).hexdigest()
        reader.get_span_io.return_value = _span_io(input_=_ref(sha, mime, len(data)))
        s3.get_object_stream.return_value = _stored(data, mime)[0]

        response = client.get(
            f"/api/v1/projects/{PROJECT}/traces/{TRACE}/spans/{SPAN}/attachments/{sha}",
            headers=IDENTITY,
        )

        assert response.status_code == 200
        assert response.content == data
        assert response.headers["content-type"] == mime

    def test_the_stored_type_wins_over_the_reference_hint(self, client, reader, s3):
        reader.get_span_io.return_value = _span_io(input_=_ref(mime="image/gif"))
        s3.get_object_stream.return_value = _stored(PNG, "image/png")[0]

        response = client.get(URL, headers=IDENTITY)

        assert response.status_code == 200
        assert response.headers["content-type"] == "image/png"

    def test_no_content_length_when_the_store_has_none(self, client, s3):
        s3.get_object_stream.return_value = _stored(length=False)[0]

        response = client.get(URL, headers=IDENTITY)

        assert response.status_code == 200
        assert response.content == PNG
        assert "content-length" not in response.headers


class TestNotFound:
    @pytest.mark.parametrize(
        "bad_hash",
        [
            HASH.upper(),
            HASH[:-1],
            HASH + "0",
            "g" * 64,
            "not-a-hash",
        ],
    )
    def test_malformed_hash(self, client, reader, s3, bad_hash):
        response = client.get(
            f"/api/v1/projects/{PROJECT}/traces/{TRACE}/spans/{SPAN}/attachments/{bad_hash}"
        )

        assert response.status_code == 404
        reader.get_trace_start_time.assert_not_called()
        reader.get_span_io.assert_not_called()
        s3.get_object_stream.assert_not_called()

    def test_hash_stored_but_not_referenced_by_this_span(self, client, reader, s3):
        # The object exists, but this span references a different image.
        reader.get_span_io.return_value = _span_io(input_=_ref(OTHER_HASH))

        response = client.get(URL)

        assert response.status_code == 404
        assert response.json()["detail"] == "Attachment not found"
        s3.get_object_stream.assert_not_called()

    def test_a_span_with_no_text(self, client, reader, s3):
        reader.get_span_io.return_value = _span_io()

        response = client.get(URL)

        assert response.status_code == 404
        s3.get_object_stream.assert_not_called()

    def test_a_bare_hash_without_the_reference_form_does_not_count(self, client, reader, s3):
        reader.get_span_io.return_value = _span_io(
            input_=f"{HASH} traceroot-attachment://v1/sha256/{HASH}"
        )

        response = client.get(URL)

        assert response.status_code == 404
        s3.get_object_stream.assert_not_called()

    def test_missing_span(self, client, reader, s3):
        reader.get_span_io.return_value = None

        response = client.get(URL)

        assert response.status_code == 404
        assert response.json()["detail"] == "Span not found"
        s3.get_object_stream.assert_not_called()

    def test_missing_object(self, client, s3):
        s3.get_object_stream.return_value = None

        response = client.get(URL)

        assert response.status_code == 404
        assert response.json()["detail"] == "Attachment not found"

    @pytest.mark.parametrize("content_type", ["text/html", "image/svg+xml", None])
    def test_object_stored_with_a_type_that_is_not_an_allowed_image(self, client, s3, content_type):
        stored, raw = _stored(b"<svg onload=alert(1)>", content_type)
        s3.get_object_stream.return_value = stored

        response = client.get(URL)

        assert response.status_code == 404
        assert b"svg" not in response.content
        assert raw.closed


class TestRetention:
    def test_403_outside_the_window(self, free_plan_client, reader, s3):
        reader.get_trace_start_time.return_value = datetime(2020, 1, 1)

        response = free_plan_client.get(URL)

        assert response.status_code == 403
        reader.get_trace_start_time.assert_called_once_with(PROJECT, TRACE)
        reader.get_span_io.assert_not_called()
        s3.get_object_stream.assert_not_called()

    def test_200_inside_the_window(self, free_plan_client, reader):
        reader.get_trace_start_time.return_value = datetime.now(UTC).replace(
            tzinfo=None
        ) - timedelta(days=1)

        response = free_plan_client.get(URL, headers=IDENTITY)

        assert response.status_code == 200
        assert response.content == PNG


class TestAccess:
    """The route runs the real project-access dependency: no override here."""

    @respx.mock
    @pytest.mark.parametrize(
        ("error", "expected"),
        [("No access to this project", 403), ("Project not found", 404)],
    )
    def test_another_project_is_refused(self, services, reader, s3, error, expected):
        validate = respx.post(f"{settings.traceroot_ui_url}/api/internal/validate-project-access")
        validate.mock(return_value=HttpxResponse(200, json={"hasAccess": False, "error": error}))

        client = TestClient(app, cookies={"better-auth.session_token": "signed"})
        response = client.get(
            f"/api/v1/projects/other-project/traces/{TRACE}/spans/{SPAN}/attachments/{HASH}"
        )

        assert response.status_code == expected
        body = json.loads(validate.calls.last.request.content)
        assert body == {"browserSession": True, "projectId": "other-project"}
        reader.get_span_io.assert_not_called()
        s3.get_object_stream.assert_not_called()

    def test_no_session_is_401(self, services, reader, s3):
        response = TestClient(app).get(URL)

        assert response.status_code == 401
        reader.get_span_io.assert_not_called()
        s3.get_object_stream.assert_not_called()


class TestErrors:
    def test_reader_error_is_500(self, client, reader):
        reader.get_span_io.side_effect = RuntimeError("clickhouse down")

        response = client.get(URL)

        assert response.status_code == 500
        assert response.json()["detail"] == "Failed to get span attachment"

    def test_storage_error_is_500(self, client, s3):
        s3.get_object_stream.side_effect = ClientError(
            {"Error": {"Code": "AccessDenied"}, "ResponseMetadata": {"HTTPStatusCode": 403}},
            "GetObject",
        )

        response = client.get(URL)

        assert response.status_code == 500
        assert response.json()["detail"] == "Failed to get span attachment"


class TestStreamAndClose:
    def test_closes_when_streaming_fails(self):
        body = MagicMock()
        body.iter_chunks.side_effect = OSError("connection reset")

        with pytest.raises(OSError):
            list(traces_mod._stream_and_close(body))

        body.close.assert_called_once()

    def test_closes_when_the_response_stops_early(self):
        stored, raw = _stored(b"x" * (3 * 64 * 1024))
        chunks = traces_mod._stream_and_close(stored.body)

        assert len(next(chunks)) == 64 * 1024
        chunks.close()

        assert raw.closed


class TestOpenApi:
    PATH = "/api/v1/projects/{project_id}/traces/{trace_id}/spans/{span_id}/attachments/{attachment_hash}"

    def test_kept_out_of_the_public_and_docs_specs(self):
        public = build_public_schema(app)
        assert not any("attachments" in path for path in public["paths"])
        assert not any("attachments" in path for path in build_docs_schema(public)["paths"])

    def test_registered_on_the_app(self):
        assert "get" in app.openapi()["paths"][self.PATH]
