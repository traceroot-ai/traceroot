"""--track: read the open pull requests that change the price file from GitHub, merge
each into the current file, and name the PRs that clear each finding."""

import contextlib
import json
import re
import signal
import threading
from collections.abc import Callable, Iterator
from typing import Any
from urllib.request import Request, urlopen

from .catalogs import TIMEOUT_SECONDS, USER_AGENT, fetch_json, validate_rows
from .findings import changes, describe_all, finding_keys

# --track: open pull requests that change the price file.
GITHUB_REPO = "traceroot-ai/traceroot"
GITHUB_API = "https://api.github.com"
GITHUB_RAW = "https://raw.githubusercontent.com"
PRICE_PATH = "frontend/packages/core/src/standard-model-prices.json"
MAX_PR_PAGES = 10

# A PR's price file is read up to this size, about 25 times ours, so one huge file
# can't stall the run.
MAX_PRICE_FILE_BYTES = 1_000_000

# A PR's patterns can backtrack for hours on a long catalog ID. A whole report is checked
# in well under a second, so this limit only stops such a pattern.
PR_CHECK_SECONDS = 10

# A PR is checked when its title or body mentions pricing or a model in the report.
PRICING_WORDS = re.compile(r"pric", re.IGNORECASE)


def _apply_changes(current: dict, base: dict, head: dict) -> dict:
    """current with what changed from base to head: a key head sets to another value
    takes head's value, a key head drops is removed, and prices change field by field."""
    merged = dict(current)
    for key in dict.fromkeys([*base, *head]):
        if key not in head:
            merged.pop(key, None)
        elif key == "prices" and all(isinstance(r.get(key), dict) for r in (current, base, head)):
            merged[key] = _apply_changes(current[key], base[key], head[key])
        elif key not in base or base[key] != head[key]:
            merged[key] = head[key]
    return merged


def apply_pr(rows: list[dict], base: list[dict], head: list[dict]) -> list[dict]:
    """The price file with a PR merged, as git merges changes that don't overlap: of each
    row the PR changes between its merge base and its head, only the keys and prices
    fields it changes are applied to the current row, so a branch that is behind leaves
    later changes to the current file alone. Rows the PR adds are added whole, and rows
    it removes are removed."""
    before = {row["id"]: row for row in base}
    after = {row["id"]: row for row in head}
    changed = {row_id: row for row_id, row in after.items() if before.get(row_id) != row}
    removed = before.keys() - after.keys()
    merged = []
    for row in rows:
        if row["id"] in removed:
            continue
        new = changed.pop(row["id"], None)
        if new is None:
            merged.append(row)
        elif row["id"] in before:
            merged.append(_apply_changes(row, before[row["id"]], new))
        else:  # Added by the PR and, since it branched, by the current file too.
            merged.append(new)
    return merged + list(changed.values())


def track(report: dict, prs: list[dict]) -> None:
    """Name, on each finding, the open PRs that would clear it, and list what each PR
    would fix and add. prs holds, for each PR, the report on the price file it would
    leave on merge in "report", or why it could not be checked in "error". Findings are
    marked only once every PR is compared, so a failure partway marks none."""
    before = finding_keys(report)
    fixed_by: dict[tuple, list[int]] = {key: [] for key in before}
    checked = []
    for pr in prs:
        summary = {key: pr.get(key) for key in ("number", "title", "url")}
        if pr.get("error"):
            checked.append({**summary, "fixes": [], "adds": [], "error": pr["error"]})
            continue
        fixes, adds = changes(report, pr["report"])
        for key in fixes:
            fixed_by[key].append(pr["number"])
        checked.append({**summary, "fixes": describe_all(fixes), "adds": adds})
    for key, item in before.items():
        item["tracked_by"] = fixed_by[key]
    report["pull_requests"] = checked
    report["tracking"] = "ok"


