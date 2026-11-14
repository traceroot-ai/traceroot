"""Tests for --track: merging an open PR into the current price file, reading open PRs,
and naming the PRs that clear each finding."""

import io
from urllib.error import HTTPError, URLError

import pytest

from scripts.model_prices import catalogs, tracking
from scripts.model_prices.catalogs import (
    PRICE_PATH,
    USER_AGENT,
    index_litellm,
    index_modelsdev,
)
from scripts.model_prices.checks import build_report
from scripts.model_prices.tracking import (
    GITHUB_API,
    MAX_PRICE_FILE_BYTES,
    apply_pr,
    fetch_pricing_prs,
)
from tests.model_prices.samples import (
    DATE,
    LITELLM_FILLER,
    _track_one_pr,
    _tracked_report,
    ll_entry,
    md_catalog,
    row,
)


def test_a_pr_is_merged_by_its_own_row_changes():
    base = [row("gpt-a", "openai"), row("gpt-b", "openai"), row("gpt-c", "openai")]
    # Since the PR branched, the current file changed gpt-a and gained gpt-new.
    current = [row("gpt-a", "openai", input_=5e-6), *base[1:], row("gpt-new", "openai")]
    head = [base[0], row("gpt-b", "openai", input_=7e-6), row("gpt-d", "openai")]

    merged = apply_pr(current, base, head)

    assert [(r["modelName"], r["prices"]["input"]) for r in merged] == [
        ("gpt-a", 5e-6),  # left as the current file has it
        ("gpt-b", 7e-6),  # the PR's change
        ("gpt-new", 1e-6),
        ("gpt-d", 1e-6),  # the PR's new row; gpt-c, which it removed, is gone
    ]


def test_a_row_the_current_file_removed_stays_removed_though_the_pr_changed_it():
    base = [row("gpt-a", "openai"), row("gpt-b", "openai")]
    # Since the PR branched, the current file removed gpt-b, which the PR changed.
    current = [row("gpt-a", "openai")]
    head = [base[0], row("gpt-b", "openai", input_=7e-6), row("gpt-c", "openai")]

    merged = apply_pr(current, base, head)

    assert [r["modelName"] for r in merged] == ["gpt-a", "gpt-c"]


def test_a_pr_changes_only_the_fields_it_changed_in_a_row():
    # The PR branched when both rates were wrong. The current file has since fixed the
    # cache read rate, and the PR fixes the input rate and drops the 1-hour cache write.
    base = [row("deepseek-d", "deepseek", input_=5e-7, cache_read=1e-8)]
    base[0]["prices"]["cacheWrite1h"] = 2e-6
    current = [row("deepseek-d", "deepseek", input_=5e-7, cache_read=1e-7)]
    current[0]["prices"]["cacheWrite1h"] = 2e-6
    head = [row("deepseek-d", "deepseek", input_=1e-6, cache_read=1e-8)]

    merged = apply_pr(current, base, head)

    assert merged[0]["prices"] == {
        "input": 1e-6,
        "output": 2e-6,
        "cacheRead": 1e-7,
        "cacheWrite": None,
    }
    litellm = {"deepseek/deepseek-d": ll_entry("deepseek", input_=1e-6, cache_read=1e-7)}
    [pr] = _track_one_pr(current, litellm, merged)["pull_requests"]
    assert (pr["fixes"], pr["adds"]) == (["deepseek-d input rate"], [])


def test_track_names_the_prs_that_clear_each_finding_and_what_they_add():
    report = _tracked_report()

    assert [(f["field"], f["tracked_by"]) for f in report["flagged"]] == [
        ("input", [11, 12]),
        ("output", []),
    ]
    assert report["missing"][0]["tracked_by"] == [12]
    assert [
        (pr["number"], pr["fixes"], pr["adds"], pr.get("error")) for pr in report["pull_requests"]
    ] == [
        (11, ["deepseek-d input rate"], [], None),
        (12, ["deepseek-d input rate", "gpt-new not priced"], ["gpt-new input rate"], None),
        (13, [], [], "could not read it"),
    ]


