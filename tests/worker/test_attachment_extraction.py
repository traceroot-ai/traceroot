"""Tests for moving span images into attachments at ingest."""

import base64
import copy
import hashlib
import itertools
import json
import struct
from unittest.mock import MagicMock

import boto3
import pytest
from botocore.exceptions import ClientError
from botocore.stub import Stubber
from pydantic import ValidationError

from rest.services.s3 import S3Service
from shared.attachments import (
    ATTACHMENT_REF_PREFIX,
    attachment_key,
    find_attachment_refs,
    format_attachment_ref,
    read_image_dimensions,
    sniff_image_mime,
)
from shared.config import AttachmentSettings, settings
from tests.fixtures.images import (
    b64,
    data_url,
    make_gif,
    make_jpeg,
    make_png,
    make_webp_vp8,
    make_webp_vp8l,
    make_webp_vp8x,
)
from tests.fixtures.otel_payloads import make_attr, make_otel_payload, make_span
from worker import attachment_extraction
from worker.attachment_extraction import (
    _MIN_IMAGE_BYTES,
    TRUNCATION_MARKER,
    AttachmentExtractor,
    _could_be_image,
    _cut_to_size,
    _enforce_size_limit,
    _strict_b64decode,
    extract_attachments,
)

PROJECT = "proj-1"


class FakeS3:
    """In-memory stand-in for S3Service's attachment methods."""

    def __init__(self, put_error: Exception | None = None, fail_after_puts: int = 0):
        self.objects: dict[str, tuple[bytes, str]] = {}
        self.heads: list[str] = []
        self.puts: list[str] = []
        self._put_error = put_error
        self._fail_after_puts = fail_after_puts

    def object_exists(self, key: str) -> bool:
        self.heads.append(key)
        return key in self.objects

    def put_object_if_absent(self, key: str, body: bytes, content_type: str) -> bool:
        if self._put_error is not None and len(self.puts) >= self._fail_after_puts:
            raise self._put_error
        self.puts.append(key)
        if key in self.objects:
            return False
        self.objects[key] = (body, content_type)
        return True


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def ref_for(data: bytes, mime: str) -> str:
    return format_attachment_ref(sha(data), mime, len(data))


def span(**fields) -> dict:
    return {"span_id": "span-a", "trace_id": "trace-a", **fields}


def utf8_total(row: dict) -> int:
    return sum(
        len(row[name].encode("utf-8"))
        for name in ("input", "output", "metadata")
        if isinstance(row.get(name), str)
    )


def marker(limit: int) -> str:
    return TRUNCATION_MARKER.format(limit=limit)


def png_header(width: int, height: int = 1) -> bytes:
    """The first 24 bytes of a PNG, which is all the header checks read."""
    return b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0dIHDR" + struct.pack(">II", width, height)


def keep_first(text: str, max_chars: int) -> str:
    """Cut ``text`` the way a client does that keeps only its first characters."""
    return f"{text[:max_chars]}…[truncated {len(text) - max_chars} chars]"


def keep_both_ends(text: str, max_chars: int) -> str:
    """Cut ``text`` the way a client does that keeps both ends and drops the middle."""
    half = max_chars // 2
    return f"{text[:half]}\n…[{len(text)} chars, middle elided]…\n{text[-half:]}"


IMAGES = [
    pytest.param(make_png(4, 3), "image/png", id="png"),
    pytest.param(make_jpeg(8, 6), "image/jpeg", id="jpeg"),
    pytest.param(make_gif(5, 5), "image/gif", id="gif"),
    pytest.param(make_webp_vp8x(10, 10), "image/webp", id="webp-vp8x"),
    pytest.param(make_webp_vp8l(10, 10), "image/webp", id="webp-vp8l"),
    pytest.param(make_webp_vp8(10, 10), "image/webp", id="webp-vp8"),
]


class TestDataUrls:
    @pytest.mark.parametrize(("image", "mime"), IMAGES)
    @pytest.mark.parametrize("field", ["input", "output", "metadata"])
    def test_each_type_in_each_field_is_stored_and_referenced(self, image, mime, field):
        s3 = FakeS3()
        row = span(**{field: f"look: {data_url(image, mime)} done"})

        result = extract_attachments(s3, PROJECT, [], [row])

        assert row[field] == f"look: {ref_for(image, mime)} done"
        key = attachment_key(PROJECT, sha(image))
        assert s3.objects == {key: (image, mime)}
        assert result.referenced == 1
        assert result.stored == 1

    def test_a_few_kb_image(self):
        image = make_png(2, 2, pad=4000)
        assert 4000 < len(image) < 5000
        s3 = FakeS3()
        row = span(input=data_url(image, "image/png"))

        extract_attachments(s3, PROJECT, [], [row])

        assert row["input"] == ref_for(image, "image/png")
        assert len(s3.objects) == 1

    def test_jpg_alias_is_stored_as_jpeg(self):
        image = make_jpeg()
        s3 = FakeS3()
        row = span(input=data_url(image, "image/jpg"))

        extract_attachments(s3, PROJECT, [], [row])

        assert row["input"] == ref_for(image, "image/jpeg")
        assert list(s3.objects.values()) == [(image, "image/jpeg")]

    def test_subtype_case_is_ignored(self):
        image = make_png()
        row = span(input=data_url(image, "image/PNG"))

        extract_attachments(FakeS3(), PROJECT, [], [row])

        assert row["input"] == ref_for(image, "image/png")

    def test_svg_and_other_types_are_left_alone(self):
        text = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4= and data:image/bmp;base64,Qk0="
        row = span(input=text)

        extract_attachments(FakeS3(), PROJECT, [], [row])

        assert row["input"] is text

    def test_several_images_in_one_field(self):
        png, gif = make_png(), make_gif()
        s3 = FakeS3()
        row = span(output=f"a {data_url(png, 'image/png')} b {data_url(gif, 'image/gif')} c")

        result = extract_attachments(s3, PROJECT, [], [row])

        assert row["output"] == f"a {ref_for(png, 'image/png')} b {ref_for(gif, 'image/gif')} c"
        assert find_attachment_refs(row["output"]) == {sha(png), sha(gif)}
        assert result.referenced == 2

    @pytest.mark.parametrize("ensure_ascii", [True, False])
    @pytest.mark.parametrize("indent", [None, 2])
    def test_inside_stringified_json_keeps_it_valid(self, ensure_ascii, indent):
        image = make_webp_vp8l(3, 3)
        url = data_url(image, "image/webp")
        payload = {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": 'café "quoted" \\ line\nnext'},
                        {"type": "image_url", "image_url": {"url": url}},
                    ],
                }
            ]
        }
        text = json.dumps(payload, ensure_ascii=ensure_ascii, indent=indent)
        row = span(input=text)

        extract_attachments(FakeS3(), PROJECT, [], [row])

        assert row["input"] == text.replace(url, ref_for(image, "image/webp"))
        parsed = json.loads(row["input"])
        expected = copy.deepcopy(payload)
        expected["messages"][0]["content"][1]["image_url"]["url"] = ref_for(image, "image/webp")
        assert parsed == expected

    def test_inside_double_encoded_json_keeps_it_valid(self):
        # A data URL holds nothing a JSON string must escape, so it is found and
        # replaced even inside JSON that was encoded twice, and both layers stay valid.
        image = make_png()
        inner = json.dumps({"url": data_url(image, "image/png")})
        text = json.dumps({"messages": [inner]})
        row = span(input=text)

        extract_attachments(FakeS3(), PROJECT, [], [row])

        outer = json.loads(row["input"])
        assert json.loads(outer["messages"][0]) == {"url": ref_for(image, "image/png")}


def wrapped_data_url(data: bytes, mime: str, width: int, newline: str) -> str:
    """A data URL whose base64 is split into lines of ``width`` characters."""
    text = b64(data)
    lines = [text[start : start + width] for start in range(0, len(text), width)]
    return f"data:{mime};base64," + newline.join(lines)


# Each one's base64 spans several lines at both wrap widths.
WRAPPED_IMAGES = [
    pytest.param(make_png(8, 8), "image/png", id="png"),
    pytest.param(make_gif(5, 5, pad=100), "image/gif", id="gif"),
    pytest.param(make_webp_vp8x(10, 10, pad=100), "image/webp", id="webp"),
    pytest.param(make_jpeg(8, 6, app_bytes=200), "image/jpeg", id="jpeg"),
]
# In the last one's URL-safe base64, the run before the first "-" or "_" is strict
# base64 of a whole PNG header.
URL_SAFE_IMAGES = [
    *WRAPPED_IMAGES,
    pytest.param(make_png(2, 1), "image/png", id="png-header-before-the-first-dash"),
]
# The byte count is a multiple of 3, so its base64 has no padding.
UNPADDED_PNG = make_png(1, 1, pad=101)
ENCODINGS = [
    pytest.param(lambda text: text, id="raw"),
    pytest.param(lambda text: json.dumps({"url": text}), id="json"),
    pytest.param(lambda text: json.dumps([json.dumps({"url": text})]), id="json-twice"),
]


def unicode_escaped_json(text: str, hex_digit: str = "a") -> str:
    """``{"url": text}`` from an encoder that writes LF as ``\\u000a`` and CR as ``\\u000d``."""
    return (
        json.dumps({"url": text})
        .replace("\\n", "\\u000" + hex_digit)
        .replace("\\r", "\\u000" + chr(ord(hex_digit) + 3))
    )


