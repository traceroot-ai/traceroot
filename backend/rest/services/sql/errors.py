"""SQL Gateway validation error types."""

from __future__ import annotations


class SqlValidationError(ValueError):
    """Raised when a SQL string violates the read-only analytics contract.

    The message is always sanitized: it never echoes the raw SQL, a
    ``project_id``, or internal view names (``spans_public_v1`` /
    ``traces_public_v1``).
    """