def _github(url: str, token: str | None) -> Any:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with urlopen(Request(url, headers=headers), timeout=TIMEOUT_SECONDS) as response:
        return json.load(response)


class _TimeLimitError(Exception):
    """Checking one open PR's price file ran over PR_CHECK_SECONDS."""


class _NoTimeLimitError(Exception):
    """No time limit can be set here, so an open PR's patterns are not run."""


@contextlib.contextmanager
def _time_limit(seconds: float) -> Iterator[None]:
    """Raise _TimeLimitError when the block runs over seconds. Python's regex engine checks
    for signals, so SIGALRM stops a pattern that backtracks. Without setitimer, as on
    Windows, or off the main thread, it raises _NoTimeLimitError instead of running the
    block with no limit."""
    if (
        not hasattr(signal, "setitimer")
        or threading.current_thread() is not threading.main_thread()
    ):
        raise _NoTimeLimitError

    def expire(_signum: int, _frame: object) -> None:
        raise _TimeLimitError

    previous = signal.signal(signal.SIGALRM, expire)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        try:
            signal.setitimer(signal.ITIMER_REAL, 0)
        finally:
            signal.signal(signal.SIGALRM, previous)


def _mentions(pull: dict, models: list[re.Pattern[str]]) -> bool:
    text = f"{pull.get('title') or ''}\n{pull.get('body') or ''}"
    return bool(PRICING_WORDS.search(text)) or any(model.search(text) for model in models)


def fetch_pricing_prs(
    repo: str,
    rows: list[dict],
    report: dict,
    token: str | None,
    evaluate: Callable[[list[dict]], dict],
) -> list[dict]:
    """The open PRs in repo that change the price file, each with the report evaluate
    builds from the price file it would leave on merge. A PR is looked at when its title
    or body mentions pricing or a model in the report. Anything that goes wrong with one
    PR, from reading its files to checking its rows, gives that PR an "error" instead, so
    only GitHub's rate limit stops the others."""
    pulls: list[dict] = []
    for page in range(1, MAX_PR_PAGES + 1):
        batch = _github(
            f"{GITHUB_API}/repos/{repo}/pulls?state=open&per_page=100&page={page}", token
        )
        pulls += batch
        if len(batch) < 100:
            break
    names = {
        value
        for item in finding_keys(report).values()
        for value in (item.get("model"), item.get("row"))
        if value
    }
    models = [re.compile(rf"(?<![\w.-]){re.escape(name)}(?![\w-])") for name in sorted(names)]
    prs = []
    for pull in sorted(pulls, key=lambda pull: pull["number"]):
        if not _mentions(pull, models):
            continue
        number, head = pull["number"], pull["head"]["sha"]
        pr = {"number": number, "title": pull.get("title"), "url": pull.get("html_url")}
        try:
            compare = _github(
                f"{GITHUB_API}/repos/{repo}/compare/{pull['base']['sha']}...{head}", token
            )
            if PRICE_PATH not in {changed["filename"] for changed in compare.get("files", [])}:
                continue
            base_sha = compare["merge_base_commit"]["sha"]
            base, after = (
                fetch_json(f"{GITHUB_RAW}/{repo}/{sha}/{PRICE_PATH}", MAX_PRICE_FILE_BYTES)
                for sha in (base_sha, head)
            )
            with _time_limit(PR_CHECK_SECONDS):
                pr["report"] = evaluate(validate_rows(apply_pr(rows, base, after)))
        except _TimeLimitError:
            pr["error"] = f"its price file took over {PR_CHECK_SECONDS} seconds to check"
        except _NoTimeLimitError:
            pr["error"] = "its price file was not checked: no time limit can be set here"
        except Exception as exc:  # Any error with an open PR stays with that PR.
            if getattr(exc, "code", None) in (403, 429):
                raise  # GitHub's rate limit: every later PR would fail the same way.
            pr["error"] = f"could not check its price file ({type(exc).__name__})"
        prs.append(pr)
    return prs
