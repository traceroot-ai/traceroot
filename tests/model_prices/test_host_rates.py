"""Tests for the host IDs a row prices at rates the host disagrees with, such as
Bedrock's GovCloud and regional profiles at the model's own rates: what --baseline and
--track add for them."""

import pytest

from tests.model_prices.samples import compare, ll_entry, md_catalog, md_model, row


def test_a_host_id_newly_priced_below_the_hosts_rates_is_added():
    # GovCloud and regional profiles bill more than the model's own rates. A GovCloud
    # region's route lists the plain Bedrock ID at its price too; the bare key wins.
    litellm = {
        "claude-k-5": ll_entry("anthropic", input_=2e-6, output=1e-5),
        "anthropic.claude-k-5": ll_entry("bedrock_converse", input_=2e-6, output=1e-5),
        "us-gov.anthropic.claude-k-5": ll_entry("bedrock_converse", input_=2.4e-6, output=1.2e-5),
        "bedrock/us-gov-west-1/anthropic.claude-k-5": ll_entry(
            "bedrock", input_=2.4e-6, output=1.2e-5
        ),
    }
    bedrock = {"in.anthropic.claude-k-5": md_model(input_=2.2e-6, output=1.1e-5)}
    modelsdev = md_catalog(**{"amazon-bedrock": bedrock})
    before = [row("claude-k-5", "anthropic", input_=2e-6, output=1e-5)]
    pattern = r"(?i)^(((us-gov|in)\.)?anthropic\.)?claude-k-5$"
    after = [row("claude-k-5", "anthropic", input_=2e-6, output=1e-5, pattern=pattern)]

    assert compare(before, after, litellm, modelsdev)["adds"] == [
        "in.anthropic.claude-k-5 priced at claude-k-5's rates, but the host lists "
        "input 2.20 (ours 2.00) and output 11.00 (ours 10.00)",
        "us-gov.anthropic.claude-k-5 priced at claude-k-5's rates, but the host lists "
        "input 2.40 (ours 2.00) and output 12.00 (ours 10.00)",
    ]


def test_fixing_a_rate_adds_nothing_for_a_host_id_its_row_already_priced():
    # The row already prices its GovCloud ID below the host's rates. Fixing the row's
    # output rate changes ours for that ID too, but the edit does not price it anew.
    litellm = {
        "claude-k-5": ll_entry("anthropic", input_=2e-6, output=1e-5),
        "us-gov.anthropic.claude-k-5": ll_entry("bedrock_converse", input_=2.4e-6, output=1.2e-5),
    }
    pattern = r"(?i)^(us-gov\.anthropic\.)?claude-k-5$"
    before = [row("claude-k-5", "anthropic", input_=2e-6, output=2e-5, pattern=pattern)]
    after = [row("claude-k-5", "anthropic", input_=2e-6, output=1e-5, pattern=pattern)]

    assert compare(before, after, litellm, md_catalog()) == {
        "fixes": ["claude-k-5 output rate (ours 20.00)"],
        "adds": [],
    }


def test_a_host_id_another_row_takes_over_at_the_same_rates_is_not_added():
    # A row split off a broader one prices that row's host IDs at the same rates, so
    # what their spans record does not change.
    litellm = {
        "claude-s-4": ll_entry("anthropic", input_=3e-6, output=1.5e-5),
        "claude-s-4-6": ll_entry("anthropic", input_=3e-6, output=1.5e-5),
        "us.anthropic.claude-s-4-6": ll_entry("bedrock_converse", input_=3.3e-6, output=1.65e-5),
    }
    broad = r"(?i)^((us\.)?anthropic\.)?claude-s-4(-[\d-]+)?$"
    before = [row("claude-s-4", "anthropic", input_=3e-6, output=1.5e-5, pattern=broad)]
    split = r"(?i)^((us\.)?anthropic\.)?claude-s-4-6$"
    after = [
        row("claude-s-4", "anthropic", input_=3e-6, output=1.5e-5),
        row("claude-s-4-6", "anthropic", input_=3e-6, output=1.5e-5, pattern=split),
    ]

    assert compare(before, after, litellm, md_catalog()) == {"fixes": [], "adds": []}


