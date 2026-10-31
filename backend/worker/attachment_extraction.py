"""Move images out of span text into content-addressed attachments.

Runs once per ingest batch, after the OTLP transform and before the rows are
inserted, published to the live view or handed to detectors, so every reader of
span text sees a short reference where an image was. The reference format and
the object key layout live in ``shared.attachments``.

For the ``input``, ``output`` and ``metadata`` of every span and trace row:

1. **Find** images:
   - ``data:image/{png,jpeg,jpg,gif,webp};base64,...`` anywhere in the text,
     including inside stringified JSON;
   - bare base64 in two known JSON shapes, found by parsing the text as JSON:
     ``{"type": "base64", "media_type": "image/...", "data": ...}`` and
     ``{"mime_type" | "mimeType": "image/...", "data": ...}``.
2. **Validate**: strict base64, magic bytes that match the declared type, and a
   decoded size and pixel dimensions within ``AttachmentSettings``. An image that
   fails becomes ``[image omitted: <reason>, <n> bytes]``.
3. **Store** each image once per batch. A storage error raises, so the task
   retries the whole batch; content-hash keys make the rerun write nothing new.
4. **Replace** each image by exact substitution in the original text. The rest of
   the text keeps its formatting, and JSON around an image stays valid, because
   neither a reference nor a placeholder contains a character JSON escapes.
5. **Cut** a row whose ``input`` + ``output`` + ``metadata`` is still over
   ``max_span_bytes`` in UTF-8: its largest field(s) are shortened and end with
   ``…[truncated: span content exceeded <limit> bytes]``. A cut never splits a
   character or an attachment reference: a reference that would not fit whole is
   dropped whole, so every reference left in the text still points at its image.

Text with no image comes back as the same string object.

Not matched: a known JSON shape inside a string that is itself JSON-encoded
(double-escaped JSON, whose keys read ``\\"data\\"``), and an image written by an
encoder that escapes ``/`` as ``\\/``. Both stay inline, bounded by step 5.
"""

import binascii
import hashlib
import json
import logging
import re
from dataclasses import dataclass
from typing import Any

from shared.attachments import (
    ATTACHMENT_REF_PREFIX,
    ATTACHMENT_REF_RE,
    attachment_key,
    format_attachment_ref,
    normalize_image_mime,
    read_image_dimensions,
    sniff_image_mime,
)
from shared.config import AttachmentSettings, settings

logger = logging.getLogger(__name__)

TEXT_FIELDS = ("input", "output", "metadata")
"""The row fields that are searched for images and counted against ``max_span_bytes``."""

TRUNCATION_MARKER = "…[truncated: span content exceeded {limit} bytes]"
"""Appended to a field cut by the span size limit; ``{limit}`` is ``max_span_bytes``."""

# The subtype is matched case-insensitively. The literal lowercase prefix keeps the
# scan of a large field fast, since the engine can search for it directly.
_DATA_URL_RE = re.compile(
    r"data:image/(?P<subtype>(?i:png|jpeg|jpg|gif|webp));base64,(?P<data>[A-Za-z0-9+/]+={0,2})",
    re.ASCII,
)
_BASE64_RE = re.compile(r"[A-Za-z0-9+/]+={0,2}", re.ASCII)
_JSON_SHAPE_KEYS = ('"media_type"', '"mime_type"', '"mimeType"')


@dataclass
class AttachmentExtractionResult:
    """What one call to ``extract_attachments`` did."""

    referenced: int = 0
    """Images replaced by a reference."""
    stored: int = 0
    """Distinct images this call wrote to storage (the rest were already there)."""
    omitted: int = 0
    """Images replaced by an ``[image omitted: ...]`` placeholder."""
    truncated: int = 0
    """Rows cut to ``max_span_bytes``."""


