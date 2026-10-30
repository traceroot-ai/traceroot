"""Tiny image byte strings built in code, for the attachment tests.

The PNG and GIF builders produce complete, decodable files. The JPEG and WebP
builders produce valid headers (the part the sniffing and dimension code reads)
followed by filler, which is all the extraction path looks at.
"""

import base64
import struct
import zlib


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    crc = zlib.crc32(kind + payload) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", crc)


def make_png(width: int = 1, height: int = 1, *, pad: int = 0) -> bytes:
    """A grayscale PNG of the given size. ``pad`` appends a private ancillary chunk."""
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    # Only small images get real pixel rows; a huge declared size keeps one empty
    # row so the test never allocates width * height bytes.
    if width * height <= 4096:
        raw = b"".join(b"\x00" + b"\x7f" * width for _ in range(height))
    else:
        raw = b"\x00"
    chunks = _png_chunk(b"IHDR", ihdr)
    if pad:
        chunks += _png_chunk(b"prVt", bytes(range(256)) * (pad // 256) + b"\x00" * (pad % 256))
    chunks += _png_chunk(b"IDAT", zlib.compress(raw)) + _png_chunk(b"IEND", b"")
    return b"\x89PNG\r\n\x1a\n" + chunks


def make_gif(width: int = 1, height: int = 1) -> bytes:
    """A two-colour GIF89a whose logical screen is ``width`` x ``height``."""
    screen = b"GIF89a" + struct.pack("<HHBBB", width, height, 0x80, 0, 0)
    palette = b"\x00\x00\x00\xff\xff\xff"
    image = b"\x2c" + struct.pack("<HHHHB", 0, 0, 1, 1, 0)
    pixels = b"\x02\x02\x44\x01\x00"  # LZW min code size 2, one sub-block, terminator
    return screen + palette + image + pixels + b"\x3b"


def make_jpeg(width: int = 1, height: int = 1, *, sof: int = 0xC0, app_bytes: int = 16) -> bytes:
    """SOI, an APP0 segment of ``app_bytes``, a frame header (``sof``) and EOI."""
    app0 = b"JFIF\x00" + b"\x00" * max(app_bytes - 5, 0)
    segments = b"\xff\xe0" + struct.pack(">H", len(app0) + 2) + app0
    frame = struct.pack(">BHHB", 8, height, width, 1) + b"\x01\x11\x00"
    segments += bytes((0xFF, sof)) + struct.pack(">H", len(frame) + 2) + frame
    return b"\xff\xd8" + segments + b"\xff\xd9"


def _riff(chunk: bytes, payload: bytes) -> bytes:
    body = b"WEBP" + chunk + struct.pack("<I", len(payload)) + payload
    return b"RIFF" + struct.pack("<I", len(body)) + body


def make_webp_vp8x(width: int = 1, height: int = 1) -> bytes:
    """An extended-format WebP header with the given canvas size."""
    payload = (
        b"\x00\x00\x00\x00" + (width - 1).to_bytes(3, "little") + (height - 1).to_bytes(3, "little")
    )
    return _riff(b"VP8X", payload)


def make_webp_vp8l(width: int = 1, height: int = 1) -> bytes:
    """A lossless WebP header with the given size."""
    bits = (width - 1) | ((height - 1) << 14)
    return _riff(b"VP8L", b"\x2f" + bits.to_bytes(4, "little") + b"\x00" * 4)


def make_webp_vp8(width: int = 1, height: int = 1) -> bytes:
    """A lossy WebP key-frame header with the given size."""
    payload = b"\x00\x00\x00" + b"\x9d\x01\x2a" + struct.pack("<HH", width, height) + b"\x00" * 4
    return _riff(b"VP8 ", payload)


def b64(data: bytes) -> str:
    """Standard padded base64 text for ``data``."""
    return base64.b64encode(data).decode("ascii")


def data_url(data: bytes, mime: str) -> str:
    """A ``data:{mime};base64,...`` URL for ``data``."""
    return f"data:{mime};base64,{b64(data)}"
