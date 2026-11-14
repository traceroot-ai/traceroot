"""Tests for the command line: main() with the network and Slack replaced, and the
script run as a plain file."""

import json
import signal
import subprocess
import sys
import threading
from http.client import IncompleteRead
from pathlib import Path
from urllib.error import HTTPError, URLError

import pytest

from scripts.model_prices import catalogs, cli, tracking
from scripts.model_prices.slack import post_to_slack
from tests.model_prices.samples import (
    LITELLM_FILLER,
    _block_text,
    ll_entry,
    md_catalog,
    row,
    runner,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "check_model_prices.py"


@pytest.fixture
def run(tmp_path, monkeypatch):
    """Run main() against sample data, as runner describes."""
    return runner(tmp_path, monkeypatch)


def test_quiet_day_posts_a_heartbeat(run, tmp_path):
    rows = [row("gpt-a", "openai")]
    saved = tmp_path / "payload.json"
    code, posted, report = run(
        rows,
        {"gpt-a": ll_entry("openai")},
        md_catalog(),
        "--min-compared",
        "1",
        "--payload",
        str(saved),
        "--html",
        str(tmp_path / "report.html"),
        "--report-url",
        "https://pages.test/r",
    )

    assert code == 0
    assert report["status"] == "ok"
    [payload] = posted
    assert payload["text"] == f"Model pricing audit, {report['date']}: prices match the catalogs"
    assert payload["blocks"][1]["text"]["text"] == (
        ":large_green_circle: *Prices match the catalogs*"
    )
    assert "<https://pages.test/r|Full report>" in payload["blocks"][-1]["elements"][0]["text"]
    assert json.loads(saved.read_text()) == payload
    assert "Checked 1 of 1 rows" in (tmp_path / "report.html").read_text()


def test_a_cut_list_names_where_the_rest_is_only_when_this_run_wrote_it(run, capsys):
    rows = [row(f"gpt-{n}", "openai", input_=5e-7) for n in range(30)]
    litellm = {f"gpt-{n}": ll_entry("openai") for n in range(30)}

    def cut_lines(*extra, **kwargs):
        """The terminal's and the Slack message's line on the rates left out of the table."""
        _, posted, _ = run(rows, litellm, md_catalog(), "--min-compared", "1", *extra, **kwargs)
        out = capsys.readouterr().out.splitlines()
        blocks = posted[-1]["blocks"]
        more = next(b for b in blocks if b.get("block_id") == "prices_more")
        return next(line for line in out if line.startswith("…and")), _block_text(more)

    # The terminal lists 20 rates, and Slack's table 15 models.
    assert cut_lines("--report-url", "https://pages.test/r") == (
        "…and 10 more in the full report",
        "…and 15 more models in the full report",
    )
    assert cut_lines() == (
        "…and 10 more in the JSON report",
        "…and 15 more models in the JSON report",
    )
    assert cut_lines(write_json=False) == ("…and 10 more", "…and 15 more models")


def test_unreadable_github_still_reports_and_says_prs_were_not_checked(run):
    def offline(url):
        raise URLError("offline")

    rows = [row("gpt-a", "openai", input_=5e-7)]
    code, posted, report = run(
        rows,
        {"gpt-a": ll_entry("openai")},
        md_catalog(),
        "--min-compared",
        "1",
        "--track",
        github=offline,
    )

    assert code == 0
    assert report["tracking"] == "GitHub could not be read (URLError)"
    assert "flagged" in report and report["flagged"][0]["model"] == "gpt-a"
    footer = posted[0]["blocks"][-1]["elements"][0]["text"]
    assert footer.endswith("open PRs not checked: GitHub could not be read (URLError)")


def test_a_cut_off_pr_listing_still_reports(run):
    # A response cut off partway raises an error that is not an OSError.
    def cut_off(url):
        raise IncompleteRead(b"[{")

    rows = [row("gpt-a", "openai", input_=5e-7)]
    code, posted, report = run(
        rows,
        {"gpt-a": ll_entry("openai")},
        md_catalog(),
        "--min-compared",
        "1",
        "--track",
        github=cut_off,
    )

    assert code == 0
    assert report["tracking"] == "GitHub could not be read (IncompleteRead)"
    assert "tracked_by" not in report["flagged"][0]
    assert posted[0]["text"].endswith(": 1 model with prices to check")


def test_more_open_prs_than_the_listing_reads_leaves_prs_not_checked(run, monkeypatch):
    # The PRs past the last page read could fix a finding, so none is marked.
    monkeypatch.setattr(tracking, "MAX_PR_PAGES", 2)
    page = [{"number": n, "title": "docs: typo", "head": {"sha": "h"}} for n in range(100)]
    rows = [row("gpt-a", "openai", input_=5e-7)]
    code, _, report = run(
        rows,
        {"gpt-a": ll_entry("openai")},
        md_catalog(),
        "--min-compared",
        "1",
        "--track",
        github=lambda url: page,
    )

    assert code == 0
    assert report["tracking"] == "GitHub could not be read (200 or more open PRs)"
    assert "tracked_by" not in report["flagged"][0]


TRACK = ("--min-compared", "1", "--track")
UNCOMPILABLE = "gpt-x: matchPattern does not compile, so the row matches its exact name only"


def _run_with_two_prs(run, second_head):
    """main() with --track on one row, gpt-a, whose input rate is flagged: open PR #1
    fixes it, and PR #2's head has second_head as its price file, or raises it when read."""
    rows = [row("gpt-a", "openai", input_=5e-7)]
    heads = {1: [row("gpt-a", "openai")], 2: second_head}
    return run(rows, {"gpt-a": ll_entry("openai")}, md_catalog(), *TRACK, heads=heads)


@pytest.mark.parametrize(
    ("bad_row", "adds", "error"),
    [
        pytest.param(
            row("gpt-x", "openai", pattern="^gpt-x{4294967296}$"),
            [UNCOMPILABLE],
            "",
            id="repeat-count-too-large",
        ),
        pytest.param(
            row("gpt-x", "openai", pattern="(" * 3000 + "gpt-x" + ")" * 3000),
            [UNCOMPILABLE],
            "",
            id="groups-nested-too-deep",
        ),
        pytest.param(
            row("gpt-x", "openai", input_=10**400),
            [],
            "could not check its price file (",
            id="rate-too-large-for-a-float",
        ),
    ],
)
def test_one_open_prs_bad_row_cannot_fail_the_run(run, bad_row, adds, error):
    code, _, report = _run_with_two_prs(run, [row("gpt-a", "openai", input_=5e-7), bad_row])

    assert code == 0
    assert report["tracking"] == "ok"
    assert report["flagged"][0]["tracked_by"] == [1]
    [_, pr] = report["pull_requests"]
    assert pr["adds"] == adds
    assert pr.get("error", "").startswith(error)


def test_a_failure_checking_one_pr_is_reported_on_that_pr_alone(run, monkeypatch):
    # Whatever goes wrong while checking a PR's rows, the other PRs still count.
    build_report = cli.build_report

    def failing(rows, *args, **kwargs):
        if any(r["modelName"] == "gpt-x" for r in rows):
            raise ValueError("unexpected")
        return build_report(rows, *args, **kwargs)

    monkeypatch.setattr(cli, "build_report", failing)
    second = [row("gpt-a", "openai", input_=5e-7), row("gpt-x", "openai")]
    code, _, report = _run_with_two_prs(run, second)

    assert code == 0
    assert report["tracking"] == "ok"
    assert report["flagged"][0]["tracked_by"] == [1]
    assert report["pull_requests"][1]["error"] == "could not check its price file (ValueError)"


@pytest.mark.parametrize("where", ["no-setitimer", "worker-thread"])
def test_an_open_pr_is_not_checked_where_its_time_limit_cannot_be_set(run, monkeypatch, where):
    # Without SIGALRM a backtracking pattern could run forever, so the PR is not run.
    rows = [row("gpt-a", "openai", input_=5e-7)]
    heads = {1: [row("gpt-a", "openai")]}
    if where == "no-setitimer":
        monkeypatch.delattr(signal, "setitimer")
        code, _, report = run(
            rows, {"gpt-a": ll_entry("openai")}, md_catalog(), *TRACK, heads=heads
        )
    else:
        results = []
        worker = threading.Thread(
            target=lambda: results.append(
                run(rows, {"gpt-a": ll_entry("openai")}, md_catalog(), *TRACK, heads=heads)
            )
        )
        worker.start()
        worker.join()
        [(code, _, report)] = results

    assert code == 0
    assert report["flagged"][0]["tracked_by"] == []
    assert report["pull_requests"][0]["error"] == (
        "its price file was not checked: no time limit can be set here"
    )


def test_an_open_prs_price_file_gets_a_time_limit(run, monkeypatch):
    # A pattern that backtracks on a long catalog ID would otherwise stall the run.
    monkeypatch.setattr(tracking, "PR_CHECK_SECONDS", 0.2, raising=False)
    handler = signal.getsignal(signal.SIGALRM)
    rows = [row("gpt-a", "openai", input_=5e-7)]
    litellm = {"gpt-a": ll_entry("openai"), "a" * 26 + "b": ll_entry("openai")}
    heads = {1: [row("gpt-a", "openai")], 2: [*rows, row("gpt-x", "openai", pattern="^(a+)+$")]}
    code, _, report = run(rows, litellm, md_catalog(), *TRACK, heads=heads)

    assert code == 0
    assert report["flagged"][0]["tracked_by"] == [1]
    assert report["pull_requests"][1]["error"] == "its price file took over 0.2 seconds to check"
    assert signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0)
    assert signal.getsignal(signal.SIGALRM) is handler


