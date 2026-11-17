"""Check the standard model price file against two public price catalogs.

Compares each row of frontend/packages/core/src/standard-model-prices.json with
LiteLLM's model_prices_and_context_window.json and models.dev's api.json, and reports:

- flagged prices: an input, output, cache read or cache write rate that differs from
  ours by more than 3% in every catalog that lists the model under the same ID, or that
  our row leaves out while every such catalog charges for it. A catalog model that a
  row prices through its matchPattern, such as a newer version an older row's pattern
  also matches, is compared with that row's rates, and so is the dash spelling of a
  dotted version, such as gpt-5-5 for gpt-5.5, which gateways send;
- missing models: text models a catalog prices for one of our providers that no row
  matches (exact model name first, then matchPattern, the order production uses),
  leaving out models either catalog marks as retired;
- model IDs a row should price but does not: the IDs a model has on Bedrock, Vertex AI
  and OpenRouter, and the [1m] ID of a model with a 1M-token context window. One that
  matches no row records no cost; one that another row matches gets that row's price;
- overlapping patterns: an ID that two rows' patterns match at different prices. The
  worker tries patterns in modelName order and the UI in database order, so the two
  can price the same span differently;
- row problems: a pattern that does not compile, uses syntax the UI's JavaScript regex
  rejects or reads differently, or misses its own modelName; a modelName listed twice;
  a rate below zero or above $1,000 per million tokens; a cache read rate above the
  input rate;
- long-context rates: models a catalog charges more for above a prompt size, which the
  price file has no field for;
- rows with no exact-ID match in either catalog, which are not compared.

With --track, each finding also names the open pull requests that would clear it: the
script applies each pricing PR's row changes to the current price file and checks the
result again. It also lists any problem a PR would add.

A rate a maintainer has checked and left as it is goes in --reviewed (default
scripts/model_prices/reviewed.json) and is no longer flagged until our rate or either
catalog's rate changes. To add one, copy model, field, ours, litellm and modelsdev
verbatim from the flag in the --json report, since an entry matches only those exact
values (a models.dev rate can read 4.0000000000000003e-07), then add a reason and pr,
the number of the PR that settled it or null.

A flag means "check this row", not "this is the price". Confirm the rate on the
provider's pricing page, listed with each flag, before changing the price file.

  python3 scripts/check_model_prices.py                      # print the report
  python3 scripts/check_model_prices.py --json report.json   # also write it as JSON
  python3 scripts/check_model_prices.py --post               # post it to Slack
  python3 scripts/check_model_prices.py --payload msg.json   # write the Slack message
  python3 scripts/check_model_prices.py --track              # name the PRs that fix each
  python3 scripts/check_model_prices.py --html report.html   # write the full report page
  python3 scripts/check_model_prices.py --baseline before.json  # check an edit to the file

--post sends a short Block Kit message to the Slack incoming webhook in
SLACK_WEBHOOK_URL: what needs a fix and has no open PR, then what open PRs already fix.
It posts on every run, even when nothing is flagged, so a missing message means the
check did not run. --payload writes that message as JSON, so it can be previewed or
extended before it is posted. --html writes every finding as a web page, and
--report-url links the message to where that page is published. --litellm and --modelsdev take
a URL or a local file, so a saved catalog snapshot can be replayed. --track reads
GitHub, with GITHUB_TOKEN or GH_TOKEN when set; if GitHub can't be read, the report
says so and the run exits 4.

--baseline checks an edit to the price file before it goes into a pull request. Save a
report with --json before the edit, edit the file, then run again with --baseline
pointing at that report: the output lists the findings the edit fixes and any it adds. A
flagged rate the edit changes to another value the catalogs disagree with is an add, not
a fix. So is a row with a finding that the edit deletes, or stops comparing by changing
its provider to one no catalog covers: that hides the finding. A Bedrock, Vertex AI or
OpenRouter ID that a row newly prices is an add when every catalog that lists that exact
ID charges other input or output rates, as Bedrock does for GovCloud and regional
profiles. So is a dotted version's dash spelling that a row priced before the edit and
none prices after it, such as grok-4-20 once a narrowed grok-4 row stops matching it.
--track lists the same adds for each open PR. --baseline also lists each change to a row
that no finding explains, as no catalog compares about a quarter of the rows and a rate
changed inside the 3% tolerance shows no flag: a row removed or moved to another
provider; a rate changed with no flag on that rate of that row, or of a dated snapshot
or -latest alias it prices, fixed or added (another model its pattern prices needs a
narrower pattern, not a new rate); a matchPattern change that moves no ID to or out of
the row. An ID moves to the row when the new pattern starts matching it and the worker
newly picks the row for it, and out of it when the new pattern stops matching it and the
worker stops picking the row, or when narrowing the row fixes its "matched by two rows"
finding. The IDs that count are those a finding fixed or added is about, dash spellings
and host IDs priced another way, and the names of rows the edit adds. A row problem
fixed or added explains any new value of what it is about: a pattern problem the
pattern, a rate out of range that rate, and a cache read rate above the input rate those
two rates. Each later row of a name listed twice is compared too, as "<name> (2)" and so
on; if another row already has that name, the run fails. A row named after a [1m] or
host ID is checked only through that ID, so its own finding, or a host rate on that
field, fixed or added explains its rates. --track leaves these out, as an open PR is
judged by its findings. Pass the same saved --litellm, --modelsdev and --reviewed files
to both runs, so only the price file differs between them. For the same reason, the
second run judges which models are retired as of the baseline report's date, and reports
that date.

Exit codes: 0 when a report was produced and none of the cases below applies. 1 when a
catalog could not be loaded, a file's format changed, a row is named like a repeated
name's later row ("<name> (2)"), fewer than --min-compared rows could be compared, the
reviewed rates file is malformed, the --baseline report could not be read or was made
from other catalogs or reviewed rates, the Slack post failed, or --post is set with no
SLACK_WEBHOOK_URL (checked before anything is fetched). A failed run posts a failure
alert when it can, never an all-clear. 2 for a usage error only. 3 with --baseline when
it lists any add: a finding the baseline report does not have, a row whose finding the
edit hides, a host ID newly priced at rates its host disagrees with, a dash spelling no
longer priced, or a row change no finding explains, even when --track could not read
GitHub. 4 when the report was produced but --track could not read GitHub, so no finding
names its open PRs; every output is still written and posted.

Standard library only, so it runs on any Python 3.11+ without installing anything.
"""

