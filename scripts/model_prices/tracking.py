"""--track: read the open pull requests that change the price file, merge each into the
current file, and name the PRs that clear each finding."""

import contextlib
import re
import signal
import threading
from collections.abc import Callable, Iterator

from .catalogs import PRICE_PATH, CheckError, fetch_json, validate_rows
from .findings import changes, describe_all, finding_keys

# --track: open pull requests that change the price file.
GITHUB_REPO = "traceroot-ai/traceroot"
GITHUB_API = "https://api.github.com"
GITHUB_RAW = "https://raw.githubusercontent.com"
MAX_PR_PAGES = 10

# A PR's price file is read up to this size, about 25 times ours, so one huge file
# can't stall the run.
MAX_PRICE_FILE_BYTES = 1_000_000

# A PR's patterns can backtrack for hours on a long catalog ID. A whole report is checked
# in well under a second, so this limit only stops such a pattern.
PR_CHECK_SECONDS = 10

# A PR is checked when its title or body mentions pricing or a model in the report.
PRICING_WORDS = re.compile(r"pric", re.IGNORECASE)

# A key a row lacks, apart from one it sets to null.
_ABSENT = object()


def _apply_changes(current: dict, base: dict, head: dict, model: str, path: str = "") -> dict:
    """current with what changed from base to head, key by key: a key head leaves as
    base has it stays as current has it, and a key head changes or drops takes head's value
    (or is removed) when current still has base's value or already has head's. When
    current and head changed a key to different values, prices merge field by field and
    any other key is a _ConflictError on model, named by its path."""
    merged = dict(current)
    for key in dict.fromkeys([*base, *head]):
        ours, was, theirs = (r.get(key, _ABSENT) for r in (current, base, head))
        if theirs == was:
            continue
        if ours in (was, theirs):
            if theirs is _ABSENT:
                merged.pop(key, None)
            else:
                merged[key] = theirs
        elif key == "prices" and all(isinstance(v, dict) for v in (ours, was, theirs)):
            merged[key] = _apply_changes(ours, was, theirs, model, f"{path}{key}.")
        else:
            raise _ConflictError(model, f"{path}{key}")
    return merged


def apply_pr(rows: list[dict], base: list[dict], head: list[dict]) -> list[dict]:
    """The price file with a PR merged, as git merges changes that don't overlap: of each
    row the PR changes between its merge base and its head, only the keys and prices
    fields it changes are applied to the current row, so a branch that is behind leaves
    later changes to the current file alone. Rows the PR adds are added whole, and rows
    it removes are removed. Changes that overlap raise a _ConflictError: a key or prices
    field the PR and the current file changed to different values, a row the PR removed
    that the current file changed, a row the current file removed that the PR changed,
    or a row both added with different contents."""
    before = {row["id"]: row for row in base}
    after = {row["id"]: row for row in head}
    changed = {row_id: row for row_id, row in after.items() if before.get(row_id) != row}
    removed = before.keys() - after.keys()
    merged = []
    for row in rows:
        row_id = row["id"]
        if row_id in removed:
            if row != before[row_id]:
                raise _ConflictError(row["modelName"])
            continue
        new = changed.pop(row_id, None)
        if new is None:
            merged.append(row)
        elif row_id in before:
            merged.append(_apply_changes(row, before[row_id], new, row["modelName"]))
        elif row != new:  # Added by the PR and, since it branched, by the current file too.
            raise _ConflictError(row["modelName"])
        else:
            merged.append(new)
    for row_id, row in changed.items():
        if row_id in before:  # The current file removed it since the PR branched.
            raise _ConflictError(row["modelName"])
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


class _TimeLimitError(Exception):
    """Checking one open PR's price file ran over PR_CHECK_SECONDS."""


class _ConflictError(Exception):
    """An open PR's price file and the current one changed the same row, or the same key of
    it, in different ways, so the PR is not checked until they are resolved."""

    def __init__(self, model: str, key: str | None = None):
        where = f"{model} ({key})" if key else model
        super().__init__(f"its price file conflicts with the current one on {where}")


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
    builds from the price file it would leave on merge. A PR that changes a row the
    current file has since changed another way (see apply_pr) gets an "error" naming the
    row, and the key when one conflicts, instead, and is not checked until it is resolved. A PR is looked at when its title
    or body mentions pricing or a model in the report. Anything that goes wrong with one
    PR, from reading its files to checking its rows, gives that PR an "error" instead, so
    only GitHub's rate limit stops the others. More open PRs than MAX_PR_PAGES pages
    hold is a CheckError."""
    github = {"Accept": "application/vnd.github+json"}
    if token:
        github["Authorization"] = f"Bearer {token}"
    pulls: list[dict] = []
    for page in range(1, MAX_PR_PAGES + 1):
        batch = fetch_json(
            f"{GITHUB_API}/repos/{repo}/pulls?state=open&per_page=100&page={page}", headers=github
        )
        pulls += batch
        if len(batch) < 100:
            break
    else:  # The PRs past the last page read could fix a finding.
        raise CheckError(f"{len(pulls)} or more open PRs")
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
            compare = fetch_json(
                f"{GITHUB_API}/repos/{repo}/compare/{pull['base']['sha']}...{head}", headers=github
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
        except _ConflictError as exc:
            pr["error"] = str(exc)
        except _NoTimeLimitError:
            pr["error"] = "its price file was not checked: no time limit can be set here"
        except Exception as exc:  # Any error with an open PR stays with that PR.
            if getattr(exc, "code", None) in (403, 429):
                raise  # GitHub's rate limit: every later PR would fail the same way.
            pr["error"] = f"could not check its price file ({type(exc).__name__})"
        prs.append(pr)
    return prs
