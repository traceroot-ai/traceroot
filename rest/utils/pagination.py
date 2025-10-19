import base64
import json
from typing import Any


def encode_pagination_token(state: dict[str, Any]) -> str:
    """Encode pagination state into URL-safe opaque token.

    Args:
        state: Dictionary containing pagination state

    Returns:
        Base64-encoded URL-safe string token

    Example:
        >>> state = {'provider': 'aws', 'next_token': 'ABC123'}
        >>> token = encode_pagination_token(state)
        >>> token
        'eyJuZXh0X3Rva2VuIjoiQUJDMTIzIiwicHJvdmlkZXIiOiJhd3MifQ=='
    """
    json_str = json.dumps(state, sort_keys=True)
    return base64.urlsafe_b64encode(json_str.encode('utf-8')).decode('utf-8')


def decode_pagination_token(token: str) -> dict[str, Any]:
    """Decode pagination token back to state dictionary.

    Args:
        token: Base64-encoded pagination token string

    Returns:
        Dictionary containing pagination state

    Raises:
        ValueError: If token is invalid or cannot be decoded

    Example:
        >>> token = 'eyJuZXh0X3Rva2VuIjoiQUJDMTIzIiwicHJvdmlkZXIiOiJhd3MifQ=='
        >>> state = decode_pagination_token(token)
        >>> state
        {'next_token': 'ABC123', 'provider': 'aws'}
    """
    try:
        json_str = base64.urlsafe_b64decode(token.encode('utf-8')).decode('utf-8')
        return json.loads(json_str)
    except (ValueError, json.JSONDecodeError) as e:
        raise ValueError(f"Invalid pagination token: {e}")
