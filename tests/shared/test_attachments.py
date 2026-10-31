"""Tests for the attachment reference format, key layout and image sniffing."""

import hashlib
import json

import pytest

from shared.attachments import (
    ALLOWED_IMAGE_MIME_TYPES,
    ATTACHMENT_KEY_PREFIX,
    ATTACHMENT_REF_PREFIX,
    ATTACHMENT_REF_RE,
    attachment_key,
    find_attachment_refs,
    format_attachment_ref,
    is_attachment_hash,
    normalize_image_mime,
    read_image_dimensions,
    sniff_image_mime,
)
from tests.fixtures.images import (
    make_gif,
    make_jpeg,
    make_png,
    make_webp_vp8,
    make_webp_vp8l,
    make_webp_vp8x,
)

HASH = hashlib.sha256(b"image bytes").hexdigest()
OTHER_HASH = hashlib.sha256(b"other bytes").hexdigest()


class TestReferenceFormat:
    def test_exact_format(self):
        assert format_attachment_ref(HASH, "image/png", 1234) == (
            f"traceroot-attachment://v1/sha256/{HASH}?bytes=1234&mime=image/png"
        )

    def test_prefix_constant_matches_the_format(self):
        assert format_attachment_ref(HASH, "image/gif", 0).startswith(ATTACHMENT_REF_PREFIX)

    @pytest.mark.parametrize("mime", sorted(ALLOWED_IMAGE_MIME_TYPES))
    def test_round_trips_through_the_regex(self, mime):
        ref = format_attachment_ref(HASH, mime, 42)
        match = ATTACHMENT_REF_RE.fullmatch(ref)
        assert match is not None
        assert match.group("sha256") == HASH
        assert match.group("mime") == mime
        assert match.group("bytes") == "42"

    @pytest.mark.parametrize("after", ["0", "2024", "9 more"])
    def test_ends_where_it_was_written_when_digits_follow(self, after):
        # An image's base64 can end in "=" padding with digits straight after it
        # in the span text; the reference that replaces it must not absorb them.
        ref = format_attachment_ref(HASH, "image/png", 42)
        match = ATTACHMENT_REF_RE.search(f"{ref}{after}")
        assert match is not None
        assert match.end() == len(ref)
        assert match.group("bytes") == "42"

    def test_survives_json_encoding_unchanged(self):
        # A reference replaces an image inside stringified JSON, so it must not
        # contain anything a JSON encoder escapes.
        ref = format_attachment_ref(HASH, "image/webp", 7)
        assert json.dumps(ref) == f'"{ref}"'
        assert json.dumps(ref, ensure_ascii=False) == f'"{ref}"'

    @pytest.mark.parametrize(
        ("sha256_hex", "mime", "byte_count"),
        [
            (HASH.upper(), "image/png", 1),
            (HASH[:-1], "image/png", 1),
            ("g" * 64, "image/png", 1),
            (HASH, "image/svg+xml", 1),
            (HASH, "image/jpg", 1),
            (HASH, "image/png", -1),
            (HASH, "image/png", True),
            (HASH, "image/png", 1.5),
        ],
    )
    def test_rejects_values_outside_the_format(self, sha256_hex, mime, byte_count):
        with pytest.raises(ValueError):
            format_attachment_ref(sha256_hex, mime, byte_count)


