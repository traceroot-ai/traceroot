"""The Slack message: a short Block Kit summary of a run, and posting it.

A completed run's message, top to bottom: the header; "needs", one bullet per kind of
finding no open PR fixes; with flagged rates, "prices_caption", the "prices" table with
one row per model and, when the table is cut, "prices_more"; a divider; "progress", on
what open PRs fix; "pr_warnings", naming open PRs that would add problems or could not
be checked; and "footer", which links the full report.

The job that posts the message may add one context block, block_id "provider_pages",
with short notes from the providers' pricing pages. It goes directly after the table and
its "prices_more" line, the last block whose block_id starts with "prices", or, with no
table, directly before the divider, which every completed run's message has.

The full report is the only link: Slack previews every link, so pricing pages and PRs
are plain text, and every mrkdwn text is verbatim, so Slack links no bare domain either.
Text from a catalog or an open PR is inline code or table text, never read as mrkdwn.
"""

import json
from typing import Any
from urllib.request import Request, urlopen

from .catalogs import FIELD_LABELS, TIMEOUT_SECONDS, USER_AGENT
from .text import (
    BACKTICK,
    NOT_ALL_CLEAR,
    PROVIDER_NAMES,
    Section,
    _amount,
    _catalog_amount,
    _escape,
    _example,
    _in,
    _join,
    _open,
    _plural,
    _pr_text,
    _problem_text,
    _tracked,
    footer,
    sections,
    summary,
)

# Slack Block Kit text limits.
HEADER_LIMIT = 150
SECTION_LIMIT = 3000
CONTEXT_LIMIT = 2000
# Models in the price table; the full report has every flag.
MAX_TABLE_MODELS = 15
# Providers named in the bullet on models not priced; the rest are counted.
TOP_PROVIDERS = 3
# Models named in the line on models open PRs price.
MAX_NAMED_MODELS = 5
# Characters of a failure's reason in the message; the notification text has all of it.
FAILURE_REASON_LIMIT = 1000


def _code(text: str) -> str:
    """Text from a catalog or an open PR, such as a model ID, as Slack inline code. Slack
    renders no bold, italics, strikethrough, emoji or links inside code, so the text
    can't pose as the message's own; a backtick in it, which would end the code, becomes
    a look-alike."""
    return f"`{_escape(text).replace('`', BACKTICK)}`"


def _rate(per_token: float | None) -> str:
    """A rate in USD per 1M tokens as Slack shows it: a whole number bare, otherwise
    with at least two decimals, e.g. "10", "2.50", "0.125"."""
    return _amount(per_token).removesuffix(".00")


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
    """mrkdwn that Slack shows as written: verbatim, so a bare domain is not a link."""
    return {"type": "mrkdwn", "text": text, "verbatim": True}


def _header(text: str) -> dict:
    return {
        "type": "header",
        "text": {"type": "plain_text", "text": _clip(text, HEADER_LIMIT), "emoji": True},
    }


def _section(block_id: str, text: str) -> dict:
    return {
        "type": "section",
        "block_id": block_id,
        "expand": True,
        "text": _mrkdwn(_clip(text, SECTION_LIMIT)),
    }


def _context(block_id: str, text: str) -> dict:
    return {
        "type": "context",
        "block_id": block_id,
        "elements": [_mrkdwn(_clip(text, CONTEXT_LIMIT))],
    }


def _rich(*elements: dict) -> dict:
    """A table cell as rich text, which Slack never reads as mrkdwn."""
    return {
        "type": "rich_text",
        "elements": [{"type": "rich_text_section", "elements": [*elements]}],
    }


def _text(text: str, **style: bool) -> dict:
    element: dict[str, Any] = {"type": "text", "text": text}
    if style:
        element["style"] = style
    return element


def _price_row(model: str, rates: dict[str, dict]) -> list[dict]:
    """A model's table row: input / output when both are flagged, otherwise its first
    flagged rate, named after the model."""
    paired = [rates[field] for field in ("input", "output") if field in rates]
    shown = paired if len(paired) == 2 else paired[:1] or [next(iter(rates.values()))]
    name = [_text(model, code=True)]
    if len(shown) == 1:
        name.append(_text(f" {FIELD_LABELS[shown[0]['field']]}", italic=True))
    ours = " / ".join(_rate(item["ours"]) for item in shown)
    theirs = " / ".join(_catalog_amount(item, _rate) for item in shown)
    return [_rich(*name), {"type": "raw_text", "text": ours}, {"type": "raw_text", "text": theirs}]