def extract_attachments(
    s3_service: Any,
    project_id: str,
    traces: list[dict],
    spans: list[dict],
    config: AttachmentSettings | None = None,
) -> AttachmentExtractionResult:
    """Replace the images in a batch's trace and span rows with attachment references.

    Mutates the rows in place: their ``input``, ``output`` and ``metadata`` are
    rewritten, then cut to ``config.max_span_bytes``. See the module docstring for
    what is matched and how each image is validated.

    Args:
        s3_service: Storage with ``object_exists`` and ``put_object_if_absent``
            (``rest.services.s3.S3Service``).
        project_id: Project the batch belongs to; scopes every object key.
        traces: Trace rows from ``transform_otel_to_clickhouse``.
        spans: Span rows from ``transform_otel_to_clickhouse``.
        config: Limits to apply. Defaults to ``settings.attachments``.

    Returns:
        Counts of what was replaced, stored, omitted and cut.

    Raises:
        Exception: Whatever storage raises. The rows may then be partly rewritten,
            so the caller must not insert them; retrying the batch is safe.
    """
    if config is None:
        config = settings.attachments
    extractor = _Extractor(s3_service, project_id, config)
    for row in (*spans, *traces):
        for name in TEXT_FIELDS:
            value = row.get(name)
            if isinstance(value, str) and value:
                rewritten = extractor.rewrite(value)
                if rewritten is not value:
                    row[name] = rewritten
        if _enforce_size_limit(row, config.max_span_bytes):
            extractor.result.truncated += 1

    result = extractor.result
    if result.referenced or result.omitted or result.truncated:
        logger.info(
            "Attachments for project %s: %d image(s) referenced (%d newly stored), "
            "%d omitted, %d row(s) cut to %d bytes",
            project_id,
            result.referenced,
            result.stored,
            result.omitted,
            result.truncated,
            config.max_span_bytes,
        )
    return result


class _Extractor:
    """Per-batch state: limits, storage, and the hashes already stored in this batch."""

    def __init__(self, s3_service: Any, project_id: str, config: AttachmentSettings):
        self._s3 = s3_service
        self._project_id = project_id
        self._config = config
        self._present: set[str] = set()
        self.result = AttachmentExtractionResult()

    def rewrite(self, text: str) -> str:
        """Return ``text`` with every image replaced, or ``text`` itself when it has none."""
        text = _DATA_URL_RE.sub(self._replace_data_url, text)
        # Parsing is the expensive step, so only text that could hold a known shape
        # is parsed: it needs a "data" key, an image type and one of the type keys.
        if '"data"' in text and "image/" in text and any(key in text for key in _JSON_SHAPE_KEYS):
            text = self._replace_json_shapes(text)
        return text

    def _replace_data_url(self, match: re.Match[str]) -> str:
        mime = normalize_image_mime("image/" + match.group("subtype"))
        return self._replacement(mime, match.group("data"))

    def _replace_json_shapes(self, text: str) -> str:
        try:
            parsed = json.loads(text)
        except (ValueError, RecursionError):
            return text

        images: dict[str, str] = {}  # base64 -> declared type
        stack = [parsed]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                found = _known_shape_image(node)
                if found is not None:
                    images.setdefault(found[1], found[0])
                stack.extend(node.values())
            elif isinstance(node, list):
                stack.extend(node)

        for data, mime in images.items():
            # Base64 has no character a standard JSON encoder escapes, so the parsed
            # value appears in the text as a quoted string. An encoder that writes
            # "/" as "\/" is the exception, and that image is left where it is.
            needle = f'"{data}"'
            if needle in text:
                text = text.replace(needle, f'"{self._replacement(mime, data)}"')
        return text

    def _replacement(self, mime: str, data: str) -> str:
        """Validate one base64 image and return its reference, or a placeholder."""
        limits = self._config
        estimated = _decoded_size(data)
        # Checked before decoding, so an oversize image is never materialised.
        if estimated > limits.max_image_bytes:
            return self._omit(f"larger than {limits.max_image_bytes} bytes", estimated)
        image = _strict_b64decode(data)
        if image is None:
            return self._omit("invalid base64", estimated)
        if sniff_image_mime(image) != mime:
            return self._omit(f"content is not {mime}", len(image))
        dimensions = read_image_dimensions(image, mime)
        if dimensions is None:
            return self._omit("unreadable image header", len(image))
        if max(dimensions) > limits.max_image_dimension:
            return self._omit(
                f"larger than {limits.max_image_dimension} pixels per side", len(image)
            )

        digest = hashlib.sha256(image).hexdigest()
        self._store(digest, image, mime)
        self.result.referenced += 1
        return format_attachment_ref(digest, mime, len(image))

    def _store(self, digest: str, image: bytes, mime: str) -> None:
        if digest in self._present:
            return
        key = attachment_key(self._project_id, digest)
        # HEAD first so a retried batch, or an image already sent, does not upload
        # the bytes again. The conditional PUT covers a writer racing this one.
        if not self._s3.object_exists(key) and self._s3.put_object_if_absent(key, image, mime):
            self.result.stored += 1
        self._present.add(digest)

    def _omit(self, reason: str, byte_count: int) -> str:
        self.result.omitted += 1
        return f"[image omitted: {reason}, {byte_count} bytes]"