class TestFindAttachmentRefs:
    def test_none_and_empty(self):
        assert find_attachment_refs(None) == set()
        assert find_attachment_refs("") == set()

    def test_text_without_refs(self):
        assert find_attachment_refs("plain text, no references here") == set()

    def test_finds_every_ref_inside_json_text(self):
        first = format_attachment_ref(HASH, "image/png", 10)
        second = format_attachment_ref(OTHER_HASH, "image/jpeg", 20)
        text = json.dumps({"content": [{"url": first}, {"url": second}, {"again": first}]})
        assert find_attachment_refs(text) == {HASH, OTHER_HASH}

    def test_finds_refs_embedded_in_prose(self):
        ref = format_attachment_ref(HASH, "image/gif", 3)
        assert find_attachment_refs(f"see ({ref}) for the screenshot") == {HASH}

    @pytest.mark.parametrize(
        "text",
        [
            f"{ATTACHMENT_REF_PREFIX}{HASH}",
            f"{ATTACHMENT_REF_PREFIX}{HASH.upper()}?bytes=1&mime=image/png",
            f"{ATTACHMENT_REF_PREFIX}{HASH[:-2]}?bytes=1&mime=image/png",
            f"{ATTACHMENT_REF_PREFIX}{HASH}?bytes=1&mime=image/svg+xml",
            f"{ATTACHMENT_REF_PREFIX}{HASH}?mime=image/png",
            f"{ATTACHMENT_REF_PREFIX}{HASH}?mime=image/png&bytes=1",
            f"traceroot-attachment://v2/sha256/{HASH}?bytes=1&mime=image/png",
        ],
    )
    def test_ignores_malformed_refs(self, text):
        assert find_attachment_refs(text) == set()


class TestAttachmentKey:
    def test_layout(self):
        assert attachment_key("proj-1", HASH) == f"attachments/proj-1/sha256/{HASH}"
        assert attachment_key("proj-1", HASH).startswith(ATTACHMENT_KEY_PREFIX)

    def test_projects_never_share_a_key(self):
        assert attachment_key("proj-a", HASH) != attachment_key("proj-b", HASH)

    @pytest.mark.parametrize(
        ("project_id", "sha256_hex"),
        [
            ("", HASH),
            ("a/b", HASH),
            (None, HASH),
            ("proj-1", "not-a-hash"),
            ("proj-1", HASH.upper()),
        ],
    )
    def test_rejects_bad_parts(self, project_id, sha256_hex):
        with pytest.raises(ValueError):
            attachment_key(project_id, sha256_hex)


class TestIsAttachmentHash:
    def test_accepts_lowercase_sha256_hex(self):
        assert is_attachment_hash(HASH)

    @pytest.mark.parametrize("value", [HASH.upper(), HASH + "0", HASH[:-1], "", None, 123])
    def test_rejects_everything_else(self, value):
        assert not is_attachment_hash(value)


class TestNormalizeImageMime:
    @pytest.mark.parametrize(
        ("declared", "expected"),
        [
            ("image/png", "image/png"),
            ("IMAGE/PNG", "image/png"),
            (" image/webp ", "image/webp"),
            ("image/jpg", "image/jpeg"),
            ("image/jpeg", "image/jpeg"),
            ("image/gif", "image/gif"),
            ("image/svg+xml", None),
            ("image/bmp", None),
            ("text/plain", None),
            (None, None),
            (5, None),
        ],
    )
    def test_maps_to_allowed_types(self, declared, expected):
        assert normalize_image_mime(declared) == expected


class TestSniffImageMime:
    @pytest.mark.parametrize(
        ("data", "expected"),
        [
            (make_png(), "image/png"),
            (make_jpeg(), "image/jpeg"),
            (make_gif(), "image/gif"),
            (b"GIF87a" + make_gif()[6:], "image/gif"),
            (make_webp_vp8x(), "image/webp"),
            (make_webp_vp8l(), "image/webp"),
            (make_webp_vp8(), "image/webp"),
        ],
    )
    def test_known_types(self, data, expected):
        assert sniff_image_mime(data) == expected

    @pytest.mark.parametrize(
        "data",
        [
            b"",
            b"plain text",
            b"<svg xmlns='http://www.w3.org/2000/svg'></svg>",
            b"RIFF\x00\x00\x00\x00WAVEfmt ",
            b"\x89PNG\r\n",
            b"BM" + b"\x00" * 40,
        ],
    )
    def test_unknown_bytes(self, data):
        assert sniff_image_mime(data) is None


