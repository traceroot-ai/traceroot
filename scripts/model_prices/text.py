"""The report as text for the terminal, and the text helpers the Slack message and the
report page share with it."""

import re
from collections.abc import Callable

from .catalogs import FIELD_LABELS
from .checks import MINOR_MODELS

# Rows in the Slack price table; the JSON report has every flag.
MAX_FLAGGED_LINES = 20

# What the model-ID section lists, for both the terminal and Slack.
ID_HEADING = (
    "IDs a model has on Bedrock, Vertex AI or OpenRouter, or with [1m], that its row's "
    "matchPattern misses, so their spans record no cost or another model's price"
)

# Provider names as people write them, for counts in the Slack message.
PROVIDER_NAMES = {
    "openai": "OpenAI",
    "anthropic": "Anthropic",
    "google": "Google",
    "xai": "xAI",
    "deepseek": "DeepSeek",
    "zai": "Z.ai",
    "moonshot": "Moonshot",
    "typesafe": "TypeSafe",
}
CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def _escape(text: str) -> str:
    """Escape the characters Slack reads as markup, and keep the text on one line with
    no control characters. Model IDs come from public catalogs and row names from open
    PRs, so an ID such as <!channel> must not become a mention, a name must not start a
    line of its own, and nothing may reach the terminal as an escape sequence."""
    text = CONTROL_CHARS.sub(" ", " ".join(text.splitlines()))
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# Looks like a backtick, but does not end Slack code.
BACKTICK = "\u02cb"


def _plural(count: int, word: str) -> str:
    return f"{count} {word}" if count == 1 else f"{count} {word}s"


def _amount(per_token: float | None) -> str:
    """A per-token rate as USD per million tokens, with at least two decimals, or "none"
    for a rate our row leaves out."""
    if per_token is None:
        return "none"
    text = f"{per_token * 1e6:.4g}"
    if "e" in text:
        text = f"{per_token * 1e6:.8f}".rstrip("0")
    whole, _, fraction = text.partition(".")
    return f"{whole}.{fraction.ljust(2, '0')}"


def _catalog_amount(item: dict) -> str:
    """The catalogs' rate, or the range they span when they disagree with each other."""
    values = sorted(item[name] for name in ("litellm", "modelsdev") if item[name] is not None)
    low, high = _amount(values[0]), _amount(values[-1])
    return low if low == high else f"{low}-{high}"


def _priced_as(item: dict) -> str:
    """For a model priced through another row's pattern, which row prices it."""
    return f" (priced as {item['priced_as']})" if item.get("priced_as") else ""


def _pr_text(numbers: list[int]) -> str:
    """Open PRs as plain text, e.g. "#12, #34"."""
    return ", ".join(f"#{number}" for number in numbers)


def _tracked(report: dict) -> bool:
    return report.get("tracking") == "ok"


def _price_table(flagged: list[dict], *, tracked: bool) -> list[str]:
    """Flagged rates as an aligned code block, one row per rate, grouped by model, with
    the open PRs that would fix each rate when --track ran."""
    cells = []
    previous = None
    for item in flagged[:MAX_FLAGGED_LINES]:
        model = item["model"] + _priced_as(item) if item["model"] != previous else ""
        previous = item["model"]
        prs = _pr_text(item["tracked_by"]) if tracked and item["tracked_by"] else ""
        cells.append(
            (model, FIELD_LABELS[item["field"]], _amount(item["ours"]), _catalog_amount(item), prs)
        )
    widths = [max(len(cell[column]) for cell in cells) for column in range(4)]
    show_prs = any(cell[4] for cell in cells)
    rows = []
    for model, field, ours, theirs, prs in cells:
        last = f"{theirs:<{widths[3]}}  {prs}".rstrip() if show_prs else theirs
        rows.append(f"{model:<{widths[0]}}  {field:<{widths[1]}}  {ours:<{widths[2]}}  → {last}")
    # Pad first, then escape: Slack shows the escaped text unescaped, so columns stay
    # aligned. A backtick could end the code block, so it becomes a look-alike.
    return ["```", *(_escape(line).replace("`", BACKTICK) for line in rows), "```"]


def _with_prs(text: str, items: list[dict], report: dict) -> str:
    """Append "(2 with an open PR)" when --track found PRs for some of the items."""
    count = sum(1 for item in items if item.get("tracked_by"))
    return f"{text} ({count} with an open PR)" if _tracked(report) and count else text


