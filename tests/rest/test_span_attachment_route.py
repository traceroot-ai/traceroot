"""Tests for GET /projects/{project_id}/traces/{trace_id}/spans/{span_id}/attachments/{hash}.

S3 is mocked, and the reader service is either mocked or the real one over a fake
spans table, so no ClickHouse or object store is needed.
"""

import hashlib
import io
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

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
    service.get_customer_trace_start_time.return_value = datetime.now(UTC).replace(tzinfo=None)
    service.get_customer_span_io.return_value = _span_io(output=json.dumps({"image": _ref()}))
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
        reader.get_customer_span_io.return_value = {**_span_io(), field: text}

        response = client.get(URL, headers=IDENTITY)

        assert response.status_code == 200
        kw = reader.get_customer_span_io.call_args.kwargs
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
        reader.get_customer_span_io.return_value = _span_io(input_=_ref(sha, mime, len(data)))
        s3.get_object_stream.return_value = _stored(data, mime)[0]

        response = client.get(
            f"/api/v1/projects/{PROJECT}/traces/{TRACE}/spans/{SPAN}/attachments/{sha}",
            headers=IDENTITY,
        )

        assert response.status_code == 200
        assert response.content == data
        assert response.headers["content-type"] == mime

    def test_the_stored_type_wins_over_the_reference_hint(self, client, reader, s3):
        reader.get_customer_span_io.return_value = _span_io(input_=_ref(mime="image/gif"))
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
        reader.get_customer_trace_start_time.assert_not_called()
        reader.get_customer_span_io.assert_not_called()
        s3.get_object_stream.assert_not_called()

    def test_hash_stored_but_not_referenced_by_this_span(self, client, reader, s3):
        # The object exists, but this span references a different image.
        reader.get_customer_span_io.return_value = _span_io(input_=_ref(OTHER_HASH))

        response = client.get(URL)

        assert response.status_code == 404
        assert response.json()["detail"] == "Attachment not found"
        s3.get_object_stream.assert_not_called()

    def test_a_span_with_no_text(self, client, reader, s3):
        reader.get_customer_span_io.return_value = _span_io()

        response = client.get(URL)

        assert response.status_code == 404
        s3.get_object_stream.assert_not_called()

    def test_a_bare_hash_without_the_reference_form_does_not_count(self, client, reader, s3):
        reader.get_customer_span_io.return_value = _span_io(
            input_=f"{HASH} traceroot-attachment://v1/sha256/{HASH}"
        )

        response = client.get(URL)

        assert response.status_code == 404
        s3.get_object_stream.assert_not_called()

    def test_missing_span(self, client, reader, s3):
        reader.get_customer_span_io.return_value = None

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
        reader.get_customer_trace_start_time.return_value = datetime(2020, 1, 1)

        response = free_plan_client.get(URL)

        assert response.status_code == 403
        reader.get_customer_trace_start_time.assert_called_once_with(PROJECT, TRACE)
        reader.get_customer_trace_earliest_span_time.assert_not_called()
        reader.get_customer_span_io.assert_not_called()
        s3.get_object_stream.assert_not_called()

    def test_200_inside_the_window(self, free_plan_client, reader):
        reader.get_customer_trace_start_time.return_value = datetime.now(UTC).replace(
            tzinfo=None
        ) - timedelta(days=1)

        response = free_plan_client.get(URL, headers=IDENTITY)

        assert response.status_code == 200
        assert response.content == PNG

    def test_a_trace_without_its_root_is_judged_by_its_earliest_span(
        self, free_plan_client, reader, s3
    ):
        reader.get_customer_trace_start_time.return_value = None
        reader.get_customer_trace_earliest_span_time.return_value = datetime(2020, 1, 1)

        response = free_plan_client.get(URL)

        assert response.status_code == 403
        reader.get_customer_trace_earliest_span_time.assert_called_once_with(PROJECT, TRACE)
        reader.get_customer_span_io.assert_not_called()
        s3.get_object_stream.assert_not_called()

    def test_a_trace_without_its_root_inside_the_window_is_served(self, free_plan_client, reader):
        reader.get_customer_trace_start_time.return_value = None
        reader.get_customer_trace_earliest_span_time.return_value = _days_ago(1)

        response = free_plan_client.get(URL, headers=IDENTITY)

        assert response.status_code == 200
        assert response.content == PNG

    def test_a_trace_with_no_span_is_refused_before_any_read(self, client, reader, s3):
        # Even with unlimited retention: no start time at all is never a pass.
        reader.get_customer_trace_start_time.return_value = None
        reader.get_customer_trace_earliest_span_time.return_value = None

        response = client.get(URL)

        assert response.status_code == 404
        assert response.json()["detail"] == "Span not found"
        reader.get_customer_span_io.assert_not_called()
        s3.get_object_stream.assert_not_called()


