"""Import LangSmith traces into a TraceRoot project.

Examples:
    # Preview a bulk export without sending anything
    python -m scripts.import_langsmith --parquet ./langsmith-export --dry-run

    # Import a date range from the LangSmith API, redacting emails/phones/SSNs
    python -m scripts.import_langsmith --api-project my-project \\
        --start 2026-08-01 --end 2026-11-01 --redact basic

TRACEROOT_API_KEY and TRACEROOT_HOST_URL select the destination project (the key is
project-scoped). LANGSMITH_API_KEY is needed only for --api-project.
"""

import argparse
import logging
import os
import sys
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

from .convert import IMPORT_SOURCE, Span, run_to_span
from .readers import in_window, read_api, read_jsonl, read_parquet
from .redact import Redactor, load_redactor
from .report import Summary, verify
from .sender import Sender, batches, build_request

DEFAULT_HOST_URL = "https://app.traceroot.ai"
logger = logging.getLogger("import_langsmith")


def _parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m scripts.import_langsmith",
        description="Import LangSmith traces into TraceRoot.",
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--parquet", type=Path, help="Bulk-export Parquet file or directory")
    source.add_argument("--jsonl", type=Path, help="Runs saved one JSON object per line")
    source.add_argument("--api-project", help="LangSmith project name or ID to pull via the API")

    parser.add_argument("--start", type=_parse_time, help="Only runs starting at/after this (UTC)")
    parser.add_argument("--end", type=_parse_time, help="Only runs starting before this (UTC)")
    parser.add_argument(
        "--redact",
        help="'basic' (emails, phones, SSNs), 'path/to/file.py:fn', or 'module:fn'",
    )
    parser.add_argument(
        "--use-langsmith-cost",
        action="store_true",
        help="Keep LangSmith's recorded LLM cost instead of TraceRoot's pricing",
    )
    parser.add_argument("--dry-run", action="store_true", help="Convert and summarize only")
    parser.add_argument("--show-trees", type=int, default=3, help="Trace trees to print")
    parser.add_argument(
        "--verify",
        type=int,
        default=20,
        help="After sending, compare this many random traces with TraceRoot (0 to skip)",
    )
    parser.add_argument("--verify-timeout", type=float, default=180.0)
    parser.add_argument("--batch-spans", type=int, default=500)
    parser.add_argument("--batch-bytes", type=int, default=4_000_000)
    parser.add_argument("--min-interval", type=float, default=0.2, help="Seconds between POSTs")
    parser.add_argument(
        "--host-url", default=os.environ.get("TRACEROOT_HOST_URL", DEFAULT_HOST_URL)
    )
    parser.add_argument("--api-key", default=os.environ.get("TRACEROOT_API_KEY"))
    parser.add_argument("-v", "--verbose", action="store_true")
    return parser.parse_args(argv)


def read_runs(args: argparse.Namespace) -> Iterator[dict]:
    if args.api_project:
        yield from read_api(args.api_project, args.start, args.end)
        return
    runs = read_parquet(args.parquet) if args.parquet else read_jsonl(args.jsonl)
    for run in runs:
        if in_window(run, args.start, args.end):
            yield run


def apply_redaction(span: Span, redactor: Redactor) -> Span:
    attributes = redactor(dict(span.attributes))
    if not isinstance(attributes, dict):
        raise SystemExit("Redaction hook must return a dict; aborting so nothing leaks")
    span.attributes = attributes
    if span.status_message:
        span.status_message = str(
            redactor({"status.message": span.status_message}).get("status.message", "")
        )
    return span


def convert_all(
    args: argparse.Namespace, summary: Summary, redactor: Redactor | None
) -> Iterator[Span]:
    for run in read_runs(args):
        span = run_to_span(run, use_langsmith_cost=args.use_langsmith_cost)
        if redactor:
            span = apply_redaction(span, redactor)
        summary.add(span)
        yield span


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(message)s",
    )
    if not args.dry_run and not args.api_key:
        print("TRACEROOT_API_KEY (or --api-key) is required unless --dry-run", file=sys.stderr)
        return 2

    redactor = load_redactor(args.redact)
    summary = Summary(show_trees=args.show_trees)
    spans = convert_all(args, summary, redactor)

    if args.dry_run:
        for _ in spans:
            pass
        print(summary.render())
        print("\nDry run: nothing was sent.")
        return 0

    sender = Sender(args.host_url, args.api_key, min_interval=args.min_interval)
    resource = {"service.name": "langsmith-import", "traceroot.import.source": IMPORT_SOURCE}
    sent = 0
    for batch in batches(spans, args.batch_spans, args.batch_bytes):
        sender.send(build_request(batch, resource))
        sent += len(batch)
        logger.info("Sent %d spans", sent)
    print(summary.render())
    print(f"\nSent {sent} spans in {len(summary.per_trace)} traces to {sender.endpoint}")

    if args.verify and summary.per_trace:
        print(f"Verifying {min(args.verify, len(summary.per_trace))} traces...")
        problems = verify(
            summary, args.host_url, args.api_key, sample=args.verify, timeout=args.verify_timeout
        )
        for problem in problems:
            print(f"  MISMATCH {problem}")
        print("Verification passed." if not problems else f"{len(problems)} mismatches.")
        return 1 if problems else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
