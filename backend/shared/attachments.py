"""Image attachments: the span reference format, the object key layout, and image sniffing.

The ingest worker moves images out of span ``input``/``output``/``metadata`` into
content-addressed objects and leaves a reference string where each image was. The
route that serves an attachment and the trace viewer read those references back,
so the two formats below are a contract between them. Change one only together
with every reader, and never in place: a new layout gets a new version segment.

Reference (what span text holds)::

    traceroot-attachment://v1/sha256/{hex}?mime={mime}&bytes={byte_count}

- ``hex`` is the lowercase SHA-256 of the decoded image bytes, 64 characters.
- ``mime`` is one of ``ALLOWED_IMAGE_MIME_TYPES``. ``bytes`` is the decoded size.
- ``mime`` and ``bytes`` are display hints only. The stored object's
  ``ContentType``, written after the bytes were validated, is authoritative.
- None of its characters is escaped by a JSON encoder, so a reference can replace
  an image inside a stringified-JSON field without breaking the JSON.

Object key (where the bytes live)::

    attachments/{project_id}/sha256/{hex}

Keys are scoped to a project, so two projects never share an object, even when
they send the same image.

Image sniffing reads magic bytes and header-only dimensions for PNG, JPEG, GIF and
WebP. It never decodes pixel data.
"""

import re
import struct
from collections.abc import Callable

ALLOWED_IMAGE_MIME_TYPES: frozenset[str] = frozenset(
    {"image/png", "image/jpeg", "image/gif", "image/webp"}
)
"""The image types that are extracted, stored and served. SVG is excluded: it can carry script."""

ATTACHMENT_REF_PREFIX = "traceroot-attachment://v1/sha256/"
"""Every reference starts with this, followed by the 64-character hash."""

ATTACHMENT_KEY_PREFIX = "attachments/"
"""Every attachment object key starts with this, followed by the project id."""

ATTACHMENT_REF_RE = re.compile(
    r"traceroot-attachment://v1/sha256/(?P<sha256>[0-9a-f]{64})"
    r"\?mime=(?P<mime>image/(?:png|jpeg|gif|webp))&bytes=(?P<bytes>[0-9]+)"
)
"""Matches a reference exactly as ``format_attachment_ref`` writes it, anywhere in a string.

Groups: ``sha256`` (64 lowercase hex), ``mime``, ``bytes`` (decimal).
"""

_SHA256_HEX_RE = re.compile(r"[0-9a-f]{64}")

_MIME_ALIASES = {"image/jpg": "image/jpeg"}


def is_attachment_hash(value: object) -> bool:
    """Return whether ``value`` is a well-formed attachment hash: 64 lowercase hex characters."""
    return isinstance(value, str) and _SHA256_HEX_RE.fullmatch(value) is not None


def normalize_image_mime(declared: object) -> str | None:
    """Map a declared image MIME type to its allowed canonical form.

    Lowercases it, maps ``image/jpg`` to ``image/jpeg``, and returns ``None`` for
    anything outside ``ALLOWED_IMAGE_MIME_TYPES`` (including non-strings).
    """
    if not isinstance(declared, str):
        return None
    mime = declared.strip().lower()
    mime = _MIME_ALIASES.get(mime, mime)
    return mime if mime in ALLOWED_IMAGE_MIME_TYPES else None


def format_attachment_ref(sha256_hex: str, mime: str, byte_count: int) -> str:
    """Build the reference string that replaces an image in span text.

    Args:
        sha256_hex: Lowercase hex SHA-256 of the decoded image bytes.
        mime: The validated image type, one of ``ALLOWED_IMAGE_MIME_TYPES``.
        byte_count: Decoded size of the image in bytes.

    Returns:
        ``traceroot-attachment://v1/sha256/{hex}?mime={mime}&bytes={byte_count}``.

    Raises:
        ValueError: If any argument is outside the format.
    """
    if not is_attachment_hash(sha256_hex):
        raise ValueError("sha256_hex must be 64 lowercase hex characters")
    if mime not in ALLOWED_IMAGE_MIME_TYPES:
        raise ValueError(f"unsupported attachment type: {mime!r}")
    if isinstance(byte_count, bool) or not isinstance(byte_count, int) or byte_count < 0:
        raise ValueError("byte_count must be a non-negative integer")
    return f"{ATTACHMENT_REF_PREFIX}{sha256_hex}?mime={mime}&bytes={byte_count}"


def find_attachment_refs(text: str | None) -> set[str]:
    """Return the hashes of every attachment reference in ``text``.

    Accepts ``None`` and empty text (no references), so a span's nullable
    ``input``/``output``/``metadata`` can be passed as they are.
    """
    if not text or ATTACHMENT_REF_PREFIX not in text:
        return set()
    return {match.group("sha256") for match in ATTACHMENT_REF_RE.finditer(text)}