def _status_parts(report: dict) -> list[tuple[str, str]]:
    """(emoji, text) for each kind of finding, problems first, e.g.
    ("red_circle", "3 models with prices to check")."""
    flagged = report["flagged"]
    # One item per flagged model, tracked when an open PR fixes any of its rates.
    models: dict[str, dict] = {}
    for item in flagged:
        model = models.setdefault(item["model"], {"tracked_by": []})
        model["tracked_by"] += item.get("tracked_by", [])
    if flagged:
        text = f"{_plural(len(models), 'model')} with prices to check"
        parts = [("red_circle", _with_prs(text, list(models.values()), report))]
    else:
        parts = [("large_green_circle", "prices match the catalogs")]
    problems = report["row_problems"] + report["overlaps"]
    if problems:
        text = _with_prs(_plural(len(problems), "price file problem"), problems, report)
        parts.append(("red_circle", text))
    unpriced = [item for item in report["unpriced_ids"] if not item["priced_as"]]
    if unpriced:
        text = _with_prs(f"{_plural(len(unpriced), 'model ID')} with no price", unpriced, report)
        parts.append(("large_orange_circle", text))
    wrong = [item for item in report["unpriced_ids"] if item["priced_as"]]
    if wrong:
        text = _with_prs(
            f"{_plural(len(wrong), 'model ID')} priced as another model", wrong, report
        )
        parts.append(("large_orange_circle", text))
    if report["missing"]:
        text = _with_prs(
            f"{_plural(len(report['missing']), 'model')} not priced", report["missing"], report
        )
        parts.append(("large_yellow_circle", text))
    return parts


def _status(report: dict) -> str:
    """One line on what needs attention, e.g. "3 models with prices to check"."""
    return ", ".join(text for _, text in _status_parts(report))


def _split_missing(missing: list[dict]) -> tuple[dict, dict]:
    """Missing models by provider: (main list, aliases/snapshots/realtime/search)."""
    main: dict[str, list[dict]] = {}
    minor: dict[str, list[dict]] = {}
    for item in missing:
        target = minor if MINOR_MODELS.search(item["model"]) else main
        target.setdefault(item["provider"], []).append(item)
    return main, minor


def _example(ids: list[str]) -> str:
    """One ID to show for a row, preferring a US Bedrock profile as the most familiar."""
    return min(ids, key=lambda model_id: (not model_id.startswith("us."), model_id))


def _id_lines(report: dict) -> tuple[list[str], list[str]]:
    """Model IDs not priced by their row, as (lines for IDs no open PR fixes, one per row, e.g.
    "• claude-x: 7 Bedrock, 1 OpenRouter, [1m], e.g. `us.anthropic.claude-x`"; lines
    naming the rows whose IDs each set of open PRs fixes)."""
    groups: dict[str, dict] = {}
    covered: dict[tuple[int, ...], list[str]] = {}
    for item in report["unpriced_ids"]:
        if item.get("tracked_by"):
            rows = covered.setdefault(tuple(item["tracked_by"]), [])
            rows += [] if item["row"] in rows else [item["row"]]
            continue
        group = groups.setdefault(item["row"], {"sources": {}, "ids": [], "wrong": []})
        if item["priced_as"]:
            group["wrong"].append(f"`{item['model']}` is priced as {item['priced_as']}")
        elif item["source"] == "1M context":
            group["sources"]["[1m]"] = 1
        else:
            group["sources"][item["source"]] = group["sources"].get(item["source"], 0) + 1
            group["ids"].append(item["model"])
    lines = []
    for row, group in sorted(groups.items()):
        parts = [
            f"{count} {source}" for source, count in group["sources"].items() if source != "[1m]"
        ]
        if group["ids"]:
            parts[-1] += f", e.g. `{_example(group['ids'])}`"
        if "[1m]" in group["sources"]:
            parts.append("[1m]")
        lines.append(f"• {_escape(row)}: {_escape(', '.join(parts + group['wrong']))}")
    covered_lines = [
        f"• _Open PR_ {_pr_text(list(prs))}: {_escape(', '.join(sorted(rows)))}"
        for prs, rows in sorted(covered.items())
    ]
    return lines, covered_lines


def _in(more_in: str | None) -> str:
    """Where the rest of a cut list can be read, e.g. " in the JSON report", or nothing
    when this run wrote no full list."""
    return f" in {more_in}" if more_in else ""


def _problem_lines(report: dict) -> list[str]:
    """Row problems and overlapping patterns, one line each."""
    lines = []
    for item in report["row_problems"]:
        lines.append((f"• {_escape(item['row'])}: {item['problem']}", item))
    for item in report["overlaps"]:
        rows = " and ".join(item["rows"])
        text = f"{item['model']} is matched by {rows} at different prices"
        lines.append((f"• {_escape(text)}; the worker uses {_escape(item['rows'][0])}", item))
    return [
        f"{line} · {_pr_text(item['tracked_by'])}" if item.get("tracked_by") else line
        for line, item in lines
    ]


def _long_context_line(report: dict) -> str:
    models = ", ".join(
        f"{item['model']} over {item['above'] // 1000}K" for item in report["long_context"]
    )
    heading = "Long-context rates the price file has no field for"
    return f"*{heading}* ({len(report['long_context'])}): {_escape(models)}"