UNICODE_ESCAPED_ENCODINGS = [
    pytest.param(unicode_escaped_json, id="json"),
    pytest.param(lambda text: unicode_escaped_json(text, "A"), id="json-uppercase"),
    pytest.param(lambda text: json.dumps([unicode_escaped_json(text)]), id="json-twice"),
]


class TestWrappedAndUrlSafeDataUrls:
    @pytest.mark.parametrize(("image", "mime"), WRAPPED_IMAGES)
    @pytest.mark.parametrize("width", [64, 76])
    @pytest.mark.parametrize("newline", ["\n", "\r\n"], ids=["lf", "crlf"])
    @pytest.mark.parametrize("encode", ENCODINGS)
    def test_wrapped_base64_is_left_untouched(self, image, mime, width, newline, encode):
        url = wrapped_data_url(image, mime, width, newline)
        assert newline in url
        text = encode(f"look: {url} done")
        s3 = FakeS3()
        row = span(input=text)

        result = extract_attachments(s3, PROJECT, [], [row])

        assert row["input"] == text
        assert s3.heads == []
        assert (result.referenced, result.omitted) == (0, 0)

    @pytest.mark.parametrize(("image", "mime"), WRAPPED_IMAGES)
    @pytest.mark.parametrize("newline", ["\n", "\r\n"], ids=["lf", "crlf"])
    @pytest.mark.parametrize("encode", UNICODE_ESCAPED_ENCODINGS)
    def test_wrapped_base64_with_unicode_escaped_line_breaks_is_left_untouched(
        self, image, mime, newline, encode
    ):
        text = encode(f"look: {wrapped_data_url(image, mime, 76, newline)} done")
        assert "u000" in text
        s3 = FakeS3()
        row = span(input=text)

        result = extract_attachments(s3, PROJECT, [], [row])

        assert row["input"] == text
        assert s3.heads == []
        assert (result.referenced, result.omitted) == (0, 0)

    @pytest.mark.parametrize(("image", "mime"), URL_SAFE_IMAGES)
    @pytest.mark.parametrize("encode", ENCODINGS)
    def test_url_safe_base64_is_left_untouched(self, image, mime, encode):
        url_safe = base64.urlsafe_b64encode(image).decode("ascii")
        assert url_safe != b64(image)
        text = encode(f"look: data:{mime};base64,{url_safe} done")
        s3 = FakeS3()
        row = span(input=text)

        result = extract_attachments(s3, PROJECT, [], [row])

        assert row["input"] == text
        assert s3.heads == []
        assert (result.referenced, result.omitted) == (0, 0)

    @pytest.mark.parametrize(
        "after",
        ["", " done", "\n- item", "\n\n", "\r\n)", "\\n\\t", '\\n"'],
        ids=["end", "space", "dash-item", "blank-line", "crlf-paren", "escaped-tab", "quote"],
    )
    def test_unpadded_base64_that_nothing_continues_is_stored(self, after):
        assert not b64(UNPADDED_PNG).endswith("=")
        row = span(input=f"{data_url(UNPADDED_PNG, 'image/png')}{after}")

        extract_attachments(FakeS3(), PROJECT, [], [row])

        assert row["input"] == f"{ref_for(UNPADDED_PNG, 'image/png')}{after}"

    @pytest.mark.parametrize("after", ["\nWhat is this?", "-suffix", "_name", "\\nNext"])
    def test_padded_base64_ends_the_image_whatever_follows(self, after):
        image = make_png(8, 8)
        assert b64(image).endswith("=")
        row = span(input=f"{data_url(image, 'image/png')}{after}")

        extract_attachments(FakeS3(), PROJECT, [], [row])

        assert row["input"] == f"{ref_for(image, 'image/png')}{after}"

    def test_unpadded_base64_that_a_line_of_text_follows_stays_inline(self):
        # Known limit: a new line that starts with a letter or digit reads as more
        # base64, so an unpadded image right before it is left inline.
        text = f"{data_url(UNPADDED_PNG, 'image/png')}\nWhat is this?"
        row = span(input=text)

        extract_attachments(FakeS3(), PROJECT, [], [row])

        assert row["input"] == text


