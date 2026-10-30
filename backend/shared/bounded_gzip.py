"""Gunzip with a ceiling on the decompressed size.

``gzip.decompress`` inflates the whole input before its size can be checked, so a
few kilobytes of crafted gzip can expand to gigabytes. These helpers inflate one
chunk at a time and stop as soon as the running total passes the limit, so the
output held in memory never grows past the limit plus one chunk.
"""

import zlib
from collections.abc import Iterator

# The most bytes a single decompress call returns.
_CHUNK_BYTES = 64 * 1024

# zlib window bits that expect a gzip header and trailer (and verify the trailer).
_GZIP_WBITS = 16 + zlib.MAX_WBITS


class GzipTooLargeError(ValueError):
    """The decompressed data exceeds the allowed size."""

    def __init__(self, max_bytes: int) -> None:
        super().__init__(f"decompressed data exceeds {max_bytes} bytes")
        self.max_bytes = max_bytes


def iter_gunzip(data: bytes, max_bytes: int) -> Iterator[bytes]:
    """Yield the decompressed content of ``data`` one chunk at a time.

    Accepts what ``gzip.decompress`` accepts: one or more concatenated gzip
    members, optionally followed by NUL padding.

    Args:
        data (bytes): A complete gzip stream.
        max_bytes (int): The most decompressed bytes allowed in total.

    Yields:
        bytes: Up to 64 KiB of decompressed content at a time.

    Raises:
        GzipTooLargeError: As soon as the total would pass ``max_bytes``; the
            chunk that crosses the limit is never yielded.
        zlib.error: If ``data`` is not valid gzip (a bad header, corrupt data,
            or a checksum or length mismatch in the trailer).
        EOFError: If ``data`` ends before the end of a gzip member.
    """
    total = 0
    remaining = data
    while remaining:
        inflater = zlib.decompressobj(_GZIP_WBITS)
        pending = remaining
        while True:
            chunk = inflater.decompress(pending, _CHUNK_BYTES)
            total += len(chunk)
            if total > max_bytes:
                raise GzipTooLargeError(max_bytes)
            if chunk:
                yield chunk
            if inflater.eof:
                break
            pending = inflater.unconsumed_tail
            # No output and no input left means zlib is waiting for bytes
            # that will never come.
            if not chunk and not pending:
                raise EOFError("gzip data ended before the end of the stream")
        remaining = inflater.unused_data.lstrip(b"\x00")


def gunzip(data: bytes, max_bytes: int) -> bytes:
    """Decompress ``data``, refusing output larger than ``max_bytes``.

    Args:
        data (bytes): A complete gzip stream.
        max_bytes (int): The most decompressed bytes allowed.

    Returns:
        bytes: The decompressed content.

    Raises:
        GzipTooLargeError: If the output would pass ``max_bytes``.
        zlib.error: If ``data`` is not valid gzip.
        EOFError: If ``data`` is truncated.
    """
    return b"".join(iter_gunzip(data, max_bytes))
