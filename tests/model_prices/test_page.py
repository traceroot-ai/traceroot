"""Tests for the full report page."""

from scripts.model_prices.page import build_html
from tests.model_prices.samples import DATE, _tracked_report


def test_the_full_report_page_lists_every_finding():
    report = _tracked_report()
    report["missing"].append({"model": "<b>x</b>", "provider": "openai", "in": ["litellm"]})
    page = build_html(report)

    assert page.startswith("<!doctype html>")
    assert "<h2>Prices to check (2)</h2>" in page
    assert '<a href="https://github.test/pull/11">#11</a>' in page
    assert "<h2>Models not priced (2)</h2>" in page
    assert "<code>&lt;b&gt;x&lt;/b&gt;</code>" in page
    assert "<h2>Open pricing PRs (3)</h2>" in page

    failed = build_html({"date": DATE, "status": "failed", "error": "catalog <down>"})
    assert "catalog &lt;down&gt;" in failed and "not an all-clear" in failed