class TestKnownJsonShapes:
    def test_base64_source_shape_keeps_formatting(self):
        image = make_png(2, 2)
        payload = {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "what is this?"},
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": b64(image),
                            },
                        },
                    ],
                }
            ]
        }
        text = json.dumps(payload, indent=2)
        s3 = FakeS3()
        row = span(input=text)

        result = extract_attachments(s3, PROJECT, [], [row])

        assert row["input"] == text.replace(f'"{b64(image)}"', f'"{ref_for(image, "image/png")}"')
        assert json.loads(row["input"])["messages"][0]["content"][1]["source"]["data"] == (
            ref_for(image, "image/png")
        )
        assert result.referenced == 1
        assert list(s3.objects.values()) == [(image, "image/png")]

    @pytest.mark.parametrize(
        ("wrapper", "type_key", "image", "mime"),
        [
            ("inline_data", "mime_type", make_jpeg(3, 3), "image/jpeg"),
            ("inlineData", "mimeType", make_webp_vp8x(3, 3), "image/webp"),
            ("inline_data", "mime_type", make_gif(), "image/gif"),
        ],
    )
    def test_mime_type_shapes(self, wrapper, type_key, image, mime):
        payload = {"contents": [{"parts": [{wrapper: {type_key: mime, "data": b64(image)}}]}]}
        row = span(output=json.dumps(payload))

        extract_attachments(FakeS3(), PROJECT, [], [row])

        assert json.loads(row["output"]) == {
            "contents": [{"parts": [{wrapper: {type_key: mime, "data": ref_for(image, mime)}}]}]
        }

    def test_same_data_twice_is_stored_once(self):
        image = make_png()
        part = {"mime_type": "image/png", "data": b64(image)}
        s3 = FakeS3()
        row = span(input=json.dumps({"a": part, "b": [part]}))

        result = extract_attachments(s3, PROJECT, [], [row])

        assert json.loads(row["input"]) == {
            "a": {"mime_type": "image/png", "data": ref_for(image, "image/png")},
            "b": [{"mime_type": "image/png", "data": ref_for(image, "image/png")}],
        }
        assert len(s3.puts) == 1
        assert result.referenced == 1

    @pytest.mark.parametrize(
        "node",
        [
            # Not one of the image types that are extracted.
            {"type": "base64", "media_type": "image/svg+xml", "data": "PHN2Zz48L3N2Zz4="},
            # media_type without "type": "base64" is not the known shape.
            {"type": "image", "media_type": "image/png", "data": b64(make_png())},
            # data that is not bare base64 (a URL, or already a reference).
            {"mime_type": "image/png", "data": "https://example.com/a.png"},
            {"mime_type": "image/png", "data": ref_for(make_png(), "image/png")},
            {"mime_type": "image/png", "data": ""},
            {"mime_type": "image/png", "data": 12345},
            {"mime_type": "text/plain", "data": b64(make_png())},
        ],
    )
    def test_other_objects_are_left_alone(self, node):
        text = json.dumps({"part": node})
        s3 = FakeS3()
        row = span(input=text)

        extract_attachments(s3, PROJECT, [], [row])

        assert row["input"] is text
        assert s3.heads == []

    def test_data_url_inside_a_shape_is_replaced_once(self):
        image = make_png()
        payload = {"mime_type": "image/png", "data": data_url(image, "image/png")}
        s3 = FakeS3()
        row = span(input=json.dumps(payload))

        result = extract_attachments(s3, PROJECT, [], [row])

        assert json.loads(row["input"])["data"] == ref_for(image, "image/png")
        assert result.referenced == 1

    @pytest.mark.parametrize(
        "text",
        [
            # Looks like a shape, but is not JSON.
            '{"mime_type": "image/png", "data": "iVBORw0KGgo=" ',
            # Nested deeper than the JSON parser recurses.
            "[" * 100_000 + '{"mime_type": "image/png", "data": "iVBORw0KGgo="}' + "]" * 100_000,
        ],
    )
    def test_unparseable_json_is_left_alone(self, text):
        row = span(input=text)

        extract_attachments(FakeS3(), PROJECT, [], [row])

        assert row["input"] is text

    def test_shape_inside_double_encoded_json_is_not_parsed(self):
        # Known limit: the inner JSON's keys read \"data\", so it is never parsed.
        inner = json.dumps({"mime_type": "image/png", "data": b64(make_png())})
        text = json.dumps({"parts": [inner]})
        row = span(input=text)

        extract_attachments(FakeS3(), PROJECT, [], [row])

        assert row["input"] is text

    def test_shape_written_with_escaped_slashes_is_left_alone(self):
        # Known limit: an encoder that writes "/" as "\/" hides the value from the
        # exact substitution, so the image stays inline and nothing is stored.
        data = b64(make_jpeg())
        assert "/" in data
        escaped = data.replace("/", "\\/")
        text = '{"mime_type": "image/jpeg", "data": "' + escaped + '"}'
        assert json.loads(text)["data"] == data
        s3 = FakeS3()
        row = span(input=text)

        extract_attachments(s3, PROJECT, [], [row])

        assert row["input"] is text
        assert s3.heads == []

    @pytest.mark.parametrize("declared", ["IMAGE/PNG", "Image/Png"])
    def test_declared_type_in_upper_case(self, declared):
        image = make_png(2, 2)
        row = span(input=json.dumps({"mime_type": declared, "data": b64(image)}))

        result = extract_attachments(FakeS3(), PROJECT, [], [row])

        assert json.loads(row["input"])["data"] == ref_for(image, "image/png")
        assert result.referenced == 1

    @pytest.mark.parametrize(
        "types",
        [("image/png", "image/jpeg"), ("image/jpeg", "image/png")],
        ids=["png-first", "jpeg-first"],
    )
    def test_same_data_declared_as_two_types_takes_the_one_its_bytes_are(self, types):
        image = make_png(2, 2)
        payload = {
            "a": {"mime_type": types[0], "data": b64(image)},
            "b": [{"mime_type": types[1], "data": b64(image)}],
        }
        s3 = FakeS3()
        row = span(input=json.dumps(payload))

        result = extract_attachments(s3, PROJECT, [], [row])

        parsed = json.loads(row["input"])
        assert parsed["a"]["data"] == parsed["b"][0]["data"] == ref_for(image, "image/png")
        assert list(s3.objects.values()) == [(image, "image/png")]
        assert (result.referenced, result.omitted) == (1, 0)

    def test_same_data_declared_only_as_other_types_takes_the_type_its_bytes_are(self):
        image = make_png(2, 2)
        payload = [
            {"mime_type": "image/jpeg", "data": b64(image)},
            {"mime_type": "image/gif", "data": b64(image)},
        ]
        s3 = FakeS3()
        row = span(input=json.dumps(payload))

        result = extract_attachments(s3, PROJECT, [], [row])

        ref = ref_for(image, "image/png")
        assert [part["data"] for part in json.loads(row["input"])] == [ref, ref]
        assert list(s3.objects.values()) == [(image, "image/png")]
        assert (result.referenced, result.omitted) == (1, 0)

    def test_non_image_bytes_declared_as_two_types_share_one_placeholder(self):
        payload = [
            {"mime_type": "image/jpeg", "data": b64(RIFF_AUDIO)},
            {"mime_type": "image/gif", "data": b64(RIFF_AUDIO)},
        ]
        s3 = FakeS3()
        row = span(input=json.dumps(payload))

        result = extract_attachments(s3, PROJECT, [], [row])

        omitted = (
            "[image omitted: content is not a PNG, JPEG, GIF or WebP image, "
            f"{len(RIFF_AUDIO)} bytes]"
        )
        assert [part["data"] for part in json.loads(row["input"])] == [omitted, omitted]
        assert s3.heads == []
        assert result.omitted == 1

    @pytest.mark.parametrize(
        "data",
        [
            "data",
            "None",
            "null",
            "REDACTED",
            # Strict base64, one byte shorter than any image header.
            b64(b"GIF89a\x01\x00\x01"),
            # Not strict base64: too much padding, or a length that is not a multiple of 4.
            "iVBORw0KGgoA=",
            b64(make_png(8, 8))[:-1],
        ],
    )
    @pytest.mark.parametrize(
        "shape",
        [
            lambda data: {"type": "image", "mimeType": "image/png", "data": data},
            lambda data: {"type": "base64", "media_type": "image/png", "data": data},
        ],
        ids=["mime-type", "base64-source"],
    )
    def test_a_data_value_that_cannot_be_an_image_changes_nothing(self, data, shape):
        payload = {
            "content": [shape(data)],
            "result": {data: [1, 2, 3]},
            "api_key": data,
            "messages": [{"type": "text", "text": data}],
        }
        text = json.dumps(payload)
        s3 = FakeS3()
        row = span(input=text)

        result = extract_attachments(s3, PROJECT, [], [row])

        assert row["input"] is text
        assert s3.heads == []
        assert (result.referenced, result.omitted) == (0, 0)

    def test_a_data_value_of_the_minimum_size_is_validated(self):
        # Long enough to be an image, so it is checked, and every value equal to it
        # becomes the placeholder; a key equal to it is never touched.
        data = b64(b"\x00" * _MIN_IMAGE_BYTES)
        text = json.dumps(
            {"part": {"mime_type": "image/png", "data": data}, "copy": data, data: "key"}
        )
        row = span(input=text)

        result = extract_attachments(FakeS3(), PROJECT, [], [row])

        omitted = (
            "[image omitted: content is not a PNG, JPEG, GIF or WebP image, "
            f"{_MIN_IMAGE_BYTES} bytes]"
        )
        assert json.loads(row["input"]) == {
            "part": {"mime_type": "image/png", "data": omitted},
            "copy": omitted,
            data: "key",
        }
        assert result.omitted == 1

    def test_no_image_header_is_shorter_than_the_minimum(self):
        assert read_image_dimensions(make_gif()[:_MIN_IMAGE_BYTES], "image/gif") is not None
        for image, _ in [*(param.values for param in IMAGES), (make_gif(), "image/gif")]:
            for size in range(_MIN_IMAGE_BYTES):
                prefix = image[:size]
                assert read_image_dimensions(prefix, sniff_image_mime(prefix) or "") is None

    def test_could_be_image_is_strict_base64_long_enough_for_a_header(self):
        # Nine bytes of base64, then every ending of up to six characters, padding included.
        for length in range(7):
            for chars in itertools.product("A/+=", repeat=length):
                data = "A" * 12 + "".join(chars)
                strict = _strict_b64decode(data)
                expected = strict is not None and len(strict) >= _MIN_IMAGE_BYTES
                assert _could_be_image(data) == expected, data
        assert _could_be_image(b64(b"\x00" * _MIN_IMAGE_BYTES))
        assert not _could_be_image(b64(b"\x00" * (_MIN_IMAGE_BYTES - 1)))

    @pytest.mark.parametrize(
        "template",
        [
            '{{"part": {{"mime_type": "image/png", "data": "{b}"}}, "{b}": "x", "copy": "{b}"}}',
            '{{"part": {{"mime_type": "image/png", "data": "{b}"}}, "{b}" : 1, "copy": "{b}"}}',
            '{{"part": {{"mime_type": "image/png", "data": "{b}"}},\n"{b}"\n\t:0, "copy": "{b}"}}',
        ],
        ids=["key", "space-before-colon", "newline-before-colon"],
    )
    def test_a_found_base64_as_an_object_key_is_never_replaced(self, template):
        image = make_png(2, 2)
        text = template.format(b=b64(image))
        row = span(input=text)

        extract_attachments(FakeS3(), PROJECT, [], [row])

        ref, data = ref_for(image, "image/png"), b64(image)
        parsed = json.loads(row["input"])
        assert parsed["part"]["data"] == parsed["copy"] == ref
        assert data in parsed
        expected = text.replace(f'"data": "{data}"', f'"data": "{ref}"')
        assert row["input"] == expected.replace(f'"copy": "{data}"', f'"copy": "{ref}"')

    def test_a_string_that_is_the_same_base64_is_the_same_image(self):
        image = make_png(2, 2)
        payload = {
            "part": {"mime_type": "image/png", "data": b64(image)},
            "copy": b64(image),
            "note": "x",
        }
        row = span(input=json.dumps(payload))

        extract_attachments(FakeS3(), PROJECT, [], [row])

        ref = ref_for(image, "image/png")
        assert json.loads(row["input"]) == {
            "part": {"mime_type": "image/png", "data": ref},
            "copy": ref,
            "note": "x",
        }

    def test_text_with_too_many_json_values_is_never_parsed(self):
        # A small shape followed by a large array: parsing it would build a tree many
        # times the size of the text. "AAAA" is not an image, so had the text been
        # parsed it would hold a placeholder now.
        text = '{"mime_type":"image/png","data":"AAAA","junk":[' + '"x",' * 1_000_000 + '"x"]}'
        s3 = FakeS3()
        row = span(input=text)

        result = extract_attachments(s3, PROJECT, [], [row])

        assert row["input"] is text
        assert s3.heads == []
        assert result.omitted == 0

    def test_json_value_bound(self, monkeypatch):
        image = make_png(2, 2)
        text = json.dumps({"mime_type": "image/png", "data": b64(image), "junk": [0] * 5})
        # Every value but the first follows "[", "," or ":".
        values = text.count(",") + text.count(":") + text.count("[")

        monkeypatch.setattr(attachment_extraction, "_MAX_JSON_VALUES", values)
        at_bound = span(input=text)
        extract_attachments(FakeS3(), PROJECT, [], [at_bound])
        assert json.loads(at_bound["input"])["data"] == ref_for(image, "image/png")

        monkeypatch.setattr(attachment_extraction, "_MAX_JSON_VALUES", values - 1)
        over = span(input=text)
        extract_attachments(FakeS3(), PROJECT, [], [over])
        assert over["input"] is text

    @pytest.mark.parametrize("candidates", [10, 4000])
    def test_one_pass_over_the_text_however_many_values(self, monkeypatch, candidates):
        # Distinct base64 values that are not images never reach storage, so only the
        # passes over the text bound their cost. Every str method that scans the text,
        # and every pass of the replacement pattern, is recorded.
        scans: list[str] = []
        pattern = attachment_extraction._QUOTED_BASE64_RE

        class CountingPattern:
            def finditer(self, text):
                scans.append("finditer")
                return pattern.finditer(text)

        class CountingText(str):
            def __contains__(self, sub):
                scans.append("in")
                return super().__contains__(sub)

            def replace(self, *args):
                scans.append("replace")
                return CountingText(super().replace(*args))

            def find(self, *args):
                scans.append("find")
                return super().find(*args)

            def count(self, *args):
                scans.append("count")
                return super().count(*args)

        monkeypatch.setattr(attachment_extraction, "_QUOTED_BASE64_RE", CountingPattern())
        image = make_png(2, 2)
        parts = [{"mime_type": "image/png", "data": b64(image)}]
        parts += [
            {"mime_type": "image/png", "data": b64(n.to_bytes(24, "big"))}
            for n in range(candidates)
        ]
        s3 = FakeS3()
        extractor = attachment_extraction._Extractor(s3, PROJECT, AttachmentSettings())

        replaced = extractor._replace_json_shapes(CountingText(json.dumps(parts)))

        assert scans == ["finditer"]
        assert json.loads(replaced)[0]["data"] == ref_for(image, "image/png")
        assert (extractor.result.referenced, extractor.result.omitted) == (1, candidates)
        assert len(s3.heads) == 1

    def test_images_are_handled_in_the_order_they_appear(self):
        first, second = make_png(1, 1), make_png(2, 1)
        payload = {
            "z": {"mime_type": "image/png", "data": b64(first)},
            "a": [{"mime_type": "image/png", "data": b64(second)}],
        }
        config = AttachmentSettings(max_images_per_batch=1)
        row = span(input=json.dumps(payload))

        extract_attachments(FakeS3(), PROJECT, [], [row], config=config)

        parsed = json.loads(row["input"])
        assert parsed["z"]["data"] == ref_for(first, "image/png")
        assert parsed["a"][0]["data"] == (
            f"[image omitted: more than 1 images in one batch, {len(second)} bytes]"
        )


