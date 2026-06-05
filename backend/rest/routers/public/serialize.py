"""Serializers shared by the public trace read + export endpoints.

Keeping these in one place guarantees `traces get` and `export.trace` produce
the identical payload, and that `git_context` is assembled the same way
everywhere.
"""

from rest.url_utils import build_trace_url
from shared.config import settings


def public_trace_detail(trace: dict, project_id: str) -> dict:
    """The public `traces get` payload: the trace dict + a backend-built trace_url."""
    return {
        **trace,
        "trace_url": build_trace_url(settings.traceroot_ui_url, project_id, trace["trace_id"]),
    }


def git_context(trace: dict) -> dict:
    """git_context.json: repo/ref + per-span source locations (trace-resident git only).

    This is NOT GitHub commit/PR/issue history — only the git metadata already
    captured on the trace and its spans.
    """
    sources = [
        {
            "span_id": span["span_id"],
            "file": span.get("git_source_file"),
            "line": span.get("git_source_line"),
            "function": span.get("git_source_function"),
        }
        for span in trace.get("spans", [])
        # A source row needs at least a file or a function to be meaningful.
        if span.get("git_source_file") or span.get("git_source_function")
    ]
    return {
        "git_repo": trace.get("git_repo"),
        "git_ref": trace.get("git_ref"),
        "sources": sources,
    }


def export_bundle(trace: dict, project_id: str) -> dict:
    """Assemble the V1 export bundle (trace + spans + git_context + manifest)."""
    detail = public_trace_detail(trace, project_id)
    return {
        "manifest": {
            "trace_id": trace["trace_id"],
            "project_id": project_id,
            "bundle_version": "v1",
            "files": ["trace.json", "spans.json", "git_context.json", "manifest.json"],
        },
        "trace": detail,
        "spans": detail["spans"],
        "git_context": git_context(trace),
    }
