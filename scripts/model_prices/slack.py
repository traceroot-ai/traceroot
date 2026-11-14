"""The Slack message: a short Block Kit summary of a run, and posting it."""

import json
from typing import Any
from urllib.request import Request, urlopen

from .catalogs import FIELD_LABELS, TIMEOUT_SECONDS, USER_AGENT
from .checks import MINOR_MODELS
from .findings import finding_keys
from .text import (
    BACKTICK,
    MAX_FLAGGED_LINES,
    PROVIDER_NAMES,
    _amount,
    _catalog_amount,
    _escape,
    _example,
    _in,
    _join,
    _plural,
    _pr_text,
    _priced_as,
    _problem_text,
    _tracked,
)

# Slack Block Kit text limits.
HEADER_LIMIT = 150
SECTION_LIMIT = 3000
CONTEXT_LIMIT = 2000


def _code(text: str) -> str:
    """Text from a catalog or an open PR, such as a model ID, as Slack inline code. Slack
    renders no bold, italics, strikethrough, emoji or links inside code, so the text
    can't pose as the message's own; a backtick in it, which would end the code, becomes
    a look-alike."""
    return f"`{_escape(text).replace('`', BACKTICK)}`"


def _fit(heading: str, lines: list[str], limit: int, more_in: str | None = None) -> str:
    """The heading and as many whole lines as fit in limit characters, then a count of
    the rest and where to read them."""
    text = heading
    for index, line in enumerate(lines):
        more = f"\n…and {len(lines) - index} more{_in(more_in)}"
        if len(text) + 1 + len(line) + len(more) > limit:
            return text + more
        text += "\n" + line
    return text


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _mrkdwn(text: str) -> dict:
    return {"type": "mrkdwn", "text": text}


def _cell(text: str, *, url: str | None = None, bold: bool = False, note: str = "") -> dict:
    """A table cell: rich text, so it can be bold, a link or carry an italic note, with
    no mrkdwn parsing."""
    element: dict[str, Any] = (
        {"type": "link", "url": url, "text": text} if url else {"type": "text", "text": text}
    )
    if bold:
        element["style"] = {"bold": True}
    elements = [element]
    if note:
        elements.append({"type": "text", "text": note, "style": {"italic": True}})
    return {"type": "rich_text", "elements": [{"type": "rich_text_section", "elements": elements}]}


def _price_table_block(flagged: list[dict]) -> dict:
    """Flagged rates as a table, one row per rate; the model name links to its pricing page."""
    rows = [[_cell(title, bold=True) for title in ("Model", "Rate", "Ours", "Catalogs")]]
    previous = None
    for item in flagged[:MAX_FLAGGED_LINES]:
        first = item["model"] != previous
        previous = item["model"]
        model = (
            _cell(item["model"], url=item["pricing_page"], note=_priced_as(item))
            if first
            else _cell(" ")
        )
        rows.append(
            [
                model,
                _cell(FIELD_LABELS[item["field"]]),
                _cell(_amount(item["ours"])),
                _cell(_catalog_amount(item)),
            ]
        )
    return {
        "type": "table",
        "block_id": "prices",
        "column_settings": [
            {"is_wrapped": True},
            {"align": "left"},
            {"align": "right"},
            {"align": "right"},
        ],
        "rows": rows,
    }


def _open(items: list[dict]) -> list[dict]:
    """The findings no open PR fixes; all of them when --track didn't run."""
    return [item for item in items if not item.get("tracked_by")]


def _by_provider(items: list[dict]) -> str:
    """Counts by provider, largest first, e.g. "OpenAI 29, Anthropic 26"."""
    counts: dict[str, int] = {}
    for item in items:
        counts[item["provider"]] = counts.get(item["provider"], 0) + 1
    ranked = sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))
    return ", ".join(f"{PROVIDER_NAMES.get(name, name)} {count}" for name, count in ranked)


def _sources(items: list[dict]) -> str:
    """Where model IDs come from, e.g. "Bedrock, OpenRouter and [1m]"."""
    names = {"[1m]" if item["source"] == "1M context" else item["source"] for item in items}
    order = ["Bedrock", "Vertex AI", "OpenRouter", "[1m]"]
    return _join(sorted(names, key=lambda name: (order.index(name) if name in order else 9, name)))


def _main_missing(items: list[dict]) -> list[dict]:
    """Unpriced models, leaving out aliases, snapshots, realtime and search models."""
    return [item for item in items if not MINOR_MODELS.search(item["model"])]