def test_a_rate_limit_partway_through_the_prs_marks_no_finding_as_in_a_pr(run):
    # Findings are marked only once every PR is checked, so none is hidden from the
    # message while the footer says open PRs were not checked.
    limited = HTTPError("https://api.test", 429, "", {}, None)
    code, posted, report = _run_with_two_prs(run, limited)

    assert code == 0
    assert report["tracking"] == "GitHub could not be read (429)"
    assert not report["flagged"][0].get("tracked_by")
    assert posted[0]["text"].endswith(": 1 model with prices to check")


def test_format_change_exits_nonzero_and_posts_a_failure(run):
    rows = [row("gpt-a", "openai")]
    renamed = {"gpt-a": {**ll_entry("openai"), "input_cost_per_token": None}}
    code, posted, report = run(
        rows, renamed, md_catalog(), "--min-compared", "1", "--report-url", "https://pages.test/r"
    )

    assert code == 1
    assert report["status"] == "failed"
    [payload] = posted
    assert payload["text"].startswith(f"Model pricing audit FAILED, {report['date']}: ")
    assert "input_cost_per_token" in payload["text"]
    assert payload["blocks"][0]["text"]["text"] == f"Model pricing audit failed · {report['date']}"
    assert "not an all-clear" in payload["blocks"][1]["text"]["text"]
    assert _block_text(payload["blocks"][2]) == (
        "The <https://pages.test/r|full report> still shows the last completed run."
    )