RIFF_AUDIO = b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 24
SVG = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
HTML = b"<!doctype html><script>alert(1)</script>"
PNG_WITHOUT_IHDR = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
ZERO_WIDTH_PNG = make_png(0, 1)
# A frame header that declares 2 bytes, with a size after it that it does not hold.
SHORT_FRAME_JPEG = b"\xff\xd8\xff\xc0\x00\x02" + struct.pack(">BHHB", 8, 10, 20, 1) + b"\xff\xd9"
WIDE_PNG = make_png(16385, 1)
TALL_PNG = make_png(1, 16385)
HUGE_WEBP = make_webp_vp8x(20000, 20000)


class TestValidation:
    @pytest.mark.parametrize(
        ("url", "reason", "byte_count"),
        [
            pytest.param(
                data_url(SVG, "image/png"),
                "content is not a PNG, JPEG, GIF or WebP image",
                len(SVG),
                id="svg-declared-as-png",
            ),
            pytest.param(
                data_url(HTML, "image/gif"),
                "content is not a PNG, JPEG, GIF or WebP image",
                len(HTML),
                id="html-declared-as-gif",
            ),
            pytest.param(
                data_url(RIFF_AUDIO, "image/webp"),
                "content is not a PNG, JPEG, GIF or WebP image",
                len(RIFF_AUDIO),
                id="riff-audio-declared-as-webp",
            ),
            pytest.param(
                data_url(b"hello world!", "image/gif"),
                "content is not a PNG, JPEG, GIF or WebP image",
                12,
                id="not-an-image",
            ),
            pytest.param(
                # 14 base64 characters: not a multiple of 4, so not strict base64.
                "data:image/png;base64,iVBORw0KGgoAAA",
                "invalid base64",
                10,
                id="invalid-base64",
            ),
            pytest.param(
                data_url(PNG_WITHOUT_IHDR, "image/png"),
                "unreadable image header",
                len(PNG_WITHOUT_IHDR),
                id="png-signature-without-ihdr",
            ),
            pytest.param(
                data_url(ZERO_WIDTH_PNG, "image/png"),
                "unreadable image header",
                len(ZERO_WIDTH_PNG),
                id="zero-width",
            ),
            pytest.param(
                data_url(SHORT_FRAME_JPEG, "image/jpeg"),
                "unreadable image header",
                len(SHORT_FRAME_JPEG),
                id="jpeg-size-past-its-frame-header",
            ),
            pytest.param(
                data_url(WIDE_PNG, "image/png"),
                "larger than 16384 pixels per side",
                len(WIDE_PNG),
                id="over-width",
            ),
            pytest.param(
                data_url(TALL_PNG, "image/png"),
                "larger than 16384 pixels per side",
                len(TALL_PNG),
                id="over-height",
            ),
            pytest.param(
                data_url(HUGE_WEBP, "image/webp"),
                "larger than 16384 pixels per side",
                len(HUGE_WEBP),
                id="over-dimension-webp",
            ),
        ],
    )
    def test_failure_becomes_a_placeholder_and_keeps_the_text(self, url, reason, byte_count):
        s3 = FakeS3()
        row = span(input=f"before {url} after")

        result = extract_attachments(s3, PROJECT, [], [row])

        assert row["input"] == f"before [image omitted: {reason}, {byte_count} bytes] after"
        assert result.omitted == 1
        assert result.referenced == 0
        assert s3.heads == []
        assert s3.objects == {}

    @pytest.mark.parametrize(
        ("data", "expected"),
        [
            ("aGk=", b"hi"),
            ("aGVsbG8=", b"hello"),
            ("aA==", b"h"),
            ("abcd=", None),
            ("abcd==", None),
            ("abc", None),
            ("ab=c", None),
            ("a===", None),
            ("ab-_", None),
        ],
    )
    def test_strict_b64decode(self, data, expected):
        assert _strict_b64decode(data) == expected

    @pytest.mark.parametrize(
        ("wrap", "read"),
        [
            pytest.param(
                lambda image: data_url(image, "image/png"), lambda text: text, id="data-url"
            ),
            pytest.param(
                lambda image: json.dumps({"mime_type": "image/png", "data": b64(image)}),
                lambda text: json.loads(text)["data"],
                id="shape",
            ),
        ],
    )
    def test_over_size_is_never_decoded(self, monkeypatch, wrap, read):
        def no_decoding(data):
            raise AssertionError("an oversize image was decoded")

        monkeypatch.setattr(attachment_extraction, "_strict_b64decode", no_decoding)
        image = make_png(1, 1, pad=600)
        config = AttachmentSettings(max_image_bytes=500)
        s3 = FakeS3()
        row = span(input=wrap(image))

        result = extract_attachments(s3, PROJECT, [], [row], config=config)

        assert read(row["input"]) == f"[image omitted: larger than 500 bytes, {len(image)} bytes]"
        assert result.omitted == 1
        assert s3.objects == {}

    def test_at_the_size_limit_is_stored(self):
        image = make_png(1, 1, pad=600)
        config = AttachmentSettings(max_image_bytes=len(image))
        row = span(input=data_url(image, "image/png"))

        extract_attachments(FakeS3(), PROJECT, [], [row], config=config)

        assert row["input"] == ref_for(image, "image/png")

    def test_at_the_dimension_limit_is_stored(self):
        image = make_png(16384, 16384)
        row = span(input=data_url(image, "image/png"))

        extract_attachments(FakeS3(), PROJECT, [], [row])

        assert row["input"] == ref_for(image, "image/png")

    def test_placeholder_inside_json_keeps_it_valid(self):
        text = json.dumps({"url": data_url(RIFF_AUDIO, "image/webp"), "note": "ok"})
        row = span(input=text)

        extract_attachments(FakeS3(), PROJECT, [], [row])

        assert json.loads(row["input"]) == {
            "url": (
                "[image omitted: content is not a PNG, JPEG, GIF or WebP image, "
                f"{len(RIFF_AUDIO)} bytes]"
            ),
            "note": "ok",
        }

    @pytest.mark.parametrize(
        ("image", "mime", "declared"),
        [
            pytest.param(make_png(4, 3), "image/png", "image/jpeg", id="png-as-jpeg"),
            pytest.param(make_jpeg(8, 6), "image/jpeg", "image/png", id="jpeg-as-png"),
            pytest.param(make_gif(5, 5), "image/gif", "image/webp", id="gif-as-webp"),
            pytest.param(make_webp_vp8l(3, 3), "image/webp", "image/jpg", id="webp-as-jpg"),
        ],
    )
    @pytest.mark.parametrize(
        "wrap",
        [
            pytest.param(lambda data, declared: data_url(data, declared), id="data-url"),
            pytest.param(
                lambda data, declared: json.dumps({"mime_type": declared, "data": b64(data)}),
                id="shape",
            ),
        ],
    )
    def test_an_image_declared_as_another_allowed_type_is_stored_as_its_own(
        self, image, mime, declared, wrap
    ):
        s3 = FakeS3()
        row = span(input=wrap(image, declared))

        result = extract_attachments(s3, PROJECT, [], [row])

        assert find_attachment_refs(row["input"]) == {sha(image)}
        assert ref_for(image, mime) in row["input"]
        assert s3.objects == {attachment_key(PROJECT, sha(image)): (image, mime)}
        assert (result.referenced, result.omitted) == (1, 0)