import argparse
import hashlib
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

from .catalogs import (
    LITELLM_URL,
    MODELSDEV_URL,
    PRICE_PATH,
    CheckError,
    index_hosted,
    index_litellm,
    index_modelsdev,
    load_reviewed,
    load_source,
    validate_rows,
)
from .checks import MIN_COMPARED, build_report
from .findings import baseline_changes, describe_all, load_baseline
from .page import build_html
from .slack import build_payload, failure_payload, post_to_slack
from .text import format_failure, format_report
from .tracking import GITHUB_REPO, fetch_pricing_prs, track

ROOT = Path(__file__).resolve().parents[2]
REVIEWED_PATH = Path(__file__).resolve().parent / "reviewed.json"


def _digest(data: object) -> str:
    """A hash of parsed JSON, so two runs can tell they read the same catalog."""
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--post", action="store_true", help="post the report to the webhook in SLACK_WEBHOOK_URL"
    )
    parser.add_argument("--json", type=Path, metavar="PATH", help="also write the report as JSON")
    parser.add_argument(
        "--payload", type=Path, metavar="PATH", help="also write the Slack message as JSON"
    )
    parser.add_argument("--prices", type=Path, default=ROOT / PRICE_PATH, help="our price file")
    parser.add_argument(
        "--reviewed", type=Path, default=REVIEWED_PATH, help="rates a maintainer has checked"
    )
    parser.add_argument("--litellm", default=LITELLM_URL, metavar="URL_OR_PATH")
    parser.add_argument("--modelsdev", default=MODELSDEV_URL, metavar="URL_OR_PATH")
    parser.add_argument(
        "--min-compared",
        type=int,
        default=MIN_COMPARED,
        help=f"fail when fewer rows than this are compared (default {MIN_COMPARED})",
    )
    parser.add_argument(
        "--html", type=Path, metavar="PATH", help="also write the full report as a web page"
    )
    parser.add_argument(
        "--report-url", metavar="URL", help="link the Slack message to the full report here"
    )
    parser.add_argument(
        "--baseline",
        type=Path,
        metavar="REPORT",
        help="list what this price file fixes and adds compared with a report saved by "
        "--json, with each row change no finding explains as an add; exit 3 if it lists any "
        "add, as even a correct new row adds a finding when a catalog bills its model more "
        "above a prompt size (a long-context add)",
    )
    parser.add_argument(
        "--track",
        nargs="?",
        const=GITHUB_REPO,
        metavar="OWNER/REPO",
        help=f"name the open PRs that would fix each finding (default repo {GITHUB_REPO})",
    )
    args = parser.parse_args(argv)

    webhook = os.environ.get("SLACK_WEBHOOK_URL", "").strip()
    if args.post and not webhook:
        print("--post needs SLACK_WEBHOOK_URL set to a Slack incoming webhook URL", file=sys.stderr)
        return 1

    date = datetime.now(UTC).date().isoformat()
    try:
        baseline = load_baseline(args.baseline) if args.baseline else None
        if baseline is not None:
            # Retire models as of the baseline's date, so one retired since then does
            # not read as a fix: only the price file differs between the two reports.
            date = baseline["date"]
        rows = validate_rows(json.loads(args.prices.read_text(encoding="utf-8")))
        reviewed = load_reviewed(args.reviewed)
        litellm_data = load_source(args.litellm, "LiteLLM")
        modelsdev_data = load_source(args.modelsdev, "models.dev")
        litellm, modelsdev = index_litellm(litellm_data), index_modelsdev(modelsdev_data)
        hosted = index_hosted(litellm_data, modelsdev_data)
        report = build_report(
            rows,
            litellm,
            modelsdev,
            date=date,
            hosted=hosted,
            min_compared=args.min_compared,
            reviewed=reviewed,
        )
        report["catalogs"] = {
            "litellm": _digest(litellm_data),
            "modelsdev": _digest(modelsdev_data),
            "reviewed": _digest(reviewed),
        }
        if baseline is not None:
            if baseline["catalogs"] != report["catalogs"]:
                raise CheckError(
                    "the catalogs or reviewed rates differ from the baseline report's: pass "
                    "the same saved --litellm, --modelsdev and --reviewed files to both runs"
                )
            fixes, adds = baseline_changes(baseline, report)
            report["baseline"] = {"fixes": describe_all(fixes), "adds": adds}
        if args.track:
            token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
            try:
                prs = fetch_pricing_prs(
                    args.track,
                    rows,
                    report,
                    token,
                    lambda pr_rows: build_report(
                        pr_rows,
                        litellm,
                        modelsdev,
                        date=date,
                        hosted=hosted,
                        min_compared=0,
                        reviewed=reviewed,
                    ),
                )
                track(report, prs)
            except Exception as exc:
                # The findings stand without it: say PRs weren't checked, and carry on
                # (the run then exits 4, or 3 for a baseline add, after every output is
                # written).
                if isinstance(exc, CheckError):
                    detail = str(exc)
                else:
                    detail = getattr(exc, "code", None) or type(exc).__name__
                report["tracking"] = f"GitHub could not be read ({detail})"
        # A cut list points to the rest only where this run writes it.
        more_in = "the full report" if args.report_url else "the JSON report" if args.json else None
        resolved = args.reviewed.resolve()
        reviewed_in = str(
            resolved.relative_to(ROOT) if resolved.is_relative_to(ROOT) else args.reviewed
        )
        text = format_report(report, more_in, reviewed_in=reviewed_in)
        payload = build_payload(report, args.report_url, more_in)
        # With --baseline, a finding the edit adds, or a row change no finding explains,
        # fails the check, even when --track could not read GitHub.
        if report.get("baseline", {}).get("adds"):
            status = 3
        elif args.track and report["tracking"] != "ok":
            status = 4
        else:
            status = 0
    except Exception as exc:  # Every failure must alert; none may read as all clear.
        reason = str(exc) if isinstance(exc, CheckError) else f"{type(exc).__name__}: {exc}"
        report = {"date": date, "status": "failed", "error": reason}
        text, status = format_failure(date, reason), 1
        payload = failure_payload(date, reason, args.report_url)

    if args.json:
        args.json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if args.html:
        args.html.write_text(build_html(report), encoding="utf-8")
    if args.payload:
        args.payload.write_text(
            json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
    print(text)
    if args.post:
        try:
            post_to_slack(webhook, payload)
        except Exception as exc:
            # Never echo the webhook URL: report only the error type and status. Any
            # exception counts, as a malformed URL raises one whose message holds it.
            detail = getattr(exc, "code", None) or type(exc).__name__
            print(f"Slack post failed ({detail})", file=sys.stderr)
            return 1
    return status
