"""The report's sections, built once from a report and rendered by the terminal, the
Slack message and the report page, the text helpers those share, and the report as text
for the terminal."""

import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass

from .catalogs import FIELD_LABELS
from .checks import MINOR_MODELS

# Rates in the terminal's and Slack's price tables; the page and the JSON report have
# every flag.
MAX_FLAGGED_LINES = 20
# Provider names as people write them.
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
# Looks like a backtick, but does not end Slack code.
BACKTICK = "\u02cb"
NOT_ALL_CLEAR = "Nothing was compared, so this is not an all-clear."


@dataclass(frozen=True)
class Section:
    """A part of the report: its title, a sentence on what it lists, and its findings,
    each with the open PRs that fix it once --track ran. word and what are how the
    summary counts the findings, as in "3 model IDs with no price"; a section without
    them is context the summary leaves out."""

    key: str
    title: str
    note: str
    items: list[dict]
    word: str = ""
    what: str = ""

    def count(self, items: list[dict]) -> int:
        """How many of items the summary counts: rates by model, the rest one each."""
        return len({item["model"] for item in items}) if self.key == "prices" else len(items)

    def phrase(self, items: list[dict]) -> str:
        """items in the summary's words, e.g. "3 models with prices to check"."""
        return f"{_plural(self.count(items), self.word)} {self.what}".rstrip()


def sections(report: dict) -> list[Section]:
    """The report's findings in the order every format shows them. Missing aliases,
    snapshots, realtime and search models follow a base model's price, so they are listed
    apart from the other missing models and, like long-context rates, not counted."""
    ids, missing = report["unpriced_ids"], report["missing"]
    return [
        Section(
            "prices",
            "Prices to check",
            "Our rate → the catalogs', in USD per 1M tokens, where it differs by more than "
            "3% from every catalog that lists the model. Confirm on the provider's page "
            "before changing a row.",
            report["flagged"],
            word="model",
            what="with prices to check",
        ),
        Section(
            "ids",
            "Model IDs with no price",
            "The IDs a model we price has on Bedrock, Vertex AI or OpenRouter, or with "
            "[1m], that no row matches, so their spans record no cost.",
            [item for item in ids if not item["priced_as"]],
            word="model ID",
            what="with no price",
        ),
        Section(
            "wrong",
            "Model IDs priced as another model",
            "The IDs a model we price has on Bedrock, Vertex AI or OpenRouter, or with "
            "[1m], that another row's pattern matches at other rates, so their spans record "
            "that model's price.",
            [item for item in ids if item["priced_as"]],
            word="model ID",
            what="priced as another model",
        ),
        Section(
            "problems",
            "Price file problems",
            "Found in the price file itself, including rows no catalog lists.",
            report["row_problems"] + report["overlaps"],
            word="price file problem",
        ),
        Section(
            "missing",
            "Models not priced",
            "Models a catalog prices for one of our providers that no row matches at all, "
            "so spans that use them record no cost.",
            [item for item in missing if not MINOR_MODELS.search(item["model"])],
            word="model",
            what="not priced",
        ),
        Section(
            "variants",
            "Also not priced: aliases, snapshots, realtime and search",
            "-latest aliases, dated snapshots, and realtime, live and search models no row "
            "matches. Each follows a base model's price, so they are listed apart.",
            [item for item in missing if MINOR_MODELS.search(item["model"])],
        ),
        Section(
            "long_context",
            "Long-context rates",
            "Models a catalog charges more for above a prompt size. The price file has one "
            "rate per token type, so longer prompts are recorded at the lower rate.",
            report["long_context"],
        ),
    ]


def summary(report: dict, *, open_only: bool = False) -> str:
    """What needs a fix, e.g. "3 models with prices to check (1 with an open PR), 2 price
    file problems"; with open_only, only what no open PR fixes. When nothing does, it says
    whether open PRs fix the rest."""
    found, parts = sections(report), []
    for section in found:
        items = _open(section.items) if open_only else section.items
        if section.word and items:
            in_pr = section.count([item for item in items if item.get("tracked_by")])
            text = section.phrase(items)
            parts.append(f"{text} ({in_pr} with an open PR)" if in_pr else text)
    if parts:
        return ", ".join(parts)
    in_pr = any(item.get("tracked_by") for section in found for item in section.items)
    return "nothing needs a fix that isn't in an open PR" if in_pr else "prices match the catalogs"


