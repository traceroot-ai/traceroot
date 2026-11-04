"""Gunzip with a ceiling on the decompressed size.

``gzip.decompress`` inflates the whole input before its size can be checked, so a
few kilobytes of crafted gzip can expand to gigabytes. These helpers inflate one
chunk at a time and stop as soon as the running total passes the limit, so the
output held in memory never grows past the limit plus one chunk. They also hand
zlib the input one bounded window at a time and cap the number of gzip members,
so the work stays linear in the size of the input.
"""

import re
import zlib
from collections.abc import Iterator

# The most bytes a single decompress call returns.
_CHUNK_BYTES = 64 * 1024

# The most input handed to zlib at once. On every call zlib copies the input it
# hasn't used into ``unconsumed_tail`` or ``unused_data``, so handing it the whole
# rest of the body would copy that rest once per output chunk and once per member.
_WINDOW_BYTES = 64 * 1024

# OTLP exporters send a request body as one gzip member. A few concatenated members
# are accepted, as gzip.decompress accepts them, but each one needs a new inflater
# and a copy of up to one window, so a body of many tiny members is refused as
# invalid gzip rather than walked member by member.
_MAX_MEMBERS = 16

# zlib window bits that expect a gzip header and trailer (and verify the trailer).
_GZIP_WBITS = 16 + zlib.MAX_WBITS

# NUL padding after a gzip member.
_NUL_RUN = re.compile(rb"\x00*")


class GzipTooLargeError(ValueError):
    """The decompressed data exceeds the allowed size."""

    def __init__(self, max_bytes: int) -> None:
        super().__init__(f"decompressed data exceeds {max_bytes} bytes")
        self.max_bytes = max_bytes


class GzipTooManyMembersError(zlib.error):
    """The data holds more gzip members than allowed.

    It is a ``zlib.error``, so callers refuse it like any other invalid gzip.
    """

    def __init__(self, max_members: int) -> None:
        super().__init__(f"gzip data holds more than {max_members} members")
        self.max_members = max_members


def iter_gunzip(data: bytes, max_bytes: int) -> Iterator[bytes]:
    """Yield the decompressed content of ``data`` one chunk at a time.

    Accepts what ``gzip.decompress`` accepts, up to 16 members: one or more
    concatenated gzip members, each optionally followed by NUL padding.

    Args:
        data (bytes): A complete gzip stream.
        max_bytes (int): The most decompressed bytes allowed in total.

    Yields:
        bytes: Up to 64 KiB of decompressed content at a time.

    Raises:
        GzipTooLargeError: As soon as the total would pass ``max_bytes``; the
            chunk that crosses the limit is never yielded.
        zlib.error: If ``data`` is not valid gzip (a bad header, corrupt data,
            or a checksum or length mismatch in the trailer), or holds more
            than 16 members (``GzipTooManyMembersError``).
        EOFError: If ``data`` ends before the end of a gzip member.
    """
    view = memoryview(data)
    end = len(view)
    pos = 0
    total = 0
    members = 0
    while pos < end:
        members += 1
        if members > _MAX_MEMBERS:
            raise GzipTooManyMembersError(_MAX_MEMBERS)
        inflater = zlib.decompressobj(_GZIP_WBITS)
        pending: bytes | memoryview = b""
        while True:
            if not pending and pos < end:
                pending = view[pos : pos + _WINDOW_BYTES]
                pos += len(pending)
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
            if not chunk and not pending and pos == end:
                raise EOFError("gzip data ended before the end of the stream")
        # zlib read past the end of the member, so step back to where it ended.
        # NUL padding after a member is skipped, as gzip.decompress skips it.
        pos = _NUL_RUN.match(data, pos - len(inflater.unused_data)).end()


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