THUMBNAIL = make_jpeg(16, 16, scan_bytes=2000)
FULL_SIZE_IMAGES = [
    pytest.param(make_png(800, 600, pad=50_000), "image/png", id="png"),
    pytest.param(make_jpeg(800, 600, scan_bytes=50_000), "image/jpeg", id="jpeg"),
    pytest.param(
        make_jpeg(800, 600, thumbnail=THUMBNAIL, scan_bytes=50_000),
        "image/jpeg",
        id="jpeg-with-exif-thumbnail",
    ),
    pytest.param(make_gif(800, 600, pad=50_000), "image/gif", id="gif"),
    pytest.param(make_webp_vp8x(800, 600, pad=50_000), "image/webp", id="webp"),
]
SWEPT_IMAGES = [
    pytest.param(make_png(4, 3, pad=1500), "image/png", id="png"),
    pytest.param(make_jpeg(8, 6, scan_bytes=1500), "image/jpeg", id="jpeg"),
    pytest.param(
        make_jpeg(8, 6, thumbnail=make_jpeg(2, 2, scan_bytes=200), scan_bytes=1500),
        "image/jpeg",
        id="jpeg-with-exif-thumbnail",
    ),
    pytest.param(make_gif(8, 6, pad=1500), "image/gif", id="gif"),
    pytest.param(make_webp_vp8x(8, 6, pad=1500), "image/webp", id="webp-vp8x"),
    pytest.param(make_webp_vp8l(8, 6), "image/webp", id="webp-vp8l"),
    pytest.param(make_webp_vp8(8, 6), "image/webp", id="webp-vp8"),
]
# Text before a data URL moves a cut within a base64 group, so one of these four leads
# always leaves whole groups: strict base64 that only the completeness check can catch.
CUT_LEADS = ["", "x", "xx", "xxx"]


def reason_for_cut(kept: str) -> str:
    """What a data URL cut to ``kept`` is omitted for: its base64 fails first unless whole."""
    run = kept.partition(";base64,")[2]
    return "incomplete image" if len(run) % 4 == 0 else "invalid base64"