def footer(report: dict) -> str:
    """What the run checked, e.g. "Checked 91 of 116 rows against LiteLLM and models.dev
    and 12 open pricing PRs · 25 are in neither catalog under the same ID"."""
    checked = (
        f"Checked {report['compared']} of {report['total']} rows against LiteLLM and models.dev"
    )
    if _tracked(report):
        checked += f" and {_plural(len(report['pull_requests']), 'open pricing PR')}"
    parts = [checked]
    if report["no_match"]:
        parts.append(f"{len(report['no_match'])} are in neither catalog under the same ID")
    if report["unmapped_providers"]:
        parts.append(f"no catalog for {', '.join(report['unmapped_providers'])}")
    if report.get("tracking") and not _tracked(report):
        parts.append(f"open PRs not checked: {report['tracking']}")
    return " · ".join(parts)


def pr_warnings(report: dict, name: Callable[[str], str]) -> list[str]:
    """Open PRs whose price file couldn't be checked, then the problems open PRs would
    add, PRs that add the same grouped, with each added problem passed through name."""
    lines = []
    adds: dict[tuple[str, ...], list[int]] = {}
    for pr in report.get("pull_requests", []):
        if pr.get("error"):
            lines.append(f"{_pr_text([pr['number']])}: {_escape(pr['error'])}")
        elif pr["adds"]:
            adds.setdefault(tuple(pr["adds"]), []).append(pr["number"])
    for added, numbers in adds.items():
        more = f" and {len(added) - 3} more" if len(added) > 3 else ""
        lines.append(f"{_pr_text(numbers)} would add: {', '.join(map(name, added[:3]))}{more}")
    return lines


def _escape(text: str) -> str:
    """Escape the characters Slack reads as markup, and keep the text on one line with
    no control characters. Model IDs come from public catalogs and row names from open
    PRs, so an ID such as <!channel> must not become a mention, a name must not start a
    line of its own, and nothing may reach the terminal as an escape sequence."""
    text = CONTROL_CHARS.sub(" ", " ".join(text.splitlines()))
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _plural(count: int, word: str) -> str:
    return f"{count} {word}" if count == 1 else f"{count} {word}s"


def _join(words: list[str]) -> str:
    """ "a", "a and b", "a, b and c"."""
    return words[0] if len(words) == 1 else f"{', '.join(words[:-1])} and {words[-1]}"


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


def _open(items: list[dict]) -> list[dict]:
    """The findings no open PR fixes; all of them when --track didn't run."""
    return [item for item in items if not item.get("tracked_by")]


def _in(more_in: str | None) -> str:
    """Where the rest of a cut list can be read, e.g. " in the JSON report", or nothing
    when this run wrote no full list."""
    return f" in {more_in}" if more_in else ""


def _example(ids: list[str]) -> str:
    """One ID to show for a row, preferring a US Bedrock profile as the most familiar."""
    return min(ids, key=lambda model_id: (not model_id.startswith("us."), model_id))


def _problem_text(item: dict, name: Callable[[str], str] = str) -> str:
    """A row problem, an overlap or a model ID priced as another model in a few words,
    with each row name or model ID passed through name."""
    if "problem" in item:
        return f"{name(item['row'])}: {item['problem']}"
    if "priced_as" in item:
        return f"{name(item['row'])}: {name(item['model'])} is priced as {name(item['priced_as'])}"
    rows = _join([name(row) for row in item["rows"]])
    first = name(item["rows"][0])
    return (
        f"{name(item['model'])} is matched by {rows} at different prices; the worker uses {first}"
    )


def _rate_rows(
    flagged: list[dict], limit: int | None = MAX_FLAGGED_LINES
) -> Iterator[tuple[bool, dict, list[str]]]:
    """The first limit flagged rates, each as (whether it is its model's first, the flag,
    [rate, ours, the catalogs'])."""
    previous = None
    for item in flagged[:limit]:
        rate = [FIELD_LABELS[item["field"]], _amount(item["ours"]), _catalog_amount(item)]
        yield item["model"] != previous, item, rate
        previous = item["model"]


def _price_table(flagged: list[dict], *, tracked: bool) -> list[str]:
    """Flagged rates as an aligned code block, one row per rate, grouped by model, with
    the open PRs that would fix each rate when --track ran."""
    cells = []
    for first, item, rate in _rate_rows(flagged):
        prs = _pr_text(item["tracked_by"]) if tracked and item["tracked_by"] else ""
        cells.append((item["model"] + _priced_as(item) if first else "", *rate, prs))
    widths = [max(len(cell[column]) for cell in cells) for column in range(4)]
    show_prs = any(cell[4] for cell in cells)
    rows = []
    for model, field, ours, theirs, prs in cells:
        last = f"{theirs:<{widths[3]}}  {prs}".rstrip() if show_prs else theirs
        rows.append(f"{model:<{widths[0]}}  {field:<{widths[1]}}  {ours:<{widths[2]}}  → {last}")
    # Pad first, then escape: Slack shows the escaped text unescaped, so columns stay
    # aligned. A backtick could end the code block, so it becomes a look-alike.
    return ["```", *(_escape(line).replace("`", BACKTICK) for line in rows), "```"]