def attachment_key(project_id: str, sha256_hex: str) -> str:
    """Return the object key ``attachments/{project_id}/sha256/{hex}``.

    Raises:
        ValueError: If ``project_id`` is empty or contains ``/``, or the hash is malformed.
    """
    if not isinstance(project_id, str) or not project_id or "/" in project_id:
        raise ValueError("project_id must be a non-empty string without '/'")
    if not is_attachment_hash(sha256_hex):
        raise ValueError("sha256_hex must be 64 lowercase hex characters")
    return f"{ATTACHMENT_KEY_PREFIX}{project_id}/sha256/{sha256_hex}"


_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_JPEG_SIGNATURE = b"\xff\xd8\xff"
_GIF_SIGNATURES = (b"GIF87a", b"GIF89a")


def sniff_image_mime(data: bytes) -> str | None:
    """Identify an image by its magic bytes.

    Returns:
        One of ``ALLOWED_IMAGE_MIME_TYPES``, or ``None`` when the bytes start like
        none of them.
    """
    if data.startswith(_PNG_SIGNATURE):
        return "image/png"
    if data.startswith(_JPEG_SIGNATURE):
        return "image/jpeg"
    if data.startswith(_GIF_SIGNATURES):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _png_dimensions(data: bytes) -> tuple[int, int] | None:
    # The first chunk must be IHDR: length(4) "IHDR"(4) width(4) height(4), big-endian.
    if data[12:16] != b"IHDR":
        return None
    width, height = struct.unpack_from(">II", data, 16)
    return width, height


def _gif_dimensions(data: bytes) -> tuple[int, int] | None:
    # Logical screen descriptor right after the 6-byte signature, little-endian.
    width, height = struct.unpack_from("<HH", data, 6)
    return width, height


# Start-of-frame markers carry the frame size. C4 (DHT), C8 (JPG) and CC (DAC)
# sit in the same range but are not frame headers.
_JPEG_SOF_MARKERS = frozenset(
    {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
)
# Markers with no length field: TEM, RST0-7, SOI.
_JPEG_STANDALONE_MARKERS = frozenset({0x01, *range(0xD0, 0xD8), 0xD8})


def _jpeg_dimensions(data: bytes) -> tuple[int, int] | None:
    # Walk segment headers from just after SOI, skipping each segment by its
    # length, until the frame header. Pixel data is never read: reaching the
    # start of scan (DA) or the end (D9) first means there is no frame header.
    pos = 2
    size = len(data)
    while pos < size:
        if data[pos] != 0xFF:
            return None
        while pos < size and data[pos] == 0xFF:
            pos += 1
        if pos >= size:
            return None
        marker = data[pos]
        pos += 1
        if marker in _JPEG_STANDALONE_MARKERS:
            continue
        if marker in (0x00, 0xD9, 0xDA):
            return None
        (length,) = struct.unpack_from(">H", data, pos)
        if length < 2:
            return None
        if marker in _JPEG_SOF_MARKERS:
            # length(2) precision(1) height(2) width(2)
            height, width = struct.unpack_from(">HH", data, pos + 3)
            return width, height
        pos += length
    return None


def _webp_dimensions(data: bytes) -> tuple[int, int] | None:
    # RIFF header (12 bytes), then the first chunk: fourcc(4) size(4) payload.
    chunk = data[12:16]
    if chunk == b"VP8X":
        # flags(1) reserved(3), then canvas width-1 and height-1 as 24-bit little-endian.
        if len(data) < 30:
            return None
        width = int.from_bytes(data[24:27], "little") + 1
        height = int.from_bytes(data[27:30], "little") + 1
        return width, height
    if chunk == b"VP8L":
        # Signature byte 0x2F, then 14 bits width-1 and 14 bits height-1.
        if len(data) < 25 or data[20] != 0x2F:
            return None
        bits = int.from_bytes(data[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if chunk == b"VP8 ":
        # Frame tag(3), key-frame start code 9D 01 2A, then 14-bit width and height
        # (the top two bits of each are a scale field).
        if data[23:26] != b"\x9d\x01\x2a":
            return None
        width, height = struct.unpack_from("<HH", data, 26)
        return width & 0x3FFF, height & 0x3FFF
    return None


_DIMENSION_READERS: dict[str, Callable[[bytes], tuple[int, int] | None]] = {
    "image/png": _png_dimensions,
    "image/jpeg": _jpeg_dimensions,
    "image/gif": _gif_dimensions,
    "image/webp": _webp_dimensions,
}


def read_image_dimensions(data: bytes, mime: str) -> tuple[int, int] | None:
    """Read ``(width, height)`` from an image's header, without decoding pixels.

    Args:
        data: The decoded image bytes.
        mime: The type to parse ``data`` as, normally the result of ``sniff_image_mime``.

    Returns:
        ``(width, height)`` in pixels, or ``None`` when ``mime`` is not an allowed
        type or the header is truncated or malformed.
    """
    reader = _DIMENSION_READERS.get(mime)
    if reader is None:
        return None
    try:
        return reader(data)
    except struct.error:
        return None
