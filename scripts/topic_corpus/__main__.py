"""Command line for the synthetic topic corpus.

    python -m scripts.topic_corpus manifest --seed 7 --out manifest.json
    python -m scripts.topic_corpus send --seed 7 --project-key-env KEY --out manifest.json
    python -m scripts.topic_corpus clean --seed 7 --project-id <project id>

See README.md next to this file.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from scripts.topic_corpus.generate import Corpus, CorpusParams, build_corpus


def _params(args: argparse.Namespace) -> CorpusParams:
    return CorpusParams(
        seed=args.seed,
        topics=args.topics,
        min_per_topic=args.min_per_topic,
        max_per_topic=args.max_per_topic,
        noise_share=args.noise_share,
        days=args.days,
        injections=args.injections,
        marker=args.marker,
    )


def _add_corpus_args(p: argparse.ArgumentParser) -> None:
    d = CorpusParams()
    p.add_argument("--seed", type=int, default=d.seed)
    p.add_argument("--topics", type=int, default=d.topics, help="planted tasks (1-8)")
    p.add_argument("--min-per-topic", type=int, default=d.min_per_topic)
    p.add_argument("--max-per-topic", type=int, default=d.max_per_topic)
    p.add_argument("--noise-share", type=float, default=d.noise_share)
    p.add_argument("--days", type=int, default=d.days)
    p.add_argument("--injections", type=int, default=d.injections)
    p.add_argument("--marker", default=d.marker, help="word put in every system prompt")


def _write_manifest(corpus: Corpus, out: str | None) -> None:
    if out:
        Path(out).write_text(corpus.manifest_json())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="topic_corpus", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    m = sub.add_parser("manifest", help="write the label manifest without sending anything")
    _add_corpus_args(m)
    m.add_argument("--out", help="manifest file; stdout when omitted")

    s = sub.add_parser("send", help="send the corpus through the OTLP ingestion endpoint")
    _add_corpus_args(s)
    s.add_argument(
        "--api-url", default=os.environ.get("TRACEROOT_API_URL", "http://localhost:8000")
    )
    s.add_argument(
        "--project-key-env",
        default="TOPIC_CORPUS_PROJECT_KEY",
        help="environment variable holding the project's ingest key",
    )
    s.add_argument("--out", help="also write the manifest here")

    c = sub.add_parser("clean", help="delete the corpus's traces and their topic data")
    _add_corpus_args(c)
    c.add_argument("--project-id", required=True)

    args = parser.parse_args(argv)
    corpus = build_corpus(_params(args))

    if args.command == "manifest":
        if args.out:
            _write_manifest(corpus, args.out)
        else:
            sys.stdout.write(corpus.manifest_json())
        return 0

    if args.command == "send":
        from scripts.topic_corpus.otlp import send_corpus

        key = os.environ.get(args.project_key_env, "")
        if not key:
            print(f"environment variable {args.project_key_env} is empty", file=sys.stderr)
            return 2
        _write_manifest(corpus, args.out)
        sent = send_corpus(corpus, api_url=args.api_url, api_key=key)
        print(f"sent {sent} traces ({len(corpus.traces)} in the manifest)")
        return 0

    from scripts.topic_corpus.clean import clean_corpus

    removed = clean_corpus(corpus, project_id=args.project_id)
    print(f"requested deletion of {removed} traces from project {args.project_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