def _price_blocks(flagged: list[dict], more_in: str | None) -> list[dict]:
    """The flagged rates no open PR fixes: a caption, a table with one row per model,
    and, when that is cut, how many models are left out."""
    by_model: dict[str, dict[str, dict]] = {}
    for item in flagged:
        by_model.setdefault(item["model"], {})[item["field"]] = item
    caption = "USD per 1M tokens · input / output unless noted"
    caption += f" · cache rates{_in(more_in)}" if more_in else ""
    titles = [_rich(_text(title, bold=True)) for title in ("Model", "Ours", "Catalogs")]
    shown = list(by_model.items())[:MAX_TABLE_MODELS]
    blocks = [
        _context("prices_caption", caption),
        {
            "type": "table",
            "block_id": "prices",
            "column_settings": [{"is_wrapped": True}, {"align": "right"}, {"align": "right"}],
            "rows": [titles, *(_price_row(model, rates) for model, rates in shown)],
        },
    ]
    if len(by_model) > MAX_TABLE_MODELS:
        more = f"…and {len(by_model) - MAX_TABLE_MODELS} more models{_in(more_in)}"
        blocks.append(_context("prices_more", more))
    return blocks


def _by_provider(items: list[dict]) -> str:
    """Counts by provider, largest first, the rest summed, e.g. "OpenAI 29, Anthropic
    26, xAI 4 and 7 more"."""
    counts: dict[str, int] = {}
    for item in items:
        counts[item["provider"]] = counts.get(item["provider"], 0) + 1
    ranked = sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))
    shown = ", ".join(
        f"{PROVIDER_NAMES.get(name, name)} {count}" for name, count in ranked[:TOP_PROVIDERS]
    )
    rest = sum(count for _, count in ranked[TOP_PROVIDERS:])
    return f"{shown} and {rest} more" if rest else shown


def _sources(items: list[dict]) -> str:
    """Where model IDs come from, e.g. "Bedrock, OpenRouter and [1m]"."""
    names = {"[1m]" if item["source"] == "1M context" else item["source"] for item in items}
    order = ["Bedrock", "Vertex AI", "OpenRouter", "[1m]"]
    return _join(sorted(names, key=lambda name: (order.index(name) if name in order else 9, name)))


def _under_other_rows(flagged: list[dict]) -> str:
    """How many flagged models an older model's row prices through its pattern, with an
    example from the row that prices the most of them."""
    rows = {item["model"]: item["priced_as"] for item in flagged if item["priced_as"]}
    if not rows:
        return ""
    names = list(rows.values())
    row = max(dict.fromkeys(names), key=names.count)
    model = next(model for model, name in rows.items() if name == row)
    fall = "falls" if len(rows) == 1 else "fall"
    return (
        f" {len(rows)} of them {fall} under an older model's row, e.g. {_code(model)} "
        f"under {_code(row)}."
    )


def _needs_line(section: Section, items: list[dict]) -> str:
    """A bullet on findings no open PR fixes: their count in the summary's words, then a
    few words on what they are."""
    phrase = section.phrase(items)
    match section.key:
        case "prices":
            under = _under_other_rows(items)
            return f"• *{phrase}.*{under}" if under else f"• *{phrase}*"
        case "ids":
            hosted = [item["model"] for item in items if item["source"] != "1M context"]
            example = f", e.g. {_code(_example(hosted))}" if hosted else ""
            models = _plural(len({item["row"] for item in items}), "model")
            return f"• *{phrase}:* {_sources(items)} IDs of {models} we price{example}"
        case "wrong" | "problems":
            return f"• *{phrase}*, e.g. {_problem_text(items[0], _code)}"
        case _:  # missing
            return f"• *{phrase}:* {_by_provider(items)}"


def _rate_progress(flagged: list[dict]) -> list[str]:
    """Flagged rates open PRs fix, one line per set of PRs."""
    lines = []
    by_prs: dict[tuple[int, ...], list[dict]] = {}
    for item in flagged:
        by_prs.setdefault(tuple(item["tracked_by"]), []).append(item)
    for prs, items in by_prs.items():
        models = ", ".join(_code(model) for model in dict.fromkeys(i["model"] for i in items))
        if len(items) == 1:
            item = items[0]
            ours = "none" if item["ours"] is None else f"${_rate(item['ours'])}"
            what = f"{FIELD_LABELS[item['field']]} {ours} → ${_catalog_amount(item, _rate)}"
        else:
            what = _join(list(dict.fromkeys(FIELD_LABELS[i["field"]] for i in items)))
        lines.append(f"• {models} {what}: {_pr_text(list(prs))}")
    return lines