def _needs_lines(report: dict) -> list[str]:
    """One bullet per kind of finding no open PR fixes, rates aside (they get a table)."""
    lines = []
    ids = _open(report["unpriced_ids"])
    unpriced = [item for item in ids if not item["priced_as"]]
    if unpriced:
        rows = {item["row"] for item in unpriced}
        verb = "records" if len(unpriced) == 1 else "record"
        hosted = [item["model"] for item in unpriced if item["source"] != "1M context"]
        example = f" Example: {_code(_example(hosted))}" if hosted else ""
        lines.append(
            f"• *{_plural(len(unpriced), 'model ID')} {verb} no cost.* These are the "
            f"{_sources(unpriced)} IDs of {_plural(len(rows), 'model')} we already price: "
            f"{_by_provider(unpriced)}.{example}"
        )
    wrong = [item for item in ids if item["priced_as"]]
    if wrong:
        verb = "gets" if len(wrong) == 1 else "get"
        lines.append(
            f"• *{_plural(len(wrong), 'model ID')} {verb} another model's price*, e.g. "
            f"{_code(wrong[0]['model'])} is priced as {_code(wrong[0]['priced_as'])}"
        )
    problems = _open(report["row_problems"] + report["overlaps"])
    if problems:
        lines.append(
            f"• *{_plural(len(problems), 'price file problem')}*, e.g. "
            f"{_problem_text(problems[0], _code)}"
        )
    missing = _main_missing(_open(report["missing"]))
    if missing:
        verb = "isn't" if len(missing) == 1 else "aren't"
        lines.append(
            f"• *{_plural(len(missing), 'model')} {verb} priced at all:* {_by_provider(missing)}"
        )
    return lines


def _progress_lines(report: dict) -> list[str]:
    """Findings open PRs fix, grouped by PR, then PRs that would add a problem."""
    lines = []
    rates: dict[tuple[int, ...], list[dict]] = {}
    for item in report["flagged"]:
        if item.get("tracked_by"):
            rates.setdefault(tuple(item["tracked_by"]), []).append(item)
    for prs, items in rates.items():
        models = ", ".join(_code(model) for model in dict.fromkeys(i["model"] for i in items))
        if len(items) == 1:
            item = items[0]
            ours = "none" if item["ours"] is None else f"${_amount(item['ours'])}"
            change = f"{ours} → ${_catalog_amount(item)}"
            lines.append(
                f"• {models} {FIELD_LABELS[item['field']]} {change}: {_pr_text(list(prs))}"
            )
        else:
            fields = list(dict.fromkeys(FIELD_LABELS[i["field"]] for i in items))
            lines.append(f"• {models} {_join(fields)}: {_pr_text(list(prs))}")
    ids = [item for item in report["unpriced_ids"] if item.get("tracked_by")]
    if ids:
        numbers = sorted({number for item in ids for number in item["tracked_by"]})
        rows = {item["row"] for item in ids}
        lines.append(f"• {_sources(ids)} IDs of {_plural(len(rows), 'model')}: {_pr_text(numbers)}")
    problems = [i for i in report["row_problems"] + report["overlaps"] if i.get("tracked_by")]
    if problems:
        numbers = sorted({number for item in problems for number in item["tracked_by"]})
        lines.append(f"• {_plural(len(problems), 'price file problem')}: {_pr_text(numbers)}")
    for item in report["missing"]:
        if item.get("tracked_by"):
            lines.append(f"• {_code(item['model'])} not priced: {_pr_text(item['tracked_by'])}")
    adds: dict[tuple[str, ...], list[int]] = {}
    for pr in report.get("pull_requests", []):
        if pr.get("error"):
            lines.append(f"• :warning: {_pr_text([pr['number']])}: {_escape(pr['error'])}")
        elif pr["adds"]:
            adds.setdefault(tuple(pr["adds"]), []).append(pr["number"])
    for added, numbers in adds.items():
        more = f" and {len(added) - 3} more" if len(added) > 3 else ""
        what = ", ".join(map(_code, added[:3])) + more
        lines.append(f"• :warning: {_pr_text(numbers)} would add: {what}")
    return lines


def _summary(report: dict) -> str:
    """The notification text: what no open PR covers, e.g. "80 model IDs with no price"."""
    parts = []
    flagged = _open(report["flagged"])
    if flagged:
        models = dict.fromkeys(item["model"] for item in flagged)
        parts.append(f"{_plural(len(models), 'model')} with prices to check")
    ids = _open(report["unpriced_ids"])
    unpriced = [item for item in ids if not item["priced_as"]]
    if unpriced:
        parts.append(f"{_plural(len(unpriced), 'model ID')} with no price")
    if len(ids) > len(unpriced):
        parts.append(f"{_plural(len(ids) - len(unpriced), 'model ID')} priced as another model")
    problems = _open(report["row_problems"] + report["overlaps"])
    if problems:
        parts.append(_plural(len(problems), "price file problem"))
    missing = _main_missing(_open(report["missing"]))
    if missing:
        parts.append(f"{_plural(len(missing), 'model')} not priced")
    if parts:
        return ", ".join(parts)
    # Aliases, snapshots, realtime and search models are not counted here, so the line
    # speaks only of what needs a fix.
    in_prs = any(item.get("tracked_by") for item in finding_keys(report).values())
    return "nothing needs a fix that isn't in an open PR" if in_prs else "prices match the catalogs"