def test_fetch_pricing_prs_reads_each_pricing_prs_price_file(monkeypatch):
    rows = [row("gpt-a", "openai")]
    report = build_report(
        rows,
        index_litellm({**LITELLM_FILLER, "gpt-a": ll_entry("openai", input_=2e-6)}),
        index_modelsdev(md_catalog()),
        date=DATE,
        min_compared=0,
    )

    def pull(number, title, body="", files=(PRICE_PATH,)):
        return {
            "number": number,
            "title": title,
            "body": body,
            "html_url": f"https://github.test/pull/{number}",
            "base": {"sha": f"base{number}"},
            "head": {"sha": f"head{number}"},
            "files": list(files),
        }

    pulls = [
        pull(1, "fix(pricing): gpt-a input rate"),
        pull(2, "docs: typo"),
        pull(3, "chore: bump gpt-a in examples", files=("README.md",)),
        pull(4, "fix(pricing): broken branch"),
        pull(5, "fix(pricing): gpt-a odd row"),
    ]
    calls = []

    def fake_github(url):
        calls.append(url)
        if "/pulls?" in url:
            return pulls
        number = int(url.rsplit("head", 1)[1])
        files = next(p["files"] for p in pulls if p["number"] == number)
        return {
            "merge_base_commit": {"sha": f"mb{number}"},
            "files": [{"filename": name} for name in files],
        }

    def fake_fetch(url, max_bytes=None, headers=None):
        if url.startswith(GITHUB_API):
            return fake_github(url)
        assert max_bytes == MAX_PRICE_FILE_BYTES
        if "head4" in url:
            raise URLError("gone")
        if "head5" in url:
            return [{**row("gpt-a", "openai"), "modelName": 5}]
        return [row("gpt-a", "openai", input_=2e-6)] if "head" in url else rows

    monkeypatch.setattr(tracking, "fetch_json", fake_fetch)
    prs = fetch_pricing_prs("owner/repo", rows, report, None, lambda r: {"rows": r})

    # PR 2 neither mentions pricing nor a flagged model; PR 3 doesn't touch the file.
    assert [pr["number"] for pr in prs] == [1, 4, 5]
    assert prs[0]["report"]["rows"][0]["prices"]["input"] == 2e-6
    assert prs[1]["error"] == "could not check its price file (URLError)"
    # A row this run can't evaluate gives the PR an error instead of failing the run.
    assert prs[2]["error"] == "could not check its price file (CheckError)"
    assert not any("pull/2" in url or "head2" in url for url in calls)


NO_FINDINGS = {
    key: []
    for key in ("flagged", "unpriced_ids", "overlaps", "row_problems", "missing", "long_context")
}


def test_github_rate_limit_stops_tracking(monkeypatch):
    def limited(url, max_bytes=None, headers=None):
        if "/pulls?" in url:
            return [
                {"number": 1, "title": "fix(pricing)", "base": {"sha": "b"}, "head": {"sha": "h"}}
            ]
        raise HTTPError(url, 403, "rate limited", {}, None)

    monkeypatch.setattr(tracking, "fetch_json", limited)
    with pytest.raises(HTTPError):
        fetch_pricing_prs("owner/repo", [], NO_FINDINGS, None, lambda rows: {})


@pytest.mark.parametrize("token", ["t0ken", None])
def test_open_prs_are_read_with_the_token_and_the_apis_json_type(monkeypatch, token):
    sent = []

    def fake_urlopen(request, timeout):
        sent.append(request)
        return io.BytesIO(b"[]")

    monkeypatch.setattr(catalogs, "urlopen", fake_urlopen)
    fetch_pricing_prs("owner/repo", [], NO_FINDINGS, token, lambda rows: {})

    [request] = sent
    assert request.full_url == f"{GITHUB_API}/repos/owner/repo/pulls?state=open&per_page=100&page=1"
    assert request.get_header("Accept") == "application/vnd.github+json"
    assert request.get_header("Authorization") == (f"Bearer {token}" if token else None)
    assert request.get_header("User-agent") == USER_AGENT
