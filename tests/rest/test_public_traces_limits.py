"""Size limits on the public trace ingest request: the settings, the bounded gunzip,
and the route that applies both."""

import gzip
import os
import random
import time
import zlib
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from rest.main import app
from rest.openapi_public import build_public_schema
from rest.routers.public.traces import AuthResult, _read_capped_body, authenticate_api_key
from shared.bounded_gzip import (
    _MAX_MEMBERS,
    _WINDOW_BYTES,
    GzipTooLargeError,
    GzipTooManyMembersError,
    gunzip,
    iter_gunzip,
)
from shared.config import IngestSettings, settings

MIB = 1024 * 1024


class TestIngestSettings:
    def test_defaults(self, monkeypatch):
        monkeypatch.delenv("INGEST_MAX_REQUEST_BYTES", raising=False)
        monkeypatch.delenv("INGEST_MAX_UNZIPPED_BYTES", raising=False)
        limits = IngestSettings()
        assert limits.max_request_bytes == 16 * MIB
        assert limits.max_unzipped_bytes == 32 * MIB

    def test_limits_come_from_env(self, monkeypatch):
        monkeypatch.setenv("INGEST_MAX_REQUEST_BYTES", "1234")
        monkeypatch.setenv("INGEST_MAX_UNZIPPED_BYTES", "5678")
        limits = IngestSettings()
        assert limits.max_request_bytes == 1234
        assert limits.max_unzipped_bytes == 5678

    @pytest.mark.parametrize("name", ["INGEST_MAX_REQUEST_BYTES", "INGEST_MAX_UNZIPPED_BYTES"])
    def test_zero_limit_is_refused(self, monkeypatch, name):
        monkeypatch.setenv(name, "0")
        with pytest.raises(ValidationError):
            IngestSettings()