def _slack_footer(report: dict, report_url: str | None) -> str:
    checked = f"Checked {report['compared']} of {report['total']} rows"
    if _tracked(report):
        checked += f" and {_plural(len(report['pull_requests']), 'open pricing PR')}"
    elif report.get("tracking"):
        checked += f" · open PRs not checked: {_escape(report['tracking'])}"
    return f"<{report_url}|Full report> · {checked}" if report_url else checked


def build_payload(report: dict, report_url: str | None = None, more_in: str | None = None) -> dict:
    """The Slack message (Block Kit) for a completed run: what needs a fix and has no open
    PR, then what open PRs already fix. The full lists are in the report page, which also
    links each PR; here they are plain numbers, since a GitHub link unfurls into a preview.
    more_in names where the rest of a cut list can be read, such as "the full report"."""
    flagged = _open(report["flagged"])
    needs = _needs_lines(report)
    progress = _progress_lines(report) if _tracked(report) else []
    title = f"Model pricing audit · {report['date']}"
    blocks: list[dict] = [
        {"type": "header", "text": {"type": "plain_text", "text": _clip(title, HEADER_LIMIT)}}
    ]
    if flagged or needs:
        heading = (
            ":red_circle: *Needs a fix, no PR yet*"
            if _tracked(report)
            else (":red_circle: *Needs a fix*")
        )
        if not flagged:
            text = _fit(heading, needs, SECTION_LIMIT, more_in)
            blocks.append({"type": "section", "block_id": "needs", "text": _mrkdwn(text)})
        else:
            # The rates get a table, and the other bullets follow it.
            models = dict.fromkeys(item["model"] for item in flagged)
            heading += (
                f"\n• *{_plural(len(models), 'model')} with prices to check*, USD per 1M tokens, "
                "ours vs. the catalogs:"
            )
            blocks.append({"type": "section", "block_id": "needs", "text": _mrkdwn(heading)})
            blocks.append(_price_table_block(flagged))
            if len(flagged) > MAX_FLAGGED_LINES:
                more = f"…and {len(flagged) - MAX_FLAGGED_LINES} more rates{_in(more_in)}"
                blocks.append(
                    {"type": "context", "block_id": "prices_more", "elements": [_mrkdwn(more)]}
                )
            if needs:
                text = _fit("", needs, SECTION_LIMIT, more_in).lstrip("\n")
                blocks.append({"type": "section", "block_id": "needs_more", "text": _mrkdwn(text)})
    else:
        text = (
            ":large_green_circle: *Nothing needs a fix that isn't in an open PR*"
            if progress
            else ":large_green_circle: *Prices match the catalogs*"
        )
        blocks.append({"type": "section", "block_id": "needs", "text": _mrkdwn(text)})
    if progress:
        heading = ":large_yellow_circle: *In progress (open PRs)*"
        text = _fit(heading, progress, SECTION_LIMIT, more_in)
        blocks.append({"type": "section", "block_id": "progress", "text": _mrkdwn(text)})
    footer = _clip(_slack_footer(report, report_url), CONTEXT_LIMIT)
    blocks.append({"type": "context", "block_id": "footer", "elements": [_mrkdwn(footer)]})
    return {"text": f"Model pricing audit, {report['date']}: {_summary(report)}", "blocks": blocks}


def failure_payload(date: str, reason: str) -> dict:
    text = f":warning: {_escape(reason)}. Nothing was compared, so this is not an all-clear."
    title = f"Model pricing audit FAILED · {date}"
    return {
        "text": f"Model pricing audit FAILED, {date}: {_escape(reason)}",
        "blocks": [
            {"type": "header", "text": {"type": "plain_text", "text": _clip(title, HEADER_LIMIT)}},
            {"type": "section", "text": _mrkdwn(_clip(text, SECTION_LIMIT))},
        ],
    }


def post_to_slack(webhook: str, payload: dict) -> None:
    body = json.dumps(payload).encode()
    request = Request(
        webhook,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
        method="POST",
    )
    with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        response.read()