def _known_shape_image(node: dict) -> tuple[str, str] | None:
    """``(type, base64)`` when ``node`` is one of the known image shapes, else None."""
    data = node.get("data")
    if not isinstance(data, str) or _BASE64_RE.fullmatch(data) is None:
        return None
    declared = node.get("media_type") if node.get("type") == "base64" else None
    if declared is None:
        declared = node.get("mime_type", node.get("mimeType"))
    mime = normalize_image_mime(declared)
    if mime is None:
        return None
    return mime, data


def _strict_b64decode(data: str) -> bytes | None:
    """Decode canonical, padded base64, or return None.

    The length check is not redundant: Python 3.11's strict mode still accepts
    padding after a complete 4-character group (``"abcd="``).
    """
    if len(data) % 4:
        return None
    try:
        return binascii.a2b_base64(data, strict_mode=True)
    except binascii.Error:
        return None


def _decoded_size(data: str) -> int:
    padding = 2 if data.endswith("==") else 1 if data.endswith("=") else 0
    return len(data) * 3 // 4 - padding


def _utf8_size(text: str) -> int:
    # isascii() is a flag check on CPython, so the common case costs nothing.
    return len(text) if text.isascii() else len(text.encode("utf-8", "surrogatepass"))


def _cut_to_size(text: str, max_bytes: int) -> str:
    """The longest prefix of ``text`` that fits in ``max_bytes`` UTF-8 bytes.

    The prefix never ends inside a character or inside an attachment reference: a
    reference that would not fit whole is left out whole.
    """
    if text.isascii():
        kept = text[:max_bytes]
    else:
        encoded = text.encode("utf-8", "surrogatepass")
        if len(encoded) <= max_bytes:
            return text
        end = max_bytes
        while end > 0 and (encoded[end] & 0xC0) == 0x80:  # never cut through a character
            end -= 1
        kept = encoded[:end].decode("utf-8", "surrogatepass")
    # ``kept`` is a prefix of ``text``, so its length is where the cut falls in ``text``.
    return kept[: _start_of_split_reference(text, len(kept))]


def _start_of_split_reference(text: str, end: int) -> int:
    """Where a reference that a cut at ``end`` would split starts, or ``end`` if none would."""
    # References never overlap, so only the last one starting before ``end`` can
    # straddle it. The search bound lets that start be anywhere up to ``end - 1``,
    # including a cut that falls inside the prefix itself.
    start = text.rfind(ATTACHMENT_REF_PREFIX, 0, end + len(ATTACHMENT_REF_PREFIX) - 1)
    if start != -1:
        match = ATTACHMENT_REF_RE.match(text, start)
        if match is not None and match.end() > end:
            return start
    return end


def _enforce_size_limit(row: dict, limit: int) -> bool:
    """Cut the row's largest text field(s) until the row fits ``limit``. True if it cut."""
    sizes: dict[str, int] = {}
    for name in TEXT_FIELDS:
        value = row.get(name)
        if isinstance(value, str):
            sizes[name] = _utf8_size(value)
    total = sum(sizes.values())
    if total <= limit:
        return False

    marker = TRUNCATION_MARKER.format(limit=limit)
    marker_size = _utf8_size(marker)
    cut = False
    for name in sorted(sizes, key=sizes.__getitem__, reverse=True):
        excess = total - limit
        if excess <= 0:
            break
        keep = max(sizes[name] - excess - marker_size, 0)
        if keep + marker_size >= sizes[name]:
            continue  # cutting a field this small would not shrink it
        row[name] = _cut_to_size(row[name], keep) + marker
        new_size = _utf8_size(row[name])
        total += new_size - sizes[name]
        sizes[name] = new_size
        cut = True
    return cut
