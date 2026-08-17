"""Unit tests for the opaque list-pagination cursor codec."""

from datetime import datetime

import pytest

from rest.pagination import decode_cursor, encode_cursor


def test_round_trip_preserves_timestamp_and_id():
    ts = datetime(2026, 8, 17, 19, 3, 46, 820000)
    token = encode_cursor(ts, "f-123")
    assert isinstance(token, str)
    assert "=" not in token  # url-safe, unpadded
    decoded_ts, decoded_id = decode_cursor(token)
    assert decoded_ts == ts
    assert decoded_id == "f-123"


def test_token_is_opaque_but_stable():
    ts = datetime(2026, 1, 1)
    assert encode_cursor(ts, "a") == encode_cursor(ts, "a")
    assert encode_cursor(ts, "a") != encode_cursor(ts, "b")


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "not-base64!!",
        "aGVsbG8",
        "eyJ0Ijoibm9wZSIsImkiOiJ4In0",
        "eyJ0IjoiMjAyNi0wMS0wMVQwMDowMDowMCJ9",
    ],
)
def test_malformed_tokens_raise_value_error(bad):
    with pytest.raises(ValueError):
        decode_cursor(bad)