class TestReadImageDimensions:
    @pytest.mark.parametrize(
        ("data", "mime", "expected"),
        [
            (make_png(3, 2), "image/png", (3, 2)),
            (make_png(16384, 1), "image/png", (16384, 1)),
            (make_gif(640, 480), "image/gif", (640, 480)),
            (make_jpeg(800, 600), "image/jpeg", (800, 600)),
            (make_jpeg(20, 10, sof=0xC2), "image/jpeg", (20, 10)),
            (make_jpeg(20, 10, sof=0xCF, app_bytes=4000), "image/jpeg", (20, 10)),
            (make_webp_vp8x(1920, 1080), "image/webp", (1920, 1080)),
            (make_webp_vp8x(16777216, 1), "image/webp", (16777216, 1)),
            (make_webp_vp8l(300, 200), "image/webp", (300, 200)),
            (make_webp_vp8l(16384, 16384), "image/webp", (16384, 16384)),
            (make_webp_vp8(1024, 768), "image/webp", (1024, 768)),
        ],
    )
    def test_reads_header_size(self, data, mime, expected):
        assert read_image_dimensions(data, mime) == expected

    def test_vp8_scale_bits_are_ignored(self):
        data = bytearray(make_webp_vp8(100, 50))
        data[27] |= 0xC0  # top two bits of the width field are a scale, not size
        assert read_image_dimensions(bytes(data), "image/webp") == (100, 50)

    def test_jpeg_skips_fill_bytes_and_standalone_markers(self):
        jpeg = make_jpeg(40, 30)
        # Insert fill bytes and an RST marker between SOI and APP0.
        data = jpeg[:2] + b"\xff\xff\xd0" + jpeg[2:]
        assert read_image_dimensions(data, "image/jpeg") == (40, 30)

    def test_jpeg_skips_non_frame_markers_in_the_sof_range(self):
        # A DHT (C4) segment before the frame header must be skipped, not read.
        jpeg = make_jpeg(12, 34)
        dht = b"\xff\xc4\x00\x05\x00\x00\x00"
        data = jpeg[:2] + dht + jpeg[2:]
        assert read_image_dimensions(data, "image/jpeg") == (12, 34)

    @pytest.mark.parametrize(
        ("data", "mime"),
        [
            (make_png()[:20], "image/png"),
            (make_png()[:8] + b"\x00\x00\x00\x0dIDAT" + b"\x00" * 13, "image/png"),
            (make_gif()[:8], "image/gif"),
            (b"\xff\xd8", "image/jpeg"),
            (b"\xff\xd8\xff", "image/jpeg"),
            (b"\xff\xd8\xff\xe0\x00", "image/jpeg"),
            (b"\xff\xd8\xff\xe0\x00\x01", "image/jpeg"),
            (b"\xff\xd8\x00\x00", "image/jpeg"),
            (b"\xff\xd8\xff\x00", "image/jpeg"),
            (b"\xff\xd8\xff\xda\x00\x08", "image/jpeg"),
            (b"\xff\xd8\xff\xd9", "image/jpeg"),
            (b"\xff\xd8\xff\xe0\x00\x10" + b"\x00" * 4, "image/jpeg"),
            (make_jpeg()[:-12], "image/jpeg"),
            (make_webp_vp8x()[:28], "image/webp"),
            (make_webp_vp8l()[:22], "image/webp"),
            (make_webp_vp8l()[:20] + b"\x00" + make_webp_vp8l()[21:], "image/webp"),
            (make_webp_vp8()[:28], "image/webp"),
            (make_webp_vp8()[:23] + b"\x00\x00\x00" + make_webp_vp8()[26:], "image/webp"),
            (make_webp_vp8x()[:12] + b"ALPH" + make_webp_vp8x()[16:], "image/webp"),
            (make_png(), "image/svg+xml"),
        ],
    )
    def test_truncated_or_malformed_header_is_none(self, data, mime):
        assert read_image_dimensions(data, mime) is None
