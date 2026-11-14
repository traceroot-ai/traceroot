"""The full report as a self-contained web page."""

import html

from .catalogs import FIELD_LABELS
from .checks import MINOR_MODELS
from .text import PROVIDER_NAMES, _amount, _catalog_amount, _plural, _problem_text, _tracked

HTML_STYLE = """
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --bg: #fff;
  --line: #e5e5ea; --head: #f5f5f7; --link: #0b63ce; }
@media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #a1a1a6;
  --bg: #1c1c1e; --line: #3a3a3c; --head: #2c2c2e; --link: #64a8ff; } }
body { margin: 0 auto; max-width: 1100px; padding: 24px 16px 48px; background: var(--bg);
  color: var(--fg); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 32px 0 4px; }
p.note { color: var(--muted); margin: 0 0 10px; } a { color: var(--link); }
.scroll { overflow-x: auto; } table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid var(--line); padding: 6px 10px; text-align: left;
  vertical-align: top; } th { background: var(--head); font-weight: 600; }
td.num { text-align: right; font-variant-numeric: tabular-nums; } code { font-size: 13px; }
"""


def _h(text: object) -> str:
    return html.escape(str(text))


def _html_prs(numbers: list[int], urls: dict[int, str]) -> str:
    links = [f'<a href="{_h(urls[n])}">#{n}</a>' if urls.get(n) else f"#{n}" for n in numbers or []]
    return ", ".join(links) or "—"


def _html_table(heading: str, note: str, columns: list[str], rows: list[list[str]]) -> str:
    """A report section: heading, a sentence on what it lists, and a table of
    already-escaped cells; right-aligned when a column title starts with "#"."""
    if not rows:
        return ""
    numeric = [column.startswith("#") for column in columns]
    head = "".join(f"<th>{_h(column.lstrip('#'))}</th>" for column in columns)
    body = "".join(
        "<tr>"
        + "".join(
            f'<td class="num">{cell}</td>' if numeric[i] else f"<td>{cell}</td>"
            for i, cell in enumerate(row)
        )
        + "</tr>"
        for row in rows
    )
    return (
        f"<h2>{_h(heading)} ({len(rows)})</h2><p class='note'>{_h(note)}</p>"
        f"<div class='scroll'><table><tr>{head}</tr>{body}</table></div>"
    )


def build_html(report: dict) -> str:
    """The full report as a self-contained web page: every finding, with the open PRs
    that fix it. The Slack message summarizes it and links here."""
    title = f"Model pricing audit · {report['date']}"
    if report["status"] != "ok":
        body = (
            f"<h1>{_h(title)}</h1><p><strong>The check failed:</strong> "
            f"{_h(report['error'])}. Nothing was compared, so this is not an all-clear.</p>"
        )
        return _html_page(title, body)
    urls = {pr["number"]: pr.get("url") for pr in report.get("pull_requests", [])}
    tracked = _tracked(report)

    def prs(item: dict) -> str:
        return _html_prs(item.get("tracked_by", []), urls) if tracked else "not checked"

    sections = [
        _html_table(
            "Prices to check",
            "Rates that differ by more than 3% from every catalog that lists the model, in "
            "USD per 1M tokens. Confirm on the provider's page before changing a row.",
            ["Model", "Priced by row", "Rate", "#Ours", "#Catalogs", "Open PRs"],
            [
                [
                    f'<a href="{_h(i["pricing_page"])}">{_h(i["model"])}</a>'
                    if i["pricing_page"]
                    else _h(i["model"]),
                    _h(i.get("priced_as") or i["model"]),
                    _h(FIELD_LABELS[i["field"]]),
                    _h(_amount(i["ours"])),
                    _h(_catalog_amount(i)),
                    prs(i),
                ]
                for i in report["flagged"]
            ],
        ),
        _html_table(
            "Model IDs not priced by their row",
            "The same model under another name: the ID a span carries when the model is "
            "called through Bedrock, Vertex AI or OpenRouter, or with [1m]. The row exists, "
            "but its matchPattern misses this ID, so these spans record no cost, or another "
            "model's price when a different row's pattern matches it.",
            ["Row", "Model ID", "From", "Priced as", "Open PRs"],
            [
                [
                    _h(i["row"]),
                    f"<code>{_h(i['model'])}</code>",
                    _h(i["source"]),
                    _h(i["priced_as"] or "no row"),
                    prs(i),
                ]
                for i in report["unpriced_ids"]
            ],
        ),
        _html_table(
            "Price file problems",
            "Found in the price file itself, including rows no catalog lists.",
            ["Row or ID", "Problem", "Open PRs"],
            [
                [_h(i.get("row") or i["model"]), _h(_problem_text(i).split(": ", 1)[-1]), prs(i)]
                for i in report["row_problems"] + report["overlaps"]
            ],
        ),
        _html_table(
            "Models not priced",
            "Models a catalog prices for one of our providers that no row matches at all, so "
            "spans that use them record no cost. Variants are -latest aliases, dated "
            "snapshots, and realtime and search models.",
            ["Provider", "Model", "Kind", "Listed in", "Open PRs"],
            [
                [
                    _h(PROVIDER_NAMES.get(i["provider"], i["provider"])),
                    f"<code>{_h(i['model'])}</code>",
                    "variant" if MINOR_MODELS.search(i["model"]) else "model",
                    _h(", ".join(i["in"])),
                    prs(i),
                ]
                for i in sorted(
                    report["missing"],
                    key=lambda i: (bool(MINOR_MODELS.search(i["model"])), i["provider"]),
                )
            ],
        ),
        _html_table(
            "Long-context rates",
            "Models a catalog charges more for above a prompt size. The price file has one "
            "rate per token type, so longer prompts are recorded at the lower rate.",
            ["Model", "Provider", "#Higher rate above"],
            [
                [
                    _h(i["model"]),
                    _h(PROVIDER_NAMES.get(i["provider"], i["provider"])),
                    f"{i['above'] // 1000}K tokens",
                ]
                for i in report["long_context"]
            ],
        ),
        _html_table(
            "Open pricing PRs",
            "Each PR's row changes applied to the current price file and checked again.",
            ["PR", "Title", "Fixes", "Would add"],
            [
                [
                    _html_prs([pr["number"]], urls),
                    _h(pr.get("title") or ""),
                    _h(pr.get("error") or "; ".join(pr["fixes"]) or "—"),
                    _h("; ".join(pr["adds"]) or "—"),
                ]
                for pr in report.get("pull_requests", [])
            ],
        ),
    ]
    checked = (
        f"Checked {report['compared']} of {report['total']} rows against LiteLLM and models.dev"
    )
    if tracked:
        checked += f", and {_plural(len(report['pull_requests']), 'open pricing PR')}"
    elif report.get("tracking"):
        checked += f". Open PRs not checked: {report['tracking']}"
    not_compared = ", ".join(report["no_match"])
    body = (
        f"<h1>{_h(title)}</h1><p class='note'>{_h(checked)}.</p>"
        + "".join(sections)
        + (
            f"<h2>Not compared ({len(report['no_match'])})</h2><p class='note'>Rows neither "
            f"catalog lists under the same ID.</p><p>{_h(not_compared)}</p>"
            if report["no_match"]
            else ""
        )
    )
    return _html_page(title, body)


def _html_page(title: str, body: str) -> str:
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{_h(title)}</title><style>{HTML_STYLE}</style></head>"
        f"<body>{body}</body></html>\n"
    )
