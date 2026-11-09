"""Redaction hooks applied to every span before it leaves the machine.

A hook has the same contract as the SDK's `redact` option: it receives a span's
attributes and returns the attributes to send. Raw ingest bypasses the SDK, so
an import must redact here or personal data reaches TraceRoot unredacted.

`--redact basic` blanks emails, phone numbers, and US social security numbers.
Names and addresses need a customer-specific hook: `--redact path/to/file.py:fn`
or `--redact package.module:fn`.
"""

import importlib
import importlib.util
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

Redactor = Callable[[dict[str, Any]], dict[str, Any]]

REDACTED = "[REDACTED]"
_BASIC_PATTERNS = (
    re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"),  # email
    re.compile(r"(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)"),  # US SSN
    re.compile(
        r"(?<![\w-])(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\w-])"
    ),  # phone
)


def _scrub(text: str) -> str:
    for pattern in _BASIC_PATTERNS:
        text = pattern.sub(REDACTED, text)
    return text


def basic(attributes: dict[str, Any]) -> dict[str, Any]:
    """Blank emails, phone numbers, and SSNs in every string attribute."""
    cleaned: dict[str, Any] = {}
    for key, value in attributes.items():
        if isinstance(value, str):
            cleaned[key] = _scrub(value)
        elif isinstance(value, list):
            cleaned[key] = [_scrub(v) if isinstance(v, str) else v for v in value]
        else:
            cleaned[key] = value
    return cleaned


def load_redactor(spec: str | None) -> Redactor | None:
    """Resolve `basic`, `path/to/file.py:function`, or `package.module:function`."""
    if not spec:
        return None
    if spec == "basic":
        return basic
    target, sep, func_name = spec.rpartition(":")
    if not sep or not target or not func_name:
        raise SystemExit(f"--redact must be 'basic' or 'module:function', got {spec!r}")
    if target.endswith(".py"):
        path = Path(target).resolve()
        module_spec = importlib.util.spec_from_file_location(path.stem, path)
        if module_spec is None or module_spec.loader is None:
            raise SystemExit(f"Cannot load redaction module from {path}")
        module = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(module)
    else:
        module = importlib.import_module(target)
    func = getattr(module, func_name, None)
    if not callable(func):
        raise SystemExit(f"{spec!r} does not name a callable")
    return func