def _id_lines(items: list[dict]) -> list[str]:
    """Model IDs with no price, one line per row for those no open PR fixes, e.g.
    "• claude-x: 7 Bedrock, 1 OpenRouter, e.g. `us.anthropic.claude-x`, [1m]", then one
    line per set of open PRs naming the rows whose IDs they fix."""
    by_row: dict[str, dict[str, list[str]]] = {}
    covered: dict[tuple[int, ...], list[str]] = {}
    for item in items:
        if item.get("tracked_by"):
            rows = covered.setdefault(tuple(item["tracked_by"]), [])
            rows += [] if item["row"] in rows else [item["row"]]
        else:
            by_row.setdefault(item["row"], {}).setdefault(item["source"], []).append(item["model"])
    lines = []
    for row, by_source in sorted(by_row.items()):
        hosted = {source: ids for source, ids in by_source.items() if source != "1M context"}
        parts = [f"{len(ids)} {source}" for source, ids in hosted.items()]
        if hosted:
            parts[-1] += f", e.g. `{_example([i for ids in hosted.values() for i in ids])}`"
        parts += ["[1m]"] if "1M context" in by_source else []
        lines.append(f"• {_escape(row)}: {_escape(', '.join(parts))}")
    return lines + [
        f"• _Open PR_ {_pr_text(list(prs))}: {_escape(', '.join(sorted(rows)))}"
        for prs, rows in sorted(covered.items())
    ]


def _names(items: list[dict]) -> str:
    """Model names grouped by provider, e.g. "• *openai* (2): gpt-a, gpt-b (#12)"."""
    by_provider: dict[str, list[str]] = {}
    for item in items:
        prs = item.get("tracked_by")
        name = f"{item['model']} ({_pr_text(prs)})" if prs else item["model"]
        by_provider.setdefault(item["provider"], []).append(_escape(name))
    return "\n".join(
        f"• *{_escape(provider)}* ({len(names)}): {', '.join(names)}"
        for provider, names in sorted(by_provider.items())
    )


def _section_lines(section: Section, *, tracked: bool, more_in: str | None) -> list[str]:
    """A section's findings as terminal lines, below its heading."""
    items = section.items
    match section.key:
        case "prices":
            lines = _price_table(items, tracked=tracked)
            if len(items) > MAX_FLAGGED_LINES:
                lines.append(f"…and {len(items) - MAX_FLAGGED_LINES} more{_in(more_in)}")
            pages = dict.fromkeys(
                (item["provider"], item["pricing_page"]) for item in items if item["pricing_page"]
            )
            if pages:
                links = " · ".join(f"<{url}|{_escape(provider)}>" for provider, url in pages)
                lines.append(f"Pricing pages: {links}")
            return lines
        case "ids":
            return _id_lines(items)
        case "wrong" | "problems":
            return [
                f"• {_escape(_problem_text(item))}"
                + (f" · {_pr_text(item['tracked_by'])}" if item.get("tracked_by") else "")
                for item in items
            ]
        case "missing" | "variants":
            # Every name appears, one line per provider, so none is cut from the report.
            return [_names(items)]
        case _:  # long_context
            above = [f"{item['model']} over {item['above'] // 1000}K" for item in items]
            return [_escape(", ".join(above))]


def format_report(report: dict, more_in: str | None = None) -> str:
    """The report as text for the terminal: what to fix first, then context. more_in
    names where the rest of a cut list can be read, such as "the JSON report"."""
    lines = [f"*Model pricing audit, {report['date']}*: {summary(report)}"]
    for section in sections(report):
        if section.items:
            lines += ["", f"*{section.title}* ({len(section.items)}): {section.note}"]
            lines += _section_lines(section, tracked=_tracked(report), more_in=more_in)
    warnings = pr_warnings(report, _escape)
    if warnings:
        lines += ["", "*Open PRs to check*", *(f"• {warning}" for warning in warnings)]
    lines += ["", f"_{_escape(footer(report))}._"]
    return "\n".join(lines)


def format_failure(date: str, reason: str) -> str:
    return f"*Model pricing audit FAILED, {date}*: {_escape(reason)}. {NOT_ALL_CLEAR}"
