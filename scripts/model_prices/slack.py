"""The Slack message: a short Block Kit summary of a run, and posting it."""

import json
from typing import Any
from urllib.request import Request, urlopen

from .catalogs import FIELD_LABELS, TIMEOUT_SECONDS, USER_AGENT
from .text import (
    BACKTICK,
    MAX_FLAGGED_LINES,
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
    _priced_as,
    _problem_text,
    _rate_rows,
    _tracked,
    footer,
    pr_warnings,
    sections,
    summary,
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
    for first, item, rate in _rate_rows(flagged):
        model = _cell(item["model"], url=item["pricing_page"], note=_priced_as(item))
        rows.append([model if first else _cell(" "), *map(_cell, rate)])
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


def _detail(key: str, items: list[dict]) -> str:
    """What a bullet on findings no open PR fixes says after their count."""
    match key:
        case "prices":
            return ", USD per 1M tokens, ours vs. the catalogs:"
        case "ids":
            hosted = [item["model"] for item in items if item["source"] != "1M context"]
            example = f" Example: {_code(_example(hosted))}" if hosted else ""
            models = _plural(len({item["row"] for item in items}), "model")
            return (
                f", so their spans record no cost. These are the {_sources(items)} IDs of "
                f"{models} we already price: {_by_provider(items)}.{example}"
            )
        case "wrong" | "problems":
            return f", e.g. {_problem_text(items[0], _code)}"
        case _:  # missing
            return f": {_by_provider(items)}"


def _needs_lines(found: list[Section]) -> list[str]:
    """One bullet per kind of finding no open PR fixes, in the summary's words."""
    lines = []
    for section in found:
        items = _open(section.items)
        if section.word and items:
            lines.append(f"• *{section.phrase(items)}*{_detail(section.key, items)}")
    return lines


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
            ours = "none" if item["ours"] is None else f"${_amount(item['ours'])}"
            what = f"{FIELD_LABELS[item['field']]} {ours} → ${_catalog_amount(item)}"
        else:
            what = _join(list(dict.fromkeys(FIELD_LABELS[i["field"]] for i in items)))
        lines.append(f"• {models} {what}: {_pr_text(list(prs))}")
    return lines


def _progress_lines(report: dict, found: list[Section]) -> list[str]:
    """Findings open PRs fix, grouped by PR, then open PRs with a problem."""
    lines = []
    for section in found:
        items = [item for item in section.items if item.get("tracked_by")]
        if section.key == "prices":
            lines += _rate_progress(items)
        elif section.key in ("missing", "variants"):
            lines += [
                f"• {_code(i['model'])} not priced: {_pr_text(i['tracked_by'])}" for i in items
            ]
        elif section.word and items:
            numbers = sorted({number for item in items for number in item["tracked_by"]})
            lines.append(f"• {section.phrase(items)}: {_pr_text(numbers)}")
    return lines + [f"• :warning: {warning}" for warning in pr_warnings(report, _code)]


def build_payload(report: dict, report_url: str | None = None, more_in: str | None = None) -> dict:
    """The Slack message (Block Kit) for a completed run: what needs a fix and has no open
    PR, then what open PRs already fix. The full lists are in the report page, which also
    links each PR; here they are plain numbers, since a GitHub link unfurls into a preview.
    more_in names where the rest of a cut list can be read, such as "the full report"."""
    found = sections(report)
    flagged = _open(found[0].items)
    needs = _needs_lines(found)
    title = f"Model pricing audit · {report['date']}"
    blocks: list[dict] = [
        {"type": "header", "text": {"type": "plain_text", "text": _clip(title, HEADER_LIMIT)}}
    ]
    status = summary(report, open_only=True)
    scope = ", no PR yet" if needs and _tracked(report) else ""
    if not needs:
        text = f":large_green_circle: *{status[0].upper()}{status[1:]}*"
        blocks.append({"type": "section", "block_id": "needs", "text": _mrkdwn(text)})
    heading, block_id = f":red_circle: *Needs a fix{scope}*", "needs"
    if flagged:
        # The rates get a table, and the other bullets follow it.
        text = f"{heading}\n{needs.pop(0)}"
        blocks.append({"type": "section", "block_id": block_id, "text": _mrkdwn(text)})
        blocks.append(_price_table_block(flagged))
        if len(flagged) > MAX_FLAGGED_LINES:
            more = f"…and {len(flagged) - MAX_FLAGGED_LINES} more rates{_in(more_in)}"
            blocks.append(
                {"type": "context", "block_id": "prices_more", "elements": [_mrkdwn(more)]}
            )
        heading, block_id = "", "needs_more"
    if needs:
        text = _fit(heading, needs, SECTION_LIMIT, more_in).lstrip("\n")
        blocks.append({"type": "section", "block_id": block_id, "text": _mrkdwn(text)})
    progress = _progress_lines(report, found) if _tracked(report) else []
    if progress:
        text = _fit(
            ":large_yellow_circle: *In progress (open PRs)*", progress, SECTION_LIMIT, more_in
        )
        blocks.append({"type": "section", "block_id": "progress", "text": _mrkdwn(text)})
    checked = _escape(footer(report))
    checked = _clip(
        f"<{report_url}|Full report> · {checked}" if report_url else checked, CONTEXT_LIMIT
    )
    blocks.append({"type": "context", "block_id": "footer", "elements": [_mrkdwn(checked)]})
    return {"text": f"Model pricing audit, {report['date']}{scope}: {status}", "blocks": blocks}


def failure_payload(date: str, reason: str) -> dict:
    text = f":warning: {_escape(reason)}. {NOT_ALL_CLEAR}"
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