def _progress_lines(found: list[Section]) -> list[str]:
    """Findings open PRs fix: rates by PR, a count of each other kind, then the models
    they price, in one line."""
    lines, unpriced = [], []
    for section in found:
        items = [item for item in section.items if item.get("tracked_by")]
        if section.key == "prices":
            lines += _rate_progress(items)
        elif section.key in ("missing", "variants"):
            unpriced += items
        elif section.word and items:
            numbers = sorted({number for item in items for number in item["tracked_by"]})
            lines.append(f"• {section.phrase(items)}: {_pr_text(numbers)}")
    if unpriced:
        names = [f"{_code(i['model'])} ({_pr_text(i['tracked_by'])})" for i in unpriced]
        if len(names) > MAX_NAMED_MODELS:
            names = [*names[:MAX_NAMED_MODELS], f"{len(names) - MAX_NAMED_MODELS} more"]
        lines.append(f"• {_join(names)} not priced")
    return lines


def _pr_warning(report: dict, more_in: str | None) -> str:
    """Open PRs that would add problems, or couldn't be checked, by number alone; the
    full report says what."""
    prs = report.get("pull_requests", [])
    adds = [f"#{pr['number']}" for pr in prs if pr.get("adds") and not pr.get("error")]
    errors = [f"#{pr['number']}" for pr in prs if pr.get("error")]
    parts = [f"{_join(adds)} would also add problems"] if adds else []
    parts += [f"{_join(errors)} could not be checked"] if errors else []
    if not parts:
        return ""
    see = f" See {more_in}." if more_in else ""
    return f":warning: {'. '.join(parts)}.{see}"


def build_payload(report: dict, report_url: str | None = None, more_in: str | None = None) -> dict:
    """The Slack message (Block Kit) for a completed run: what needs a fix and has no open
    PR, then what open PRs already fix. The full lists are in the report page, which also
    links each pricing page and PR. more_in names where the rest of a cut list can be
    read, such as "the full report"."""
    found = sections(report)
    needs = [_needs_line(s, _open(s.items)) for s in found if s.word and _open(s.items)]
    status = summary(report, open_only=True)
    scope = ", no open PR" if needs and _tracked(report) else ""
    blocks = [_header(f"Model pricing audit · {report['date']}")]
    if needs:
        text = _fit(f":red_circle: *Needs a fix{scope}*", needs, SECTION_LIMIT, more_in)
    else:
        text = f":large_green_circle: *{status[0].upper()}{status[1:]}*"
    blocks.append(_section("needs", text))
    flagged = _open(found[0].items)
    if flagged:
        blocks += _price_blocks(flagged, more_in)
    blocks.append({"type": "divider"})
    progress = _progress_lines(found) if _tracked(report) else []
    if progress:
        text = _fit(":large_yellow_circle: *In open PRs*", progress, SECTION_LIMIT, more_in)
        blocks.append(_section("progress", text))
    warning = _pr_warning(report, more_in) if _tracked(report) else ""
    if warning:
        blocks.append(_context("pr_warnings", warning))
    checked = _escape(footer(report))
    blocks.append(
        _context("footer", f"<{report_url}|Full report> · {checked}" if report_url else checked)
    )
    return {"text": f"Model pricing audit, {report['date']}{scope}: {status}", "blocks": blocks}


def failure_payload(date: str, reason: str, report_url: str | None = None) -> dict:
    """The Slack message for a run that stopped: why, in code, and that it is not an
    all-clear. A failed run's page is not published, so the full report still shows the
    last run that completed."""
    stopped = _code(_clip(reason, FAILURE_REASON_LIMIT))
    blocks = [
        _header(f"Model pricing audit failed · {date}"),
        _section("failed", f":x: *No report today.* The check stopped: {stopped}\n{NOT_ALL_CLEAR}"),
    ]
    if report_url:
        last = f"The <{report_url}|full report> still shows the last completed run."
        blocks.append(_context("footer", last))
    text = f"Model pricing audit FAILED, {date}: {_escape(reason)}. Not an all-clear."
    return {"text": text, "blocks": blocks}


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
