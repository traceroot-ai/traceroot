"""Tests for the TraceRoot UI URL helper (rest.url_utils)."""

import inspect

from rest.url_utils import build_trace_url


def test_builds_trace_detail_url():
    """Basic shape: {ui_base_url}/projects/{project_id}/traces?traceId={trace_id}."""
    url = build_trace_url("https://app.traceroot.ai", "proj1", "abc123")
    assert url == "https://app.traceroot.ai/projects/proj1/traces?traceId=abc123"


def test_strips_trailing_slash_on_base_url():
    """A trailing slash on ui_base_url must not produce a double slash."""
    with_slash = build_trace_url("https://app.traceroot.ai/", "proj1", "abc123")
    without_slash = build_trace_url("https://app.traceroot.ai", "proj1", "abc123")
    assert with_slash == without_slash
    assert "//projects" not in with_slash.split("://", 1)[1]


def test_url_encodes_project_id_path_segment():
    """project_id is a single path segment; reserved chars must be percent-encoded."""
    url = build_trace_url("https://app.traceroot.ai", "team/proj", "abc123")
    assert "/projects/team%2Fproj/traces" in url
    assert "/projects/team/proj/traces" not in url


def test_url_encodes_trace_id_query_value():
    """trace_id is a query value; reserved chars must be encoded so the URL is well-formed."""
    url = build_trace_url("https://app.traceroot.ai", "proj1", "a b&c=d")
    assert url == "https://app.traceroot.ai/projects/proj1/traces?traceId=a+b%26c%3Dd"


def test_takes_only_base_project_trace_and_carries_no_credentials():
    """The helper must not involve any API key/token: only the three inputs, no leakage."""
    params = list(inspect.signature(build_trace_url).parameters)
    assert params == ["ui_base_url", "project_id", "trace_id"]

    url = build_trace_url("https://app.traceroot.ai", "proj1", "abc123")
    lowered = url.lower()
    for forbidden in ("bearer", "api_key", "apikey", "token", "authorization", "secret"):
        assert forbidden not in lowered
