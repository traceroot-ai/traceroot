"""Size limits on the public trace ingest request: the settings and the bounded gunzip."""

import gzip
import os
import zlib

import pytest
from pydantic import ValidationError

from shared.bounded_gzip import GzipTooLargeError, gunzip, iter_gunzip
from shared.config import IngestSettings

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
