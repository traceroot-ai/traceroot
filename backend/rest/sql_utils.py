"""Shared helpers for building ClickHouse parameterized queries.

These are cross-module utilities — both `services/trace_reader.py` and
`routers/internal/detectors.py` rely on them, so the helpers live in a feature-neutral
spot rather than as private symbols inside any one caller.
"""

from shared.datetime_utils import to_utc_naive as to_utc_naive


def escape_ilike(value: str) -> str:
    """Escape ClickHouse ILIKE wildcards (`%`, `_`) plus the escape char itself.

    ClickHouse ILIKE treats `%` and `_` as wildcards and uses backslash as the
    default escape character. Wrapping user input through this function makes
    those characters match literally instead — e.g. searching for "100%" hits
    rows literally containing "100%", not every row containing "100".
    """
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
