#!/usr/bin/env python3
"""Run the coding-agent insights discovery queries against a project.

The queries in ``queries/`` read only the public ``spans`` and ``traces`` tables
(structure: failed tools, loops, turn shape), so they never return prompt or
output text. Labels and fix text come from the detectors' findings, and the
assistant prompt in ``assistant_prompt.md`` ties the two together.

    export TRACEROOT_API_KEY=...            # the project's API key
    python scripts/coding_agent_insights/run_queries.py --days 7
    python scripts/coding_agent_insights/run_queries.py --only q04,q06 --json
    python scripts/coding_agent_insights/run_queries.py --only q09 --repo org/repo --ids t1,t2
    python scripts/coding_agent_insights/run_queries.py --only q10 --repo org/repo --tool Bash
    python scripts/coding_agent_insights/run_queries.py --print-prompt \\
        --pattern "retry loops on the test command in org/repo" --days 7

Needs no dependencies beyond the standard library.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
QUERY_DIR = HERE / "queries"
PROMPT_PATH = HERE / "assistant_prompt.md"
DEFAULT_HOST = "https://app.traceroot.ai"
# Queries that need a value the caller must name.
NEEDS = {"q09_comparison_group": ("repo", "ids"), "q10_monitor_failure_rate": ("repo", "tool")}
_WINDOW = re.compile(r"INTERVAL\s+\d+\s+DAY")
_SAFE = re.compile(r"^[A-Za-z0-9_.:/@-]+$")


def query_names() -> list[str]:
    return sorted(p.stem for p in QUERY_DIR.glob("q*.sql"))


def render(
    name: str,
    days: int,
    repo: str | None = None,
    tool: str | None = None,
    ids: list[str] | None = None,
) -> str:
    """The query text for ``name`` with the window and placeholders filled in.

    Values are checked against a conservative character set instead of escaped,
    since a repo, tool name or trace id never needs more than that.
    """
    sql = (QUERY_DIR / f"{name}.sql").read_text()
    sql = _WINDOW.sub(f"INTERVAL {int(days)} DAY", sql)
    values = {"__REPO__": repo, "__TOOL__": tool}
    for token, value in values.items():
        if token in sql:
            if not value or not _SAFE.match(value):
                raise SystemExit(f"{name} needs a plain --{token.strip('_').lower()} value")
            sql = sql.replace(token, value)
    if "__IDS__" in sql:
        if not ids or not all(_SAFE.match(i) for i in ids):
            raise SystemExit(f"{name} needs --ids with plain trace ids")
        sql = sql.replace("__IDS__", ",".join(f"'{i}'" for i in ids))
    return sql


def run_sql(host: str, api_key: str, sql: str) -> dict:
    request = urllib.request.Request(
        f"{host.rstrip('/')}/api/v1/public/sql",
        data=json.dumps({"query": sql}).encode(),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"HTTP {exc.code}: {exc.read().decode(errors='replace')[:400]}") from exc


def table(result: dict) -> str:
    cols = [c["name"] for c in result["columns"]]
    rows = [[str(v) for v in row] for row in result["rows"]]
    widths = [
        max(len(c), *(len(r[i]) for r in rows)) if rows else len(c) for i, c in enumerate(cols)
    ]
    line = lambda cells: "  ".join(c.ljust(w) for c, w in zip(cells, widths)).rstrip()  # noqa: E731
    return "\n".join([line(cols), line(["-" * w for w in widths]), *(line(r) for r in rows)])


def filled_prompt(pattern: str, days: int, ids: list[str] | None) -> str:
    text = PROMPT_PATH.read_text()
    text = text.replace(
        '<one line, for example "retry loops on the test command in org/repo">', pattern
    )
    text = text.replace("Window: <dates>.", f"Window: the last {days} days.")
    return text.replace("<the ids>", ", ".join(ids) if ids else "<the ids>")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--host", default=os.environ.get("TRACEROOT_HOST_URL", DEFAULT_HOST))
    parser.add_argument("--days", type=int, default=7, help="window, in days (default 7)")
    parser.add_argument("--only", help="comma-separated query prefixes, e.g. q04,q06")
    parser.add_argument("--repo")
    parser.add_argument("--tool")
    parser.add_argument("--ids", help="comma-separated trace ids for q09")
    parser.add_argument("--json", action="store_true", help="print each result as JSON")
    parser.add_argument(
        "--print-prompt", action="store_true", help="print the assistant prompt and exit"
    )
    parser.add_argument(
        "--pattern", default='<one line, for example "retry loops on the test command in org/repo">'
    )
    args = parser.parse_args(argv)
    ids = args.ids.split(",") if args.ids else None

    if args.print_prompt:
        print(filled_prompt(args.pattern, args.days, ids))
        return 0

    api_key = os.environ.get("TRACEROOT_API_KEY")
    if not api_key:
        print("set TRACEROOT_API_KEY to the project's API key", file=sys.stderr)
        return 2
    wanted = [p.strip() for p in args.only.split(",")] if args.only else None
    names = [n for n in query_names() if wanted is None or any(n.startswith(w) for w in wanted)]
    if wanted is None:  # the placeholder queries run only when asked for by name
        names = [n for n in names if n not in NEEDS]
    if not names:
        print("no query matches --only", file=sys.stderr)
        return 2
    for name in names:
        sql = render(name, args.days, args.repo, args.tool, ids)
        result = run_sql(args.host, api_key, sql)
        print(f"== {name} ({result['row_count']} rows, {result['elapsed_ms']} ms)")
        print(json.dumps(result) if args.json else table(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
