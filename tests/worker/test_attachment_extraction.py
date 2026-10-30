"""Tests for moving span images into attachments at ingest."""

import copy
import hashlib
import json
from unittest.mock import MagicMock

import boto3
import pytest
from botocore.exceptions import ClientError
from botocore.stub import Stubber
from pydantic import ValidationError

from rest.services.s3 import S3Service
from shared.attachments import attachment_key, find_attachment_refs, format_attachment_ref
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
from worker.attachment_extraction import (
    TRUNCATION_MARKER,
    _cut_to_size,
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
        # A data URL has nothing a JSON encoder escapes, so it is found and replaced
        # even inside JSON that was encoded twice, and both layers stay valid.
        image = make_png()
        inner = json.dumps({"url": data_url(image, "image/png")})
        text = json.dumps({"messages": [inner]})
        row = span(input=text)

        extract_attachments(FakeS3(), PROJECT, [], [row])

        outer = json.loads(row["input"])
        assert json.loads(outer["messages"][0]) == {"url": ref_for(image, "image/png")}


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


RIFF_AUDIO = b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 24
PNG_WITHOUT_IHDR = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
WIDE_PNG = make_png(16385, 1)
TALL_PNG = make_png(1, 16385)
HUGE_WEBP = make_webp_vp8x(20000, 20000)


class TestValidation:
    @pytest.mark.parametrize(
        ("url", "reason", "byte_count"),
        [
            pytest.param(
                data_url(make_jpeg(), "image/png"),
                "content is not image/png",
                len(make_jpeg()),
                id="jpeg-declared-as-png",
            ),
            pytest.param(
                data_url(RIFF_AUDIO, "image/webp"),
                "content is not image/webp",
                len(RIFF_AUDIO),
                id="riff-audio-declared-as-webp",
            ),
            pytest.param(
                data_url(b"hello world!", "image/gif"),
                "content is not image/gif",
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

    def test_strict_decode_rejects_excess_padding_in_a_shape(self):
        # 12 characters plus "=": a padded group past a complete one.
        row = span(input=json.dumps({"mime_type": "image/png", "data": "iVBORw0KGgoA="}))

        result = extract_attachments(FakeS3(), PROJECT, [], [row])

        assert json.loads(row["input"]) == {
            "mime_type": "image/png",
            "data": "[image omitted: invalid base64, 8 bytes]",
        }
        assert result.omitted == 1

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

    def test_over_size_is_never_decoded(self):
        image = make_png(1, 1, pad=600)
        config = AttachmentSettings(max_image_bytes=500)
        s3 = FakeS3()
        row = span(input=data_url(image, "image/png"))

        result = extract_attachments(s3, PROJECT, [], [row], config=config)

        assert row["input"] == f"[image omitted: larger than 500 bytes, {len(image)} bytes]"
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
        text = json.dumps({"url": data_url(make_jpeg(), "image/png"), "note": "ok"})
        row = span(input=text)

        extract_attachments(FakeS3(), PROJECT, [], [row])

        assert json.loads(row["input"]) == {
            "url": f"[image omitted: content is not image/png, {len(make_jpeg())} bytes]",
            "note": "ok",
        }


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
        config = AttachmentSettings(max_span_bytes=200)
        row = span(input="i" * 300, output="o" * 290)

        extract_attachments(FakeS3(), PROJECT, [], [row], config=config)

        assert row["input"] == marker(200)
        assert row["output"].startswith("o") and row["output"].endswith(marker(200))
        assert utf8_total(row) == 200

    def test_a_field_smaller_than_the_marker_is_never_grown(self):
        config = AttachmentSettings(max_span_bytes=60)
        row = span(input="i" * 70, output="o" * 30)

        extract_attachments(FakeS3(), PROJECT, [], [row], config=config)

        assert row["input"] == marker(60)
        assert row["output"] == "o" * 30

    def test_fields_all_smaller_than_the_marker_are_not_counted_as_cut(self):
        config = AttachmentSettings(max_span_bytes=10)
        row = span(input="i" * 8, output="o" * 8)

        result = extract_attachments(FakeS3(), PROJECT, [], [row], config=config)

        assert (row["input"], row["output"]) == ("i" * 8, "o" * 8)
        assert result.truncated == 0

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
        config = AttachmentSettings(max_span_bytes=100)
        trace = {"trace_id": "trace-a", "input": "x" * 500}

        extract_attachments(FakeS3(), PROJECT, [trace], [], config=config)

        assert trace["input"].endswith(marker(100))
        assert utf8_total(trace) == 100

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


class TestAttachmentSettings:
    def test_defaults(self):
        config = AttachmentSettings()
        assert config.max_image_bytes == 5 * 1024 * 1024
        assert config.max_image_dimension == 16384
        assert config.max_span_bytes == 8 * 1024 * 1024
        assert isinstance(settings.attachments, AttachmentSettings)

    def test_reads_env(self, monkeypatch):
        monkeypatch.setenv("ATTACHMENT_MAX_IMAGE_BYTES", "1024")
        monkeypatch.setenv("ATTACHMENT_MAX_IMAGE_DIMENSION", "2048")
        monkeypatch.setenv("ATTACHMENT_MAX_SPAN_BYTES", "4096")

        config = AttachmentSettings()

        assert (config.max_image_bytes, config.max_image_dimension, config.max_span_bytes) == (
            1024,
            2048,
            4096,
        )

    @pytest.mark.parametrize(
        "name",
        [
            "ATTACHMENT_MAX_IMAGE_BYTES",
            "ATTACHMENT_MAX_IMAGE_DIMENSION",
            "ATTACHMENT_MAX_SPAN_BYTES",
        ],
    )
    def test_rejects_zero(self, monkeypatch, name):
        monkeypatch.setenv(name, "0")
        with pytest.raises(ValidationError):
            AttachmentSettings()


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