def _pr_warnings(report: dict) -> list[str]:
    """Open PRs that would add a problem, or whose price file couldn't be checked."""
    warnings = []
    for pr in report.get("pull_requests", []):
        if pr.get("error"):
            warnings.append(f"{_pr_text([pr['number']])}: {_escape(pr['error'])}")
        elif pr["adds"]:
            added = _escape(", ".join(pr["adds"][:5]))
            more = f" and {len(pr['adds']) - 5} more" if len(pr["adds"]) > 5 else ""
            warnings.append(f"{_pr_text([pr['number']])} would add: {added}{more}")
    return warnings


def _footer(report: dict) -> str:
    footer = f"Compared {report['compared']} of {report['total']} rows with LiteLLM and models.dev"
    if report["no_match"]:
        footer += f" · {len(report['no_match'])} are in neither catalog under the same ID"
    if report["unmapped_providers"]:
        footer += f" · no catalog for {', '.join(report['unmapped_providers'])}"
    if _tracked(report):
        footer += f" · checked {_plural(len(report['pull_requests']), 'open pricing PR')}"
    elif report.get("tracking"):
        footer += f" · open PRs not checked: {report['tracking']}"
    return footer


def _count(by_provider: dict[str, list[dict]]) -> int:
    return sum(len(items) for items in by_provider.values())


def _names(by_provider: dict[str, list[dict]]) -> str:
    """Model names grouped by provider, e.g. "• *openai* (2): gpt-a, gpt-b (#12)"."""

    def name(item: dict) -> str:
        prs = item.get("tracked_by")
        return f"{_escape(item['model'])} ({_pr_text(prs)})" if prs else _escape(item["model"])

    return "\n".join(
        f"• *{_escape(provider)}* ({len(items)}): {', '.join(map(name, items))}"
        for provider, items in sorted(by_provider.items())
    )


def format_report(report: dict, more_in: str | None = None) -> str:
    """The report as text for the terminal: what to fix first, then context. more_in
    names where the rest of a cut list can be read, such as "the JSON report"."""
    flagged = report["flagged"]
    lines = [f"*Model pricing audit, {report['date']}*: {_status(report)}"]
    if "baseline" in report:
        for word in ("fixes", "adds"):
            found = report["baseline"][word]
            listed = "\n".join(f"• {_escape(item)}" for item in found) or "• nothing"
            lines += ["", f"*Compared with the baseline, this file {word}* ({len(found)})", listed]

    if flagged:
        lines += ["", "*Prices to check* (USD per 1M tokens, ours → catalogs)"]
        lines += _price_table(flagged, tracked=_tracked(report))
        if len(flagged) > MAX_FLAGGED_LINES:
            lines.append(f"…and {len(flagged) - MAX_FLAGGED_LINES} more{_in(more_in)}")
        pages = dict.fromkeys(
            (item["provider"], item["pricing_page"]) for item in flagged if item["pricing_page"]
        )
        if pages:
            links = " · ".join(f"<{url}|{_escape(provider)}>" for provider, url in pages)
            lines.append(f"Pricing pages: {links}")

    if report["unpriced_ids"]:
        count = len(report["unpriced_ids"])
        heading = f"*Model IDs not priced by their row* ({count}): {ID_HEADING}"
        open_ids, covered = _id_lines(report)
        lines += ["", heading, *open_ids, *covered]
    problems = _problem_lines(report)
    if problems:
        lines += ["", f"*Price file problems* ({len(problems)})", *problems]

    # Every missing name appears, one line per provider, so none is cut from the report.
    main, minor = _split_missing(report["missing"])
    if main:
        lines += ["", f"*Not priced* ({_count(main)})", _names(main)]
    if minor:
        heading = f"*Also not priced: aliases, snapshots, realtime and search* ({_count(minor)})"
        lines += ["", heading, _names(minor)]
    if report["long_context"]:
        lines += ["", _long_context_line(report)]
    warnings = _pr_warnings(report)
    if warnings:
        lines += ["", "*Open PRs to check*", *(f"• {warning}" for warning in warnings)]

    lines += ["", f"_{_escape(_footer(report))}._"]
    return "\n".join(lines)


def _join(words: list[str]) -> str:
    """ "a", "a and b", "a, b and c"."""
    return words[0] if len(words) == 1 else f"{', '.join(words[:-1])} and {words[-1]}"


def _problem_text(item: dict, name: Callable[[str], str] = str) -> str:
    """A row problem or overlap in a few words, with each row name or model ID passed
    through name."""
    if "problem" in item:
        return f"{name(item['row'])}: {item['problem']}"
    rows = _join([name(row) for row in item["rows"]])
    return f"{name(item['model'])} is matched by {rows} at different prices"


def format_failure(date: str, reason: str) -> str:
    return (
        f"*Model pricing audit FAILED, {date}*: {_escape(reason)}. "
        "Nothing was compared, so this is not an all-clear."
    )