ROOT = "root-a"


class FakeSpansTable:
    """Answers the reader's retention and span I/O queries from a list of span rows.

    Every ``ingest`` adds a row, so ingesting a span again stores a newer version
    beside the old one, as ClickHouse does until it merges them. A query keeps only
    each span's latest version when it asks to (``LIMIT 1 BY span_id``), and only
    customer spans when it asks for ``source = 'user'``. Only the query shapes this
    route reaches are recognised; anything else fails. ``queries`` records which
    of them ran, in order.
    """

    def __init__(self):
        self.rows: list[dict] = []
        self.queries: list[str] = []

    def ingest(
        self,
        span_id: str,
        start: datetime,
        parent: str | None,
        output: str | None = None,
        source: str = "user",
    ):
        self.rows.append(
            {
                "span_id": span_id,
                "start": start,
                "parent": parent,
                "output": output,
                "source": source,
            }
        )

    def _visible(self, query: str) -> list[dict]:
        rows = self.rows
        if "source = 'user'" in query:
            rows = [row for row in rows if row["source"] == "user"]
        if "LIMIT 1 BY span_id" not in query:
            return rows
        latest = {row["span_id"]: row for row in rows}  # later rows are newer
        return list(latest.values())

    def query(self, query: str, parameters: dict):
        assert parameters["project_id"] == PROJECT and parameters["trace_id"] == TRACE
        rows = self._visible(query)
        if "isNull(parent_span_id)" in query:
            self.queries.append("root")
            starts = [row["start"] for row in rows if row["parent"] is None]
            return SimpleNamespace(result_rows=[(min(starts, default=None),)])
        if "SELECT span_id, trace_id, input, output, metadata" in query:
            self.queries.append("span")
            latest = [row for row in rows if row["span_id"] == parameters["span_id"]][-1:]
            return SimpleNamespace(
                result_rows=[(row["span_id"], TRACE, None, row["output"], None) for row in latest]
            )
        if "minOrNull(span_start_time)" in query:
            self.queries.append("earliest")
            starts = [row["start"] for row in rows]
            return SimpleNamespace(result_rows=[(min(starts, default=None),)])
        raise AssertionError(f"unexpected query: {query}")


def _days_ago(days: int) -> datetime:
    return datetime.now(UTC).replace(tzinfo=None) - timedelta(days=days)


@pytest.fixture()
def spans_table(monkeypatch, s3):
    """The real reader service over a fake spans table, behind a free-plan project."""
    from rest.services.trace_reader import TraceReaderService

    table = FakeSpansTable()
    with patch("rest.services.trace_reader.get_clickhouse_client", return_value=table):
        service = TraceReaderService()
    monkeypatch.setattr(traces_mod, "get_trace_reader_service", lambda: service)
    monkeypatch.setattr(traces_mod, "get_s3_service", lambda: s3)
    s3.get_object_stream.side_effect = lambda key: _stored()[0]
    app.dependency_overrides[get_project_access] = _access("free")
    return table


