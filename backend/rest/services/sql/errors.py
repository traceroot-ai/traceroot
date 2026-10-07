"""SQL Gateway validation error types."""

from __future__ import annotations


class SqlValidationError(ValueError):
    """Raised when a SQL string violates the read-only analytics contract.

    The message is always sanitized: it never echoes the raw SQL, a
    ``project_id``, or internal view names (``spans_public_v1`` /
    ``traces_public_v1``).
    """


class SqlExecutionError(RuntimeError):
    """Raised when a validated, scoped query fails at execution.

    Carries a message safe to return to the caller, which never echoes the raw
    SQL, a ``project_id``, or an internal view name, and a flag saying whether
    the caller can do anything about it. ``is_client_error`` true means the
    query asked for too much or was malformed in a way the caller controls, and
    the endpoint answers 400. False means the gateway failed and answers 500.
    """

    def __init__(self, message: str, *, is_client_error: bool) -> None:
        super().__init__(message)
        self.is_client_error = is_client_error
