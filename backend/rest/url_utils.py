"""Shared helpers for building TraceRoot UI links.

The backend owns the UI URL shape so API clients (e.g. the CLI) never need to
know the frontend route layout or a second host — they receive ready-to-use
links. This is a feature-neutral utility: `whoami` and the public traces
list/get endpoints all build their `trace_url` / `ui_base_url` through here.
"""

from urllib.parse import quote, urlencode


def build_trace_url(ui_base_url: str, project_id: str, trace_id: str) -> str:
    """Build the UI link to a single trace's detail view.

    Shape: ``{ui_base_url}/projects/{project_id}/traces?traceId={trace_id}``
    (matches the frontend route, which selects the trace via the ``traceId``
    query param).

    ``ui_base_url`` is the absolute UI base (scheme + host, optionally with a
    path prefix; no query or fragment) — typically ``settings.traceroot_ui_url``.
    Passing it in keeps this helper pure and free of any credential material.
    ``project_id`` is encoded as a single path segment and ``trace_id`` as a
    query value, so reserved characters in them can't break the resulting URL.
    """
    base = ui_base_url.rstrip("/")
    project_segment = quote(project_id, safe="")
    query = urlencode({"traceId": trace_id})
    return f"{base}/projects/{project_segment}/traces?{query}"