def test_too_few_rows_compared_exits_nonzero(run):
    rows = [row("gpt-a", "openai")]
    code, posted, _ = run(rows, {"gpt-a": ll_entry("openai")}, md_catalog())

    assert code == 1
    assert "below the floor of 80" in posted[0]["text"]


def test_unreachable_catalog_exits_nonzero(run):
    code, posted, _ = run([row("gpt-a", "openai")], URLError("offline"), md_catalog())

    assert code == 1
    assert "could not load the LiteLLM catalog" in posted[0]["text"]


def test_post_without_webhook_fails_before_fetching(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("SLACK_WEBHOOK_URL", raising=False)
    monkeypatch.setattr(catalogs, "fetch_json", lambda url: pytest.fail("fetched"))

    assert cli.main(["--post", "--prices", str(tmp_path / "unused.json")]) == 1
    assert "SLACK_WEBHOOK_URL" in capsys.readouterr().err


def test_a_malformed_webhook_url_fails_without_printing_it(run, monkeypatch, capsys):
    # The real post: a URL with no scheme raises ValueError before any request is sent.
    monkeypatch.setattr(cli, "post_to_slack", post_to_slack)
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "hooks.example.test/T/B/secret")
    code, _, report = run(
        [row("gpt-a", "openai")], {"gpt-a": ll_entry("openai")}, md_catalog(), "--min-compared", "1"
    )

    assert code == 1
    assert report["status"] == "ok"
    output = capsys.readouterr()
    assert "Slack post failed (ValueError)" in output.err
    assert "secret" not in output.out + output.err


def test_runs_as_a_plain_script():
    """Standard library only: runs with no venv packages and no PYTHONPATH."""
    result = subprocess.run(
        [sys.executable, "-S", str(SCRIPT), "--help"],
        cwd=REPO_ROOT,
        env={"PATH": "/usr/bin:/bin"},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "--post" in result.stdout


def test_files_are_read_and_written_as_utf8_whatever_the_locale(tmp_path):
    # An ASCII locale with Python's UTF-8 mode off, so only an explicit encoding works.
    rows = [row("gpt-a", "openai"), row("gpt-ü", "openai", pattern="(?i)^gpt-u$")]
    sources = {
        "prices": rows,
        "litellm": {**LITELLM_FILLER, "gpt-a": ll_entry("openai"), "gpt-ö": ll_entry("openai")},
        "modelsdev": md_catalog(),
    }
    argv = ["--min-compared", "1"]
    for name, data in sources.items():
        path = tmp_path / f"{name}.json"
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        argv += [f"--{name}", str(path)]
    for name in ("json", "html", "payload"):
        argv += [f"--{name}", str(tmp_path / f"out.{name}")]
    result = subprocess.run(
        [sys.executable, "-S", "-X", "utf8=0", str(SCRIPT), *argv],
        cwd=REPO_ROOT,
        env={"PATH": "/usr/bin:/bin", "LC_ALL": "C", "PYTHONIOENCODING": "utf-8"},
        capture_output=True,
        encoding="utf-8",
    )

    assert result.returncode == 0, result.stdout + result.stderr
    report = json.loads((tmp_path / "out.json").read_text(encoding="utf-8"))
    assert [p["row"] for p in report["row_problems"]] == ["gpt-ü"]
    assert [m["model"] for m in report["missing"]] == ["gpt-ö"]
    for name in ("html", "payload"):
        assert "gpt-ü" in (tmp_path / f"out.{name}").read_text(encoding="utf-8")

    # A baseline report saved with its non-ASCII names as they are reads the same way.
    baseline = tmp_path / "baseline.json"
    baseline.write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
    again = subprocess.run(
        [sys.executable, "-S", "-X", "utf8=0", str(SCRIPT), *argv, "--baseline", str(baseline)],
        cwd=REPO_ROOT,
        env={"PATH": "/usr/bin:/bin", "LC_ALL": "C", "PYTHONIOENCODING": "utf-8"},
        capture_output=True,
        encoding="utf-8",
    )
    assert again.returncode == 0, again.stdout + again.stderr
