"""Opaque keyset-pagination cursor for public list reads.

The token encodes the (timestamp, id) of the last row a page returned; the
next page filters on (timestamp, id) < (cursor) under a total ordering of
ORDER BY timestamp DESC, id DESC. Base64url keeps it URL-safe; clients must
treat it as opaque — the encoding may change.
"""

import base64
import binascii
import json
from datetime import datetime


def encode_cursor(timestamp: datetime, item_id: str) -> str:
    """Encode a keyset position as an opaque URL-safe token.

    Args:
        timestamp (datetime): The last returned row's timestamp (naive UTC).
        item_id (str): The last returned row's id (tie-breaker).

    Returns:
        str: Unpadded base64url token.
    """
    payload = json.dumps({"t": timestamp.isoformat(), "i": item_id})
    return base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")


def decode_cursor(token: str) -> tuple[datetime, str]:
    """Decode an opaque cursor back to its keyset position.

    Args:
        token (str): A token previously produced by :func:`encode_cursor`.

    Returns:
        tuple[datetime, str]: The (timestamp, id) keyset position.

    Raises:
        ValueError: If the token is not a valid cursor in any way (bad
            base64, bad JSON, missing keys, unparsable timestamp).
    """
    try:
        padded = token + "=" * (-len(token) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
        return datetime.fromisoformat(payload["t"]), str(payload["i"])
    except (binascii.Error, json.JSONDecodeError, KeyError, TypeError, UnicodeDecodeError) as e:
        raise ValueError("invalid cursor") from e
