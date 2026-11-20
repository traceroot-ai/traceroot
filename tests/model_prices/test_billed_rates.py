"""Tests that rows are compared at the rates production bills, so two rows billed the
same are never reported as priced differently."""

import pytest

from tests.model_prices.samples import ll_entry, md_catalog, report_for, row

BEDROCK_ID = "us.anthropic.claude-k-5"


def _report(own_prices, other_prices):
    """A report where claude-k-5's Bedrock ID is matched by its own row and by claude-j,
    which the worker tries first. Both rows have a cacheWrite rate, then the prices given."""
    own = row("claude-k-5", "anthropic", pattern=r"(?i)^((us\.)?anthropic\.)?claude-k-5$")
    other = row("claude-j", "anthropic", pattern=r"(?i)^(claude-j|us\.anthropic\.claude-k-5)$")
    for found, prices in ((own, own_prices), (other, other_prices)):
        found["prices"].update(cacheWrite=1e-6, **prices)
    litellm = {"claude-k-5": ll_entry("anthropic"), BEDROCK_ID: ll_entry("bedrock_converse")}
    return report_for([own, other], litellm, md_catalog())


@pytest.mark.parametrize(
    ("own", "other", "billed_the_same"),
    [
        pytest.param({"cacheRead": 0.0}, {"cacheRead": None}, True, id="null-rate-bills-0"),
        pytest.param({"cacheWrite1h": 1e-6}, {}, True, id="no-1h-rate-bills-cache-write"),
        pytest.param({"cacheRead": 1e-7}, {"cacheRead": None}, False, id="cache-read-differs"),
        pytest.param({"cacheWrite1h": 2e-6}, {}, False, id="1h-rate-differs"),
    ],
)
def test_rows_are_compared_at_the_rates_production_bills(own, other, billed_the_same):
    # A null or missing rate bills as 0, and a 1-hour cache write with no rate of its
    # own at the cacheWrite rate.
    report = _report(own, other)

    expected = [] if billed_the_same else [BEDROCK_ID]
    assert [item["model"] for item in report["unpriced_ids"]] == expected
    assert [item["model"] for item in report["overlaps"]] == expected