class TestRetentionWhenTheRootIsMissing:
    """Through the real reader, so its caching is part of what is tested."""

    def test_a_read_before_an_old_root_arrives_does_not_hide_it(self, spans_table, s3):
        client = TestClient(app)
        assert client.get(URL).status_code == 404

        spans_table.ingest(ROOT, _days_ago(200), parent=None)
        spans_table.ingest(SPAN, _days_ago(200), parent=ROOT, output=_ref())
        spans_table.queries.clear()
        response = client.get(URL)

        assert response.status_code == 403
        # The root is read again, not remembered as missing, and its start decides.
        # The earliest-span fallback would refuse too, since the root is one of the
        # spans it reads, so only the queries that ran tell the two apart.
        assert spans_table.queries == ["root"]
        s3.get_object_stream.assert_not_called()

    def test_an_old_span_whose_root_never_arrives(self, spans_table, s3):
        spans_table.ingest(SPAN, _days_ago(200), parent="never-sent", output=_ref())

        response = TestClient(app).get(URL)

        assert response.status_code == 403
        s3.get_object_stream.assert_not_called()

    def test_a_recent_span_whose_root_has_not_arrived_is_served(self, spans_table):
        spans_table.ingest(SPAN, _days_ago(1), parent="still-running", output=_ref())

        response = TestClient(app).get(URL, headers=IDENTITY)

        assert response.status_code == 200
        assert response.content == PNG

    def test_an_old_root_that_arrives_late_still_applies(self, spans_table):
        client = TestClient(app)
        spans_table.ingest(SPAN, _days_ago(1), parent=ROOT, output=_ref())
        assert client.get(URL, headers=IDENTITY).status_code == 200

        spans_table.ingest(ROOT, _days_ago(200), parent=None)
        spans_table.queries.clear()

        assert client.get(URL).status_code == 403
        assert spans_table.queries == ["root"]

    def test_only_the_latest_version_of_a_span_counts(self, spans_table):
        # The same rootless span, stored again with a later start: the obsolete
        # version still sits beside it until ClickHouse merges them.
        spans_table.ingest(SPAN, _days_ago(200), parent="still-running", output=_ref())
        spans_table.ingest(SPAN, _days_ago(1), parent="still-running", output=_ref())

        response = TestClient(app).get(URL, headers=IDENTITY)

        assert response.status_code == 200
        assert response.content == PNG

    def test_an_old_trace_with_its_root(self, spans_table, s3):
        spans_table.ingest(ROOT, _days_ago(200), parent=None)
        spans_table.ingest(SPAN, _days_ago(200), parent=ROOT, output=_ref())

        response = TestClient(app).get(URL)

        assert response.status_code == 403
        s3.get_object_stream.assert_not_called()


class TestInternalSpans:
    """A span stored under an internal source neither serves an image nor judges
    retention. Its text can quote a reference copied from another trace, whose age
    its own trace's start says nothing about."""

    @pytest.mark.parametrize("source", ["agent", "detector"])
    def test_a_reference_only_an_internal_trace_holds_is_not_served(self, spans_table, s3, source):
        spans_table.ingest(ROOT, _days_ago(1), parent=None, source=source)
        spans_table.ingest(SPAN, _days_ago(1), parent=ROOT, output=_ref(), source=source)

        response = TestClient(app).get(URL)

        assert response.status_code == 404
        assert response.json()["detail"] == "Span not found"
        s3.get_object_stream.assert_not_called()

    @pytest.mark.parametrize("source", ["agent", "detector"])
    def test_an_internal_span_beside_customer_spans_is_not_served(self, spans_table, s3, source):
        spans_table.ingest(ROOT, _days_ago(1), parent=None)
        spans_table.ingest(SPAN, _days_ago(1), parent=ROOT, output=_ref(), source=source)

        response = TestClient(app).get(URL)

        assert response.status_code == 404
        assert response.json()["detail"] == "Span not found"
        s3.get_object_stream.assert_not_called()

    def test_a_customer_span_is_served(self, spans_table):
        spans_table.ingest(ROOT, _days_ago(1), parent=None)
        spans_table.ingest(SPAN, _days_ago(1), parent=ROOT, output=_ref())

        response = TestClient(app).get(URL, headers=IDENTITY)

        assert response.status_code == 200
        assert response.content == PNG

    @pytest.mark.parametrize("source", ["agent", "detector"])
    def test_a_recent_internal_root_does_not_let_an_expired_image_through(
        self, spans_table, s3, source
    ):
        spans_table.ingest(ROOT, _days_ago(1), parent=None, source=source)
        spans_table.ingest(SPAN, _days_ago(200), parent=ROOT, output=_ref())

        response = TestClient(app).get(URL)

        assert response.status_code == 403
        s3.get_object_stream.assert_not_called()

    @pytest.mark.parametrize("source", ["agent", "detector"])
    def test_an_old_internal_span_does_not_move_the_earliest_start(self, spans_table, source):
        spans_table.ingest("internal-a", _days_ago(200), parent="internal-root", source=source)
        spans_table.ingest(SPAN, _days_ago(1), parent="still-running", output=_ref())

        response = TestClient(app).get(URL, headers=IDENTITY)

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
        reader.get_customer_span_io.assert_not_called()
        s3.get_object_stream.assert_not_called()

    def test_no_session_is_401(self, services, reader, s3):
        response = TestClient(app).get(URL)

        assert response.status_code == 401
        reader.get_customer_span_io.assert_not_called()
        s3.get_object_stream.assert_not_called()


class TestErrors:
    def test_reader_error_is_500(self, client, reader):
        reader.get_customer_span_io.side_effect = RuntimeError("clickhouse down")

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
