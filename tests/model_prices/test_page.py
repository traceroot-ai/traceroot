"""Tests for the full report page."""

from scripts.model_prices.page import build_html
from tests.model_prices.samples import DATE, _reviewed_report, _tracked_report


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


def test_the_page_lists_reviewed_rates_only_when_there_are_some():
    page = build_html(_reviewed_report())

    assert "<h2>Reviewed rates (1)</h2>" in page
    assert "the provider&#x27;s page says &lt;1.00&gt;" in page
    assert "<td>gpt-a</td><td>input</td>" in page and "#12" in page
    assert "Reviewed rates" not in build_html(_tracked_report())