class TestIncompleteImages:
    @pytest.mark.parametrize(("image", "mime"), FULL_SIZE_IMAGES)
    def test_a_whole_image_is_stored(self, image, mime):
        s3 = FakeS3()
        row = span(input=f"before {data_url(image, mime)} after")

        result = extract_attachments(s3, PROJECT, [], [row])

        assert row["input"] == f"before {ref_for(image, mime)} after"
        assert s3.objects == {attachment_key(PROJECT, sha(image)): (image, mime)}
        assert (result.referenced, result.omitted) == (1, 0)

    @pytest.mark.parametrize(("image", "mime"), FULL_SIZE_IMAGES)
    @pytest.mark.parametrize(
        "kept",
        [
            pytest.param(lambda size: size // 4, id="first-quarter"),
            pytest.param(lambda size: size // 2, id="first-half"),
            pytest.param(lambda size: size - 1, id="all-but-the-last-byte"),
        ],
    )
    def test_the_front_of_an_image_becomes_a_placeholder(self, image, mime, kept):
        fragment = image[: kept(len(image))]
        # The cut is past the header, so only the completeness check can catch it.
        assert sniff_image_mime(fragment) == mime
        assert read_image_dimensions(fragment, mime) == (800, 600)
        s3 = FakeS3()
        row = span(input=f"before {data_url(fragment, mime)} after")

        result = extract_attachments(s3, PROJECT, [], [row])

        assert row["input"] == (
            f"before [image omitted: incomplete image, {len(fragment)} bytes] after"
        )
        assert s3.heads == []
        assert s3.objects == {}
        assert (result.referenced, result.omitted) == (0, 1)

    @pytest.mark.parametrize(("image", "mime"), SWEPT_IMAGES)
    def test_no_cut_of_an_image_is_stored(self, image, mime):
        s3 = FakeS3()
        rows = [span(input=data_url(image[:end], mime)) for end in range(1, len(image))]

        result = extract_attachments(s3, PROJECT, [], rows)

        assert s3.heads == []
        assert s3.objects == {}
        assert result.referenced == 0
        assert not any(ATTACHMENT_REF_PREFIX in row["input"] for row in rows)

    def test_a_thumbnail_end_inside_a_cut_jpeg_does_not_count(self):
        image = make_jpeg(800, 600, thumbnail=THUMBNAIL, scan_bytes=50_000)
        fragment = image[: len(image) // 2]
        assert THUMBNAIL in fragment
        s3 = FakeS3()
        row = span(input=data_url(fragment, "image/jpeg"))

        extract_attachments(s3, PROJECT, [], [row])

        assert row["input"] == f"[image omitted: incomplete image, {len(fragment)} bytes]"
        assert s3.objects == {}

    @pytest.mark.parametrize(("image", "mime"), FULL_SIZE_IMAGES)
    def test_the_front_of_an_image_in_a_known_shape_becomes_a_placeholder(self, image, mime):
        fragment = image[: len(image) // 2]
        s3 = FakeS3()
        row = span(input=json.dumps({"mime_type": mime, "data": b64(fragment)}))

        result = extract_attachments(s3, PROJECT, [], [row])

        assert json.loads(row["input"]) == {
            "mime_type": mime,
            "data": f"[image omitted: incomplete image, {len(fragment)} bytes]",
        }
        assert s3.objects == {}
        assert (result.referenced, result.omitted) == (0, 1)

    @pytest.mark.parametrize(("image", "mime"), FULL_SIZE_IMAGES)
    @pytest.mark.parametrize("lead", CUT_LEADS)
    def test_text_cut_to_its_first_characters_stores_nothing(self, image, mime, lead):
        text = lead + data_url(image, mime)
        s3 = FakeS3()
        row = span(output=keep_first(text, 20_000))

        result = extract_attachments(s3, PROJECT, [], [row])

        assert ATTACHMENT_REF_PREFIX not in row["output"]
        assert f"[image omitted: {reason_for_cut(text[:20_000])}, " in row["output"]
        assert s3.heads == []
        assert s3.objects == {}
        assert (result.referenced, result.omitted) == (0, 1)

    @pytest.mark.parametrize(("image", "mime"), FULL_SIZE_IMAGES)
    @pytest.mark.parametrize("lead", CUT_LEADS)
    def test_text_cut_in_its_middle_stores_nothing(self, image, mime, lead):
        text = lead + data_url(image, mime)
        s3 = FakeS3()
        row = span(output=keep_both_ends(text, 20_000))

        result = extract_attachments(s3, PROJECT, [], [row])

        assert ATTACHMENT_REF_PREFIX not in row["output"]
        assert f"[image omitted: {reason_for_cut(text[:10_000])}, " in row["output"]
        assert s3.heads == []
        assert s3.objects == {}
        assert (result.referenced, result.omitted) == (0, 1)

    def test_header_only_images_cost_no_storage_calls(self):
        # 2000 distinct 24-byte PNG headers fit in about 110 KB of span text.
        urls = [data_url(png_header(width), "image/png") for width in range(1, 2001)]
        s3 = FakeS3()
        row = span(input=" ".join(urls))

        result = extract_attachments(s3, PROJECT, [], [row])

        assert s3.heads == []
        assert (result.referenced, result.omitted) == (0, 2000)

    def test_an_incomplete_image_takes_no_place_in_the_batch_limit(self):
        whole = make_png(4, 3)
        fragment = make_png(4, 3, pad=500)[:200]
        config = AttachmentSettings(max_images_per_batch=1)
        s3 = FakeS3()
        row = span(input=f"{data_url(fragment, 'image/png')} {data_url(whole, 'image/png')}")

        result = extract_attachments(s3, PROJECT, [], [row], config=config)

        assert row["input"] == (
            f"[image omitted: incomplete image, {len(fragment)} bytes] "
            f"{ref_for(whole, 'image/png')}"
        )
        assert (result.referenced, result.omitted) == (1, 1)


class TestStorage:
    def test_dedupes_within_a_batch(self):
        image = make_png()
        url = data_url(image, "image/png")
        s3 = FakeS3()
        spans = [span(input=url, output=url), span(metadata=json.dumps({"shot": url}))]
        traces = [{"trace_id": "trace-a", "input": url}]

        result = extract_attachments(s3, PROJECT, traces, spans)

        key = attachment_key(PROJECT, sha(image))
        assert s3.heads == [key]
        assert s3.puts == [key]
        assert result.referenced == 4
        assert result.stored == 1

    def test_projects_get_separate_objects(self):
        image = make_png()
        s3 = FakeS3()

        extract_attachments(s3, "proj-a", [], [span(input=data_url(image, "image/png"))])
        extract_attachments(s3, "proj-b", [], [span(input=data_url(image, "image/png"))])

        assert set(s3.objects) == {
            attachment_key("proj-a", sha(image)),
            attachment_key("proj-b", sha(image)),
        }

    def test_same_batch_twice(self):
        png, jpeg = make_png(), make_jpeg()
        batch_spans = [
            span(input=data_url(png, "image/png")),
            span(output=json.dumps({"mime_type": "image/jpeg", "data": b64(jpeg)})),
        ]
        batch_traces = [{"trace_id": "trace-a", "input": data_url(png, "image/png")}]
        s3 = FakeS3()

        first_spans, first_traces = copy.deepcopy(batch_spans), copy.deepcopy(batch_traces)
        extract_attachments(s3, PROJECT, first_traces, first_spans)
        keys_after_first = dict(s3.objects)
        second_spans, second_traces = copy.deepcopy(batch_spans), copy.deepcopy(batch_traces)
        second = extract_attachments(s3, PROJECT, second_traces, second_spans)

        assert s3.objects == keys_after_first
        assert len(s3.puts) == 2  # one per image, all from the first run
        assert second.stored == 0
        assert second_spans == first_spans
        assert second_traces == first_traces

    def test_existing_object_is_not_uploaded_again(self):
        image = make_gif()
        s3 = FakeS3()
        s3.objects[attachment_key(PROJECT, sha(image))] = (image, "image/gif")
        row = span(input=data_url(image, "image/gif"))

        result = extract_attachments(s3, PROJECT, [], [row])

        assert row["input"] == ref_for(image, "image/gif")
        assert s3.puts == []
        assert result.stored == 0

    def test_conditional_put_412_counts_as_success(self):
        image = make_png()
        key = attachment_key(PROJECT, sha(image))
        client = boto3.client(
            "s3", region_name="us-east-1", aws_access_key_id="t", aws_secret_access_key="t"
        )
        service = S3Service(bucket_name="b", access_key_id="t", secret_access_key="t")
        service._client = client
        row = span(input=data_url(image, "image/png"))

        with Stubber(client) as stub:
            stub.add_client_error("head_object", service_error_code="404", http_status_code=404)
            stub.add_client_error(
                "put_object",
                service_error_code="PreconditionFailed",
                http_status_code=412,
                expected_params={
                    "Bucket": "b",
                    "Key": key,
                    "Body": image,
                    "ContentType": "image/png",
                    "IfNoneMatch": "*",
                },
            )
            result = extract_attachments(service, PROJECT, [], [row])
            stub.assert_no_pending_responses()

        assert row["input"] == ref_for(image, "image/png")
        assert result.referenced == 1
        assert result.stored == 0

    def test_storage_error_mid_batch_raises(self):
        first, second = make_png(), make_gif()
        error = ClientError({"Error": {"Code": "SlowDown"}}, "PutObject")
        s3 = FakeS3(put_error=error, fail_after_puts=1)
        spans = [
            span(input=data_url(first, "image/png")),
            span(input=data_url(second, "image/gif")),
        ]

        with pytest.raises(ClientError):
            extract_attachments(s3, PROJECT, [], spans)

        assert s3.puts == [attachment_key(PROJECT, sha(first))]

    def test_existence_check_error_raises(self):
        class BrokenHead(FakeS3):
            def object_exists(self, key):
                raise ClientError({"Error": {"Code": "403"}}, "HeadObject")

        with pytest.raises(ClientError):
            extract_attachments(
                BrokenHead(), PROJECT, [], [span(input=data_url(make_png(), "image/png"))]
            )


class TestImagesPerBatch:
    def test_the_limit_stops_storage_calls(self):
        images = [make_png(width, 1) for width in range(1, 6)]
        config = AttachmentSettings(max_images_per_batch=3)
        s3 = FakeS3()
        row = span(input=" ".join(data_url(image, "image/png") for image in images))

        result = extract_attachments(s3, PROJECT, [], [row], config=config)

        stored = [attachment_key(PROJECT, sha(image)) for image in images[:3]]
        assert s3.heads == stored and s3.puts == stored
        assert row["input"] == " ".join(
            [ref_for(image, "image/png") for image in images[:3]]
            + [
                f"[image omitted: more than 3 images in one batch, {len(image)} bytes]"
                for image in images[3:]
            ]
        )
        assert (result.referenced, result.stored, result.omitted) == (3, 3, 2)

    def test_an_image_already_handled_is_referenced_past_the_limit(self):
        first, second, third = make_png(1, 1), make_png(2, 1), make_png(3, 1)
        config = AttachmentSettings(max_images_per_batch=2)
        s3 = FakeS3()
        urls = [data_url(image, "image/png") for image in (first, second, third, first)]
        row = span(input=" | ".join(urls))

        extract_attachments(s3, PROJECT, [], [row], config=config)

        assert row["input"].split(" | ") == [
            ref_for(first, "image/png"),
            ref_for(second, "image/png"),
            f"[image omitted: more than 2 images in one batch, {len(third)} bytes]",
            ref_for(first, "image/png"),
        ]
        assert len(s3.heads) == 2

    def test_the_limit_is_per_batch_and_counts_images_already_stored(self):
        first, second, third = make_png(1, 1), make_png(2, 1), make_png(3, 1)
        config = AttachmentSettings(max_images_per_batch=2)
        s3 = FakeS3()
        s3.objects[attachment_key(PROJECT, sha(first))] = (first, "image/png")
        spans = [
            span(input=data_url(first, "image/png")),
            span(output=f"{data_url(second, 'image/png')} {data_url(third, 'image/png')}"),
        ]
        trace = {"trace_id": "trace-a", "output": data_url(first, "image/png")}

        result = extract_attachments(s3, PROJECT, [trace], spans, config=config)

        assert spans[0]["input"] == ref_for(first, "image/png")
        assert spans[1]["output"] == (
            f"{ref_for(second, 'image/png')} "
            f"[image omitted: more than 2 images in one batch, {len(third)} bytes]"
        )
        assert trace["output"] == ref_for(first, "image/png")
        assert len(s3.heads) == 2 and len(s3.puts) == 1
        assert (result.referenced, result.stored, result.omitted) == (3, 1, 1)

    def test_tiny_images_cannot_fan_out_past_the_default_limit(self):
        # 2000 distinct whole PNGs of one row each fit in about 240 KB of span text.
        urls = [data_url(make_png(width, 1), "image/png") for width in range(1, 2001)]
        s3 = FakeS3()
        row = span(input=" ".join(urls))

        result = extract_attachments(s3, PROJECT, [], [row])

        assert len(s3.heads) == len(s3.puts) == 1000
        assert (result.referenced, result.omitted) == (1000, 1000)
        assert row["input"].count("more than 1000 images in one batch") == 1000

    def test_a_retried_batch_ends_the_same(self):
        images = [make_png(width, 1) for width in range(1, 5)]
        config = AttachmentSettings(max_images_per_batch=2)
        s3 = FakeS3()
        text = " ".join(data_url(image, "image/png") for image in images)
        first, again = span(input=text), span(input=text)

        extract_attachments(s3, PROJECT, [], [first], config=config)
        extract_attachments(s3, PROJECT, [], [again], config=config)

        assert again["input"] == first["input"]
        assert (len(s3.heads), len(s3.puts)) == (4, 2)


class TestUnchangedText:
    @pytest.mark.parametrize(
        "text",
        [
            "plain prose with no images",
            json.dumps({"data": "abc", "note": "image/png is a type", "mime_type": "text/plain"}),
            json.dumps({"type": "base64", "media_type": "application/pdf", "data": "JVBERi0="}),
            "data:image/png;base64",
            "data:text/plain;base64,aGVsbG8=",
            'base64, image/, "data", "mime_type" but not JSON',
            "x" * 200_000,
            "unicode ünïcödé 🙂 text",
        ],
    )
    def test_no_image_is_byte_identical(self, text):
        s3 = FakeS3()
        row = span(input=text, output=text, metadata=text)
        before = copy.deepcopy(row)

        result = extract_attachments(s3, PROJECT, [], [row])

        assert row == before
        assert row["input"] is text and row["output"] is text and row["metadata"] is text
        assert s3.heads == [] and s3.puts == []
        assert result.referenced == result.omitted == result.truncated == 0

    def test_missing_and_non_string_fields_are_skipped(self):
        row = span(input=None, output="", metadata=None)
        before = dict(row)

        extract_attachments(FakeS3(), PROJECT, [{"trace_id": "trace-a"}], [row])

        assert row == before


class TestTraceRows:
    def test_trace_input_output_and_metadata_are_processed(self):
        png, jpeg, gif = make_png(), make_jpeg(), make_gif()
        trace = {
            "trace_id": "trace-a",
            "input": data_url(png, "image/png"),
            "output": json.dumps({"mime_type": "image/jpeg", "data": b64(jpeg)}),
            "metadata": json.dumps({"thumb": data_url(gif, "image/gif")}),
        }

        extract_attachments(FakeS3(), PROJECT, [trace], [])

        assert trace["input"] == ref_for(png, "image/png")
        assert json.loads(trace["output"])["data"] == ref_for(jpeg, "image/jpeg")
        assert json.loads(trace["metadata"])["thumb"] == ref_for(gif, "image/gif")


class TestSpanSizeLimit:
    def test_over_8_mib_is_cut_with_the_marker(self):
        limit = 8 * 1024 * 1024
        row = span(input="a" * (9 * 1024 * 1024), output="small output")

        result = extract_attachments(FakeS3(), PROJECT, [], [row])

        assert row["input"].endswith(marker(limit))
        assert row["input"].startswith("aaaa")
        assert row["output"] == "small output"
        assert utf8_total(row) == limit
        assert result.truncated == 1

    def test_at_the_limit_is_untouched(self):
        config = AttachmentSettings(max_span_bytes=1000)
        text = "a" * 600
        row = span(input=text, output="b" * 300, metadata="c" * 100)

        result = extract_attachments(FakeS3(), PROJECT, [], [row], config=config)

        assert row["input"] is text
        assert result.truncated == 0

    def test_only_the_largest_field_is_cut_when_that_is_enough(self):
        config = AttachmentSettings(max_span_bytes=1000)
        row = span(input="i" * 300, output="o" * 800, metadata="m" * 100)

        extract_attachments(FakeS3(), PROJECT, [], [row], config=config)

        assert row["input"] == "i" * 300
        assert row["metadata"] == "m" * 100
        assert row["output"].startswith("ooo") and row["output"].endswith(marker(1000))
        assert utf8_total(row) == 1000

    def test_several_fields_are_cut_when_the_largest_is_not_enough(self):
        config = AttachmentSettings(max_span_bytes=256)
        row = span(input="i" * 400, output="o" * 390)

        extract_attachments(FakeS3(), PROJECT, [], [row], config=config)

        assert row["input"] == marker(256)
        assert row["output"].startswith("o") and row["output"].endswith(marker(256))
        assert utf8_total(row) == 256

    def test_every_row_fits_the_smallest_limit(self):
        # Sizes around one, two and three markers (47 bytes at this limit) and the limit.
        sizes = [0, 1, 46, 47, 48, 93, 94, 95, 140, 141, 142, 200, 255, 256, 257, 300, 1000]
        config = AttachmentSettings(max_span_bytes=256)
        for sizes_of_row in itertools.product(sizes, repeat=3):
            row = span(
                **{name: "x" * n for name, n in zip(("input", "output", "metadata"), sizes_of_row)}
            )

            extract_attachments(FakeS3(), PROJECT, [], [row], config=config)

            assert utf8_total(row) <= 256, sizes_of_row

    def test_a_field_no_longer_than_the_marker_is_never_cut(self):
        # Only a limit under three markers reaches this, and the settings refuse one,
        # so the row is cut directly.
        row = span(input="i" * 70, output="o" * 30)
        assert _enforce_size_limit(row, 60) is True
        assert (row["input"], row["output"]) == (marker(60), "o" * 30)

        row = span(input="i" * 8, output="o" * 8)
        assert _enforce_size_limit(row, 10) is False
        assert (row["input"], row["output"]) == ("i" * 8, "o" * 8)

    def test_multibyte_text_is_cut_on_a_character_boundary(self):
        config = AttachmentSettings(max_span_bytes=1000)
        row = span(input="€" * 1000, metadata="é" * 10)

        extract_attachments(FakeS3(), PROJECT, [], [row], config=config)

        assert row["input"].endswith(marker(1000))
        assert set(row["input"][: -len(marker(1000))]) == {"€"}
        assert row["metadata"] == "é" * 10
        assert 1000 - 3 < utf8_total(row) <= 1000

    def test_images_are_replaced_before_the_size_is_measured(self):
        image = make_png(1, 1, pad=2000)
        config = AttachmentSettings(max_span_bytes=1000)
        row = span(input=f"shot: {data_url(image, 'image/png')}")

        result = extract_attachments(FakeS3(), PROJECT, [], [row], config=config)

        assert row["input"] == f"shot: {ref_for(image, 'image/png')}"
        assert result.truncated == 0

    def test_trace_rows_are_bounded_too(self):
        config = AttachmentSettings(max_span_bytes=256)
        trace = {"trace_id": "trace-a", "input": "x" * 1000}

        extract_attachments(FakeS3(), PROJECT, [trace], [], config=config)

        assert trace["input"].endswith(marker(256))
        assert utf8_total(trace) == 256

    @pytest.mark.parametrize(
        ("text", "max_bytes", "expected"),
        [
            ("abcdef", 3, "abc"),
            ("€€€", 4, "€"),
            ("a€", 2, "a"),
            ("a€", 4, "a€"),
            ("é", 5, "é"),
            ("\ud800abc", 2, ""),
            ("\ud800abc", 4, "\ud800a"),
        ],
    )
    def test_cut_to_size(self, text, max_bytes, expected):
        assert _cut_to_size(text, max_bytes) == expected


REF_A = format_attachment_ref("a" * 64, "image/png", 120)
REF_B = format_attachment_ref("b" * 64, "image/jpeg", 4567)
REF_C = format_attachment_ref("c" * 64, "image/webp", 89)


class TestCutKeepsReferencesWhole:
    @pytest.mark.parametrize(
        ("text", "max_bytes", "expected"),
        [
            pytest.param(f"ab{REF_A}cd", 2 + len(REF_A) // 2, "ab", id="inside-a-reference"),
            pytest.param(f"ab{REF_A}cd", 2 + 5, "ab", id="inside-the-prefix"),
            pytest.param(f"ab{REF_A}cd", 2 + len(REF_A) - 1, "ab", id="inside-the-image-type"),
            pytest.param(f"ab{REF_A}cd", 2, "ab", id="just-before-a-reference"),
            pytest.param(f"ab{REF_A}cd", 2 + len(REF_A), f"ab{REF_A}", id="just-after-a-reference"),
            pytest.param(f"ab{REF_A}cd", 3 + len(REF_A), f"ab{REF_A}c", id="after-a-reference"),
            pytest.param(REF_A, 10, "", id="reference-at-the-start"),
            pytest.param(f"ééé{REF_A}", 6 + 10, "ééé", id="inside-after-multibyte-text"),
            pytest.param(f"é{REF_A}€", 2 + len(REF_A) + 2, f"é{REF_A}", id="multibyte-after"),
            pytest.param(
                f"{ATTACHMENT_REF_PREFIX}not-a-hash",
                len(ATTACHMENT_REF_PREFIX) + 3,
                f"{ATTACHMENT_REF_PREFIX}not",
                id="prefix-alone-is-not-a-reference",
            ),
        ],
    )
    def test_cut_to_size_around_one_reference(self, text, max_bytes, expected):
        assert _cut_to_size(text, max_bytes) == expected

    def test_cut_to_size_with_several_references(self):
        text = f"{REF_A} and {REF_B} and {REF_C}"
        after_a = len(REF_A)
        start_b = after_a + len(" and ")
        after_b = start_b + len(REF_B)
        start_c = after_b + len(" and ")

        cuts = {
            after_a // 2: "",
            after_a: REF_A,
            after_a + 2: f"{REF_A} a",
            start_b + 1: f"{REF_A} and ",
            after_b - 1: f"{REF_A} and ",
            after_b: f"{REF_A} and {REF_B}",
            start_c + len(REF_C) // 2: f"{REF_A} and {REF_B} and ",
            len(text): text,
        }
        for max_bytes, expected in cuts.items():
            assert _cut_to_size(text, max_bytes) == expected, max_bytes

    @pytest.mark.parametrize("where", ["just-before", "inside", "just-after"])
    def test_a_reference_the_extractor_wrote_is_never_split(self, where):
        image = make_png(3, 3)
        ref = ref_for(image, "image/png")
        limit = 1000
        keep = limit - len(marker(limit).encode("utf-8"))
        offset = {"just-before": 0, "inside": len(ref) // 2, "just-after": len(ref)}[where]
        before = "p" * (keep - offset)
        row = span(input=f"{before}{data_url(image, 'image/png')}{'z' * 2000}")

        result = extract_attachments(
            FakeS3(), PROJECT, [], [row], config=AttachmentSettings(max_span_bytes=limit)
        )

        kept = f"{before}{ref}" if where == "just-after" else before
        assert row["input"] == kept + marker(limit)
        assert find_attachment_refs(row["input"]) == (
            {sha(image)} if where == "just-after" else set()
        )
        assert row["input"].count(ATTACHMENT_REF_PREFIX) == len(find_attachment_refs(row["input"]))
        assert (result.referenced, result.truncated) == (1, 1)
        assert utf8_total(row) <= limit

    def test_several_references_in_one_field(self):
        images = [make_png(1, 1), make_png(2, 2), make_png(3, 3)]
        refs = [ref_for(image, "image/png") for image in images]
        urls = [data_url(image, "image/png") for image in images]
        limit = 1000
        keep = limit - len(marker(limit).encode("utf-8"))
        # Pad the front so the cut lands in the middle of the second reference.
        head = f"one {refs[0]} two "
        pad = "p" * (keep - len(head) - len(refs[1]) // 2)
        row = span(output=f"{pad}one {urls[0]} two {urls[1]} three {urls[2]} {'z' * 2000}")

        result = extract_attachments(
            FakeS3(), PROJECT, [], [row], config=AttachmentSettings(max_span_bytes=limit)
        )

        assert row["output"] == f"{pad}{head}{marker(limit)}"
        assert find_attachment_refs(row["output"]) == {sha(images[0])}
        assert row["output"].count(ATTACHMENT_REF_PREFIX) == 1
        assert (result.referenced, result.truncated) == (3, 1)


class TestAttachmentSettings:
    def test_defaults(self):
        config = AttachmentSettings()
        assert config.max_image_bytes == 5 * 1024 * 1024
        assert config.max_image_dimension == 16384
        assert config.max_images_per_batch == 1000
        assert config.max_span_bytes == 8 * 1024 * 1024
        assert isinstance(settings.attachments, AttachmentSettings)

    def test_reads_env(self, monkeypatch):
        monkeypatch.setenv("ATTACHMENT_MAX_IMAGE_BYTES", "1024")
        monkeypatch.setenv("ATTACHMENT_MAX_IMAGE_DIMENSION", "2048")
        monkeypatch.setenv("ATTACHMENT_MAX_IMAGES_PER_BATCH", "50")
        monkeypatch.setenv("ATTACHMENT_MAX_SPAN_BYTES", "4096")

        config = AttachmentSettings()

        assert (
            config.max_image_bytes,
            config.max_image_dimension,
            config.max_images_per_batch,
            config.max_span_bytes,
        ) == (1024, 2048, 50, 4096)

    @pytest.mark.parametrize(
        "name",
        [
            "ATTACHMENT_MAX_IMAGE_BYTES",
            "ATTACHMENT_MAX_IMAGE_DIMENSION",
            "ATTACHMENT_MAX_IMAGES_PER_BATCH",
            "ATTACHMENT_MAX_SPAN_BYTES",
        ],
    )
    def test_rejects_zero(self, monkeypatch, name):
        monkeypatch.setenv(name, "0")
        with pytest.raises(ValidationError):
            AttachmentSettings()

    def test_span_limit_is_at_least_256(self):
        with pytest.raises(ValidationError):
            AttachmentSettings(max_span_bytes=255)
        assert AttachmentSettings(max_span_bytes=256).max_span_bytes == 256


class IngestS3(FakeS3):
    """FakeS3 that also serves one staged batch."""

    def __init__(self, payload: dict, **kwargs):
        super().__init__(**kwargs)
        self.payload = payload

    def download_json(self, key: str) -> dict:
        return self.payload


class TestProcessS3Traces:
    TRACE = "aa" * 16
    ROOT = "11" * 8
    CHILD = "22" * 8

    @pytest.fixture()
    def ingest(self, monkeypatch):
        """Run process_s3_traces on a batch, with ClickHouse, Redis and detectors mocked."""
        ch = MagicMock()
        published: list[list[dict]] = []
        enqueue = MagicMock()
        monkeypatch.setattr(
            settings, "attachments", AttachmentSettings(enabled=True, project_ids="")
        )
        monkeypatch.setattr("db.clickhouse.client.get_clickhouse_client", lambda: ch)
        monkeypatch.setattr("worker.detector_tasks.enqueue_detector_runs", enqueue)
        monkeypatch.setattr(
            "worker.ingest_tasks._publish_live_spans",
            lambda spans, project_id: published.append(copy.deepcopy(spans)),
        )

        def run(s3: IngestS3) -> dict:
            from worker.ingest_tasks import process_s3_traces

            monkeypatch.setattr("rest.services.s3.get_s3_service", lambda: s3)
            return process_s3_traces(s3_key="events/otel/key.json", project_id=PROJECT)

        return run, ch, published, enqueue

    def payload(self, image: bytes, mime: str) -> dict:
        url = data_url(image, mime)
        return make_otel_payload(
            [
                make_span(
                    self.TRACE,
                    self.ROOT,
                    name="root",
                    attributes=[
                        make_attr("traceroot.span.input", json.dumps({"screenshot": url})),
                        make_attr("traceroot.span.output", url),
                    ],
                ),
                make_span(
                    self.TRACE,
                    self.CHILD,
                    name="tool",
                    parent_span_id_hex=self.ROOT,
                    attributes=[
                        make_attr(
                            "traceroot.span.output",
                            json.dumps({"mime_type": mime, "data": b64(image)}),
                        )
                    ],
                ),
            ]
        )

    def test_every_reader_sees_references(self, ingest):
        run, ch, published, enqueue = ingest
        image = make_png(2, 2)
        ref = ref_for(image, "image/png")
        s3 = IngestS3(self.payload(image, "image/png"))

        result = run(s3)

        assert result["spans"] == 2
        assert s3.objects == {attachment_key(PROJECT, sha(image)): (image, "image/png")}
        assert s3.puts == [attachment_key(PROJECT, sha(image))]

        inserted_spans = {s["span_id"]: s for s in ch.insert_spans_batch.call_args[0][0]}
        assert json.loads(inserted_spans[self.ROOT]["input"]) == {"screenshot": ref}
        assert inserted_spans[self.ROOT]["output"] == ref
        assert json.loads(inserted_spans[self.CHILD]["output"])["data"] == ref

        (trace_row,) = ch.insert_traces_batch.call_args[0][0]
        assert json.loads(trace_row["input"]) == {"screenshot": ref}
        assert trace_row["output"] == ref

        (live_spans,) = published
        assert {s["span_id"]: s.get("output") for s in live_spans}[self.ROOT] == ref
        enqueue.assert_called_once()

        everything = json.dumps([inserted_spans, trace_row, live_spans], default=str)
        assert b64(image) not in everything

    def test_storage_error_fails_the_task_before_any_insert(self, ingest):
        run, ch, published, enqueue = ingest
        error = ClientError({"Error": {"Code": "SlowDown"}}, "PutObject")
        s3 = IngestS3(self.payload(make_gif(), "image/gif"), put_error=error)

        with pytest.raises(ClientError):
            run(s3)

        ch.insert_spans_batch.assert_not_called()
        ch.insert_traces_batch.assert_not_called()
        assert published == []
        enqueue.assert_not_called()

    def test_batch_without_images_never_touches_attachment_storage(self, ingest):
        run, ch, _, _ = ingest
        payload = make_otel_payload(
            [
                make_span(
                    self.TRACE,
                    self.ROOT,
                    attributes=[make_attr("traceroot.span.input", '{"q": "plain"}')],
                )
            ]
        )
        s3 = IngestS3(payload)

        run(s3)

        assert s3.heads == [] and s3.puts == []
        (span_row,) = ch.insert_spans_batch.call_args[0][0]
        assert span_row["input"] == '{"q": "plain"}'

    def test_attachment_cap_is_enforced_across_chunks(self, ingest, monkeypatch):
        """ATTACHMENT_MAX_IMAGES_PER_BATCH is enforced across all chunks and traces.

        The count budget does not reset between chunk flushes.
        """
        run, ch, _, _ = ingest
        monkeypatch.setattr("worker.ingest_tasks.SPAN_CHUNK_SIZE", 1)
        monkeypatch.setattr(
            settings,
            "attachments",
            AttachmentSettings(enabled=True, project_ids="", max_images_per_batch=1),
        )
        img1 = make_png(2, 2)
        img2 = make_jpeg()
        payload = make_otel_payload(
            [
                make_span(
                    self.TRACE,
                    self.ROOT,
                    name="root",
                    attributes=[
                        make_attr("traceroot.span.output", data_url(img1, "image/png")),
                    ],
                ),
                make_span(
                    self.TRACE,
                    self.CHILD,
                    name="child",
                    parent_span_id_hex=self.ROOT,
                    attributes=[
                        make_attr("traceroot.span.output", data_url(img2, "image/jpeg")),
                    ],
                ),
            ]
        )
        s3 = IngestS3(payload)
        run(s3)

        # SPAN_CHUNK_SIZE=1 ensures two separate chunk flushes occur
        assert len(ch.insert_spans_batch.call_args_list) == 2
        # Only the first image is stored; the second is omitted by the shared batch budget.
        assert s3.puts == [attachment_key(PROJECT, sha(img1))]
        inserted = {
            s["span_id"]: s for c in ch.insert_spans_batch.call_args_list for s in c.args[0]
        }
        assert ref_for(img1, "image/png") in inserted[self.ROOT]["output"]
        assert "[image omitted: more than 1 images in one batch" in inserted[self.CHILD]["output"]

    def test_extractor_config_mismatch_raises(self):
        """Passing mismatched config and extractor configurations raises ValueError."""
        config1 = AttachmentSettings(max_image_bytes=1000)
        config2 = AttachmentSettings(max_image_bytes=2000)
        extractor = AttachmentExtractor(MagicMock(), PROJECT, config1)

        with pytest.raises(ValueError, match="config must match the extractor configuration"):
            extract_attachments(MagicMock(), PROJECT, [], [], config=config2, extractor=extractor)

    def test_shared_extractor_returns_call_delta(self):
        """extract_attachments returns the delta for that call, while extractor accumulates."""
        s3 = FakeS3()
        config = AttachmentSettings(enabled=True, project_ids="")
        extractor = AttachmentExtractor(s3, PROJECT, config)
        img1 = make_png(2, 2)
        img2 = make_jpeg()

        row1 = {"span_id": "1", "output": data_url(img1, "image/png")}
        res1 = extract_attachments(s3, PROJECT, [], [row1], extractor=extractor)
        assert res1.referenced == 1
        assert res1.stored == 1
        assert extractor.result.referenced == 1

        row2 = {"span_id": "2", "output": data_url(img2, "image/jpeg")}
        res2 = extract_attachments(s3, PROJECT, [], [row2], extractor=extractor)
        # Delta for call 2 is 1 (not 2)
        assert res2.referenced == 1
        assert res2.stored == 1
        # Cumulative on extractor is 2
        assert extractor.result.referenced == 2