class TestGunzip:
    def test_round_trip_matches_gzip_decompress(self):
        data = b"otlp-bytes " * 1000
        assert gunzip(gzip.compress(data), MIB) == data

    def test_incompressible_data_larger_than_one_chunk(self):
        data = os.urandom(300 * 1024)
        assert gunzip(gzip.compress(data), MIB) == data

    def test_concatenated_members_are_joined(self):
        body = gzip.compress(b"first ") + gzip.compress(b"second")
        assert gunzip(body, MIB) == gzip.decompress(body) == b"first second"

    def test_nul_padding_after_a_member_is_ignored(self):
        body = gzip.compress(b"payload") + b"\x00" * 16
        assert gunzip(body, MIB) == gzip.decompress(body) == b"payload"

    def test_empty_input_is_empty_output(self):
        assert gunzip(b"", MIB) == b""

    def test_output_exactly_at_the_limit_is_accepted(self):
        data = b"x" * 4096
        assert gunzip(gzip.compress(data), 4096) == data

    def test_output_one_byte_over_the_limit_is_refused(self):
        with pytest.raises(GzipTooLargeError) as exc:
            gunzip(gzip.compress(b"x" * 4097), 4096)
        assert exc.value.max_bytes == 4096

    def test_limit_counts_every_member(self):
        body = gzip.compress(b"a" * 3000) + gzip.compress(b"b" * 3000)
        with pytest.raises(GzipTooLargeError):
            gunzip(body, 4096)

    def test_bomb_stops_at_the_limit(self):
        """64 MiB of zeros compresses to about 64 KiB. Inflation stops just past the
        limit: nothing over it is ever yielded, and no chunk is larger than 64 KiB."""
        bomb = gzip.compress(b"\x00" * (64 * MIB))
        assert len(bomb) < MIB
        limit = MIB
        yielded = 0
        with pytest.raises(GzipTooLargeError):
            for chunk in iter_gunzip(bomb, limit):
                assert len(chunk) <= 64 * 1024
                yielded += len(chunk)
        assert yielded <= limit

    def test_not_gzip_raises(self):
        with pytest.raises(zlib.error):
            gunzip(b"not-gzip-data", MIB)

    def test_truncated_stream_raises(self):
        body = gzip.compress(os.urandom(4096))
        with pytest.raises(EOFError):
            gunzip(body[: len(body) // 2], MIB)

    def test_checksum_mismatch_raises(self):
        body = bytearray(gzip.compress(b"payload"))
        body[-8] ^= 0xFF  # first byte of the CRC32 trailer
        with pytest.raises(zlib.error):
            gunzip(bytes(body), MIB)

    def test_garbage_after_a_member_raises(self):
        with pytest.raises(zlib.error):
            gunzip(gzip.compress(b"payload") + b"garbage-tail", MIB)

    def test_members_up_to_the_cap_are_joined(self):
        body = b"".join(gzip.compress(b"member %d " % i) for i in range(_MAX_MEMBERS))
        assert gunzip(body, MIB) == gzip.decompress(body)

    def test_one_member_past_the_cap_is_invalid_gzip(self):
        body = gzip.compress(b"payload") * (_MAX_MEMBERS + 1)
        with pytest.raises(GzipTooManyMembersError) as exc:
            gunzip(body, MIB)
        assert isinstance(exc.value, zlib.error)
        assert exc.value.max_members == _MAX_MEMBERS

    def test_a_body_of_many_empty_members_is_refused_quickly(self):
        """Each member needs a new inflater, so a body of empty members is refused once
        past the cap instead of being walked member by member."""
        body = gzip.compress(b"") * (16 * MIB // 20)
        start = time.perf_counter()
        with pytest.raises(GzipTooManyMembersError):
            gunzip(body, 32 * MIB)
        assert time.perf_counter() - start < 1.0

    def test_nul_padding_longer_than_an_input_window_is_ignored(self):
        body = gzip.compress(b"first ") + b"\x00" * (3 * _WINDOW_BYTES + 5)
        body += gzip.compress(b"second") + b"\x00" * _WINDOW_BYTES
        assert gunzip(body, MIB) == gzip.decompress(body) == b"first second"

    def test_members_that_cross_input_windows_are_joined(self):
        parts = [os.urandom(_WINDOW_BYTES + 123), os.urandom(7), os.urandom(2 * _WINDOW_BYTES)]
        body = b"".join(gzip.compress(part) for part in parts)
        assert gunzip(body, MIB) == gzip.decompress(body) == b"".join(parts)

    def test_zlib_is_never_handed_more_than_one_input_window(self, monkeypatch):
        """zlib copies the input it hasn't used on every call, so handing it the rest
        of the body would make each output chunk cost a copy of that rest."""
        sizes = []
        real_decompressobj = zlib.decompressobj

        class RecordingInflater:
            def __init__(self, wbits):
                self._inflater = real_decompressobj(wbits)

            def decompress(self, data, max_length):
                sizes.append(len(data))
                return self._inflater.decompress(data, max_length)

            def __getattr__(self, name):
                return getattr(self._inflater, name)

        data = os.urandom(2 * MIB) + b"\x00" * (2 * MIB)
        body = gzip.compress(data, compresslevel=1) + gzip.compress(b"tail")
        monkeypatch.setattr(zlib, "decompressobj", RecordingInflater)
        assert gunzip(body, 8 * MIB) == data + b"tail"
        assert max(sizes) <= _WINDOW_BYTES


def _near_cap_data(size: int) -> bytes:
    """``size`` bytes that gzip to about 60% of their size: random runs between zeros."""
    rng = random.Random(size)
    blocks = (rng.randbytes(40 * 1024) + bytes(24 * 1024) for _ in range(size // (64 * 1024) + 1))
    return b"".join(blocks)[:size]


class TestGunzipNearTheUnzippedCap:
    CAP = 32 * MIB

    @pytest.mark.parametrize("size", [CAP - 1, CAP])
    def test_single_member_matches_gzip_decompress(self, size):
        body = gzip.compress(_near_cap_data(size), compresslevel=1)
        assert gunzip(body, self.CAP) == gzip.decompress(body)

    def test_single_member_one_byte_past_the_cap_is_refused(self):
        body = gzip.compress(_near_cap_data(self.CAP + 1), compresslevel=1)
        with pytest.raises(GzipTooLargeError):
            gunzip(body, self.CAP)


REQUEST_CAP = 1024
UNZIPPED_CAP = 4096
INGEST_URL = "/api/v1/public/traces"
PROTOBUF = {"Content-Type": "application/x-protobuf"}
GZIP_PROTOBUF = {**PROTOBUF, "Content-Encoding": "gzip"}


@pytest.fixture()
def ingest(monkeypatch):
    """The ingest route with small caps, auth stubbed, and decode, S3 and Celery mocked."""
    monkeypatch.setattr(settings.ingest, "max_request_bytes", REQUEST_CAP)
    monkeypatch.setattr(settings.ingest, "max_unzipped_bytes", UNZIPPED_CAP)
    app.dependency_overrides[authenticate_api_key] = lambda: AuthResult(
        project_id="test-project",
        workspace_id="test-workspace",
        billing_plan="pro",
        ingestion_blocked=False,
    )
    decode = MagicMock(return_value={"resourceSpans": []})
    monkeypatch.setattr("rest.routers.public.traces.decode_otlp_protobuf", decode)
    s3 = MagicMock()
    monkeypatch.setattr("rest.routers.public.traces.get_s3_service", lambda: s3)
    task = MagicMock()
    monkeypatch.setattr("rest.routers.public.traces.process_s3_traces", task)
    return TestClient(app), decode, s3, task


def _chunks(total: int, size: int = 256):
    sent = 0
    while sent < total:
        n = min(size, total - sent)
        sent += n
        yield b"x" * n


class TestRequestSizeLimit:
    def test_body_at_the_cap_is_accepted(self, ingest):
        client, decode, s3, task = ingest
        response = client.post(INGEST_URL, content=b"x" * REQUEST_CAP, headers=PROTOBUF)
        assert response.status_code == 200
        decode.assert_called_once_with(b"x" * REQUEST_CAP)
        s3.upload_json.assert_called_once()
        task.delay.assert_called_once()

    def test_body_over_the_cap_is_413(self, ingest):
        client, decode, s3, task = ingest
        response = client.post(INGEST_URL, content=b"x" * (REQUEST_CAP + 1), headers=PROTOBUF)
        assert response.status_code == 413
        assert response.json()["detail"] == f"Request body exceeds {REQUEST_CAP} bytes"
        decode.assert_not_called()
        s3.upload_json.assert_not_called()
        task.delay.assert_not_called()

    def test_chunked_body_over_the_cap_is_413(self, ingest):
        """A chunked body has no Content-Length; the running count still stops it."""
        client, decode, s3, _ = ingest
        response = client.post(INGEST_URL, content=_chunks(REQUEST_CAP * 4), headers=PROTOBUF)
        assert response.status_code == 413
        decode.assert_not_called()
        s3.upload_json.assert_not_called()

    def test_chunked_body_under_the_cap_is_accepted(self, ingest):
        client, decode, _, _ = ingest
        response = client.post(INGEST_URL, content=_chunks(REQUEST_CAP - 10), headers=PROTOBUF)
        assert response.status_code == 200
        decode.assert_called_once_with(b"x" * (REQUEST_CAP - 10))

    def test_cap_applies_to_the_compressed_bytes(self, ingest):
        """The request cap measures the body as sent, so incompressible gzip over it is
        refused even though the unzipped cap is larger."""
        client, decode, _, _ = ingest
        body = gzip.compress(os.urandom(REQUEST_CAP * 2))
        response = client.post(INGEST_URL, content=body, headers=GZIP_PROTOBUF)
        assert response.status_code == 413
        decode.assert_not_called()


class TestUnzippedSizeLimit:
    def test_gzip_under_the_cap_is_decoded(self, ingest):
        client, decode, _, _ = ingest
        raw = b"y" * UNZIPPED_CAP
        response = client.post(INGEST_URL, content=gzip.compress(raw), headers=GZIP_PROTOBUF)
        assert response.status_code == 200
        decode.assert_called_once_with(raw)

    def test_gzip_that_unzips_past_the_cap_is_413(self, ingest):
        client, decode, s3, task = ingest
        body = gzip.compress(b"\x00" * (UNZIPPED_CAP * 100))
        assert len(body) <= REQUEST_CAP
        response = client.post(INGEST_URL, content=body, headers=GZIP_PROTOBUF)
        assert response.status_code == 413
        assert response.json()["detail"] == (
            f"Decompressed request body exceeds {UNZIPPED_CAP} bytes"
        )
        decode.assert_not_called()
        s3.upload_json.assert_not_called()
        task.delay.assert_not_called()

    def test_invalid_gzip_is_still_400(self, ingest):
        client, decode, _, _ = ingest
        response = client.post(INGEST_URL, content=b"not-gzip-data", headers=GZIP_PROTOBUF)
        assert response.status_code == 400
        assert response.json()["detail"] == "Invalid gzip payload"
        decode.assert_not_called()

    def test_truncated_gzip_is_400(self, ingest):
        client, _, _, _ = ingest
        body = gzip.compress(os.urandom(512))
        response = client.post(INGEST_URL, content=body[:-20], headers=GZIP_PROTOBUF)
        assert response.status_code == 400
        assert response.json()["detail"] == "Invalid gzip payload"


class _FakeRequest:
    """Just enough of a Starlette request for ``_read_capped_body``."""

    def __init__(self, headers: dict[str, str], chunks: list[bytes]):
        self.headers = headers
        self._chunks = chunks
        self.chunks_read = 0

    async def stream(self):
        for chunk in self._chunks:
            self.chunks_read += 1
            yield chunk


class TestReadCappedBody:
    async def test_declared_length_over_the_cap_is_refused_before_reading(self):
        request = _FakeRequest({"content-length": str(64 * MIB)}, [b"x"])
        with pytest.raises(HTTPException) as exc:
            await _read_capped_body(request, 16)
        assert exc.value.status_code == 413
        assert request.chunks_read == 0

    async def test_understated_length_is_caught_by_the_running_count(self):
        request = _FakeRequest({"content-length": "4"}, [b"x" * 10, b"x" * 10])
        with pytest.raises(HTTPException) as exc:
            await _read_capped_body(request, 16)
        assert exc.value.status_code == 413
        assert request.chunks_read == 2

    async def test_unparseable_length_falls_back_to_the_running_count(self):
        request = _FakeRequest({"content-length": "lots"}, [b"ab", b"cd"])
        assert await _read_capped_body(request, 16) == b"abcd"

    async def test_body_without_a_length_is_joined(self):
        request = _FakeRequest({}, [b"ab", b"", b"cd"])
        assert await _read_capped_body(request, 4) == b"abcd"


def test_public_schema_documents_the_413():
    responses = build_public_schema(app)["paths"]["/api/v1/public/traces"]["post"]["responses"]
    assert responses["413"]["description"] == "Request body too large"


def test_gzip_of_more_members_than_the_cap_is_400(ingest):
    client = ingest[0]
    body = gzip.compress(b"") * (_MAX_MEMBERS + 1)
    response = client.post(INGEST_URL, content=body, headers=GZIP_PROTOBUF)
    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid gzip payload"
