"""Read a public API request body under a byte cap."""

from collections.abc import Callable

from fastapi import HTTPException, Request


async def read_capped_body(
    request: Request, max_bytes: int, too_large: Callable[[], HTTPException]
) -> bytes:
    """Buffer the request body, refusing anything over ``max_bytes``.

    A declared ``Content-Length`` over the cap is refused before any of the body
    is read. The running count is what enforces the cap, since a chunked body has
    no length and a declared one can be wrong.

    Args:
        request (Request): The request.
        max_bytes (int): The most body bytes accepted, as sent on the wire.
        too_large (Callable[[], HTTPException]): Builds the error for a body over
            the cap, so each route keeps its own 413 detail.

    Returns:
        bytes: The body as sent.

    Raises:
        HTTPException: The one ``too_large`` builds, if the body exceeds ``max_bytes``.
    """
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > max_bytes:
        raise too_large()
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > max_bytes:
            raise too_large()
        chunks.append(chunk)
    return b"".join(chunks)
