"""Git context utilities for capturing source location and repo info."""

import inspect
import logging
import os
import subprocess

logger = logging.getLogger(__name__)

# Directory of this package — used to identify SDK-internal frames
_PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))

# Additional library paths to skip when walking the call stack
_SKIP_LIBRARIES = [
    "opentelemetry",
    "openinference",
]

# Cached git root path (None = not yet detected, "" = detection failed)
_git_root_cache: str | None = None


def _get_git_root() -> str | None:
    """Get the git repository root directory. Cached for performance."""
    global _git_root_cache
    if _git_root_cache is not None:
        return _git_root_cache if _git_root_cache else None

    try:
        git_root = subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        ).strip()
        _git_root_cache = git_root
        return git_root
    except Exception:
        _git_root_cache = ""  # Mark as failed
        return None


def capture_source_location() -> dict[str, str | int | None]:
    """Walk up the call stack to find the first frame outside SDK internals.

    Returns dict with git_source_file, git_source_line, git_source_function.
    """
    frame = inspect.currentframe()
    try:
        while frame:
            frame = frame.f_back
            if frame is None:
                break

            filename = frame.f_code.co_filename

            # Skip SDK internal frames (this package)
            if filename.startswith(_PACKAGE_DIR):
                continue

            # Skip known library frames
            if any(lib in filename for lib in _SKIP_LIBRARIES):
                continue

            # Skip frames from frozen/built-in modules
            if filename.startswith("<"):
                continue

            # Found user code
            return {
                "git_source_file": _relative_path(filename),
                "git_source_line": frame.f_lineno,
                "git_source_function": frame.f_code.co_name,
            }
    finally:
        del frame  # Avoid reference cycles

    return {}


def _relative_path(filepath: str) -> str:
    """Convert absolute path to relative (from git root, fallback to cwd)."""
    # Try git root first for correct GitHub links
    git_root = _get_git_root()
    if git_root and filepath.startswith(git_root):
        return filepath[len(git_root) :].lstrip(os.sep)

    # Fallback to cwd
    cwd = os.getcwd()
    if filepath.startswith(cwd):
        return filepath[len(cwd) :].lstrip(os.sep)
    return filepath


def auto_detect_git_context() -> dict[str, str | None]:
    """Auto-detect git_repo and git_ref from local git repo.

    Returns dict with git_repo and git_ref keys (values may be None).
    """
    result: dict[str, str | None] = {"git_repo": None, "git_ref": None}

    try:
        # Get remote URL
        remote = subprocess.check_output(
            ["git", "remote", "get-url", "origin"],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        ).strip()

        # Parse owner/repo from URL
        # Handles: https://github.com/o/r.git, git@github.com:o/r.git, ssh://git@github.com/o/r.git
        import re

        match = re.match(
            r"(?:https?://|ssh://git@|git@)github\.com[:/](.+?)(?:\.git)?$",
            remote,
        )
        if match:
            result["git_repo"] = match.group(1).rstrip("/")
    except Exception:
        pass

    try:
        # Get current commit SHA
        ref = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        ).strip()
        result["git_ref"] = ref
    except Exception:
        pass

    return result