def test_a_new_row_that_prices_host_ids_below_the_hosts_rates_is_added():
    # A row for a model no row priced, whose pattern also takes Bedrock's regional and
    # GovCloud profiles, prices them at the model's own rates.
    litellm = {
        "claude-a": ll_entry("anthropic"),
        "claude-k-6": ll_entry("anthropic", input_=2e-6, output=1e-5),
        "us.anthropic.claude-k-6": ll_entry("bedrock_converse", input_=2.2e-6, output=1.1e-5),
        "us-gov.anthropic.claude-k-6": ll_entry("bedrock_converse", input_=2.4e-6, output=1.2e-5),
    }
    before = [row("claude-a", "anthropic")]
    pattern = r"(?i)^(((us|us-gov)\.)?anthropic\.)?claude-k-6$"
    after = [*before, row("claude-k-6", "anthropic", input_=2e-6, output=1e-5, pattern=pattern)]

    assert compare(before, after, litellm, md_catalog()) == {
        "fixes": ["claude-k-6 not priced"],
        "adds": [
            "us-gov.anthropic.claude-k-6 priced at claude-k-6's rates, but the host lists "
            "input 2.40 (ours 2.00) and output 12.00 (ours 10.00)",
            "us.anthropic.claude-k-6 priced at claude-k-6's rates, but the host lists "
            "input 2.20 (ours 2.00) and output 11.00 (ours 10.00)",
        ],
    }


def test_an_id_moved_off_a_wrong_row_to_its_own_below_the_hosts_rates_is_added():
    litellm = {
        "claude-k-5": ll_entry("anthropic", input_=2e-6, output=1e-5),
        "claude-j": ll_entry("anthropic", input_=9e-6),
        "us-gov.anthropic.claude-k-5": ll_entry("bedrock_converse", input_=2.4e-6, output=1.2e-5),
    }
    wrong = r"(?i)^(claude-j|us-gov\.anthropic\.claude-k-5)$"
    before = [
        row("claude-k-5", "anthropic", input_=2e-6, output=1e-5),
        row("claude-j", "anthropic", input_=9e-6, pattern=wrong),
    ]
    own = r"(?i)^(us-gov\.anthropic\.)?claude-k-5$"
    after = [
        row("claude-k-5", "anthropic", input_=2e-6, output=1e-5, pattern=own),
        row("claude-j", "anthropic", input_=9e-6),
    ]

    assert compare(before, after, litellm, md_catalog()) == {
        "fixes": ["us-gov.anthropic.claude-k-5 priced as claude-j"],
        "adds": [
            "us-gov.anthropic.claude-k-5 priced at claude-k-5's rates, but the host lists "
            "input 2.40 (ours 2.00) and output 12.00 (ours 10.00)"
        ],
    }


def test_a_host_id_newly_priced_at_its_hosts_input_and_output_rates_is_not_added():
    # Only a host's input and output rates are compared with the row that prices its ID.
    litellm = {
        "claude-k-5": ll_entry("anthropic", input_=2e-6, output=1e-5),
        "us.anthropic.claude-k-5": ll_entry(
            "bedrock_converse",
            input_=2e-6,
            output=1e-5,
            cache_read=2e-7,
            cache_creation_input_token_cost=2.5e-6,
        ),
    }
    before = [row("claude-k-5", "anthropic", input_=2e-6, output=1e-5)]
    pattern = r"(?i)^(us\.anthropic\.)?claude-k-5$"
    after = [row("claude-k-5", "anthropic", input_=2e-6, output=1e-5, pattern=pattern)]

    assert compare(before, after, litellm, md_catalog()) == {
        "fixes": ["us.anthropic.claude-k-5 not priced by its row"],
        "adds": [],
    }


@pytest.mark.parametrize(
    ("input_", "output", "adds"),
    [
        (
            2e-6,
            1e-5,
            [
                "us-gov.anthropic.claude-k-6 priced at us-gov.anthropic.claude-k-6's rates, "
                "but the host lists input 2.40 (ours 2.00) and output 12.00 (ours 10.00)"
            ],
        ),
        (2.4e-6, 1.2e-5, []),
    ],
    ids=["model-rates", "host-rates"],
)
def test_a_row_named_after_a_host_id_is_checked_against_the_host(input_, output, adds):
    # No catalog lists the GovCloud ID under its row's provider, so only the host's
    # rates can show that the row prices it wrong.
    litellm = {
        "claude-k-6": ll_entry("anthropic", input_=2e-6, output=1e-5),
        "us-gov.anthropic.claude-k-6": ll_entry("bedrock_converse", input_=2.4e-6, output=1.2e-5),
    }
    before = [row("claude-k-6", "anthropic", input_=2e-6, output=1e-5)]
    gov = row("us-gov.anthropic.claude-k-6", "anthropic", input_=input_, output=output)

    assert compare(before, [*before, gov], litellm, md_catalog()) == {
        "fixes": ["us-gov.anthropic.claude-k-6 not priced by its row"],
        "adds": adds,
    }
