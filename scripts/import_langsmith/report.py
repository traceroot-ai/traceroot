"""Import summary, dry-run trace trees, and post-import verification against TraceRoot."""

import random
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any

import httpx

from .convert import Span


@dataclass
class TraceTotals:
    spans: int = 0
    llm_spans: int = 0
    input_tokens: int = 0
    output_tokens: int = 0


@dataclass
class Summary:
    """Counts what was read and converted. Token totals cover LLM spans only."""

    show_trees: int = 0
    runs: int = 0
    kinds: Counter = field(default_factory=Counter)
    errors: int = 0
    per_trace: dict[str, TraceTotals] = field(default_factory=lambda: defaultdict(TraceTotals))
    per_day: dict[str, Counter] = field(default_factory=lambda: defaultdict(Counter))
    _tree_spans: dict[str, list[Span]] = field(default_factory=dict)

    def add(self, span: Span) -> None:
        trace_hex = span.trace_id.hex()
        kind = span.attributes.get("openinference.span.kind", "CHAIN")
        totals = self.per_trace[trace_hex]
        totals.spans += 1
        self.runs += 1
        self.kinds[kind] += 1
        if span.status_code == 2:
            self.errors += 1
        day = time.strftime("%Y-%m-%d", time.gmtime(span.start_ns / 1e9))
        if span.parent_span_id is None:
            self.per_day[day]["traces"] += 1
        if kind == "LLM":
            prompt = int(span.attributes.get("llm.token_count.prompt", 0))
            completion = int(span.attributes.get("llm.token_count.completion", 0))
            totals.llm_spans += 1
            totals.input_tokens += prompt
            totals.output_tokens += completion
            self.per_day[day]["input_tokens"] += prompt
            self.per_day[day]["output_tokens"] += completion
        if trace_hex in self._tree_spans:
            self._tree_spans[trace_hex].append(span)
        elif len(self._tree_spans) < self.show_trees:
            self._tree_spans[trace_hex] = [span]

    def render(self) -> str:
        lines = [
            f"Runs read: {self.runs}   Traces: {len(self.per_trace)}   Errored runs: {self.errors}",
            "Span kinds: " + ", ".join(f"{k}={v}" for k, v in sorted(self.kinds.items())),
            "",
            f"{'Day (UTC)':<12}{'Traces':>8}{'LLM input tok':>16}{'LLM output tok':>16}",
        ]
        for day in sorted(self.per_day):
            row = self.per_day[day]
            lines.append(
                f"{day:<12}{row['traces']:>8}{row['input_tokens']:>16}{row['output_tokens']:>16}"
            )
        for trace_hex, spans in self._tree_spans.items():
            lines += ["", f"Trace {trace_hex}:"] + _tree_lines(spans)
        return "\n".join(lines)


def _tree_lines(spans: list[Span], max_lines: int = 60) -> list[str]:
    by_parent: dict[bytes | None, list[Span]] = defaultdict(list)
    ids = {s.span_id for s in spans}
    for span in spans:
        parent = span.parent_span_id if span.parent_span_id in ids else None
        by_parent[parent].append(span)
    lines: list[str] = []

    def walk(parent: bytes | None, depth: int) -> None:
        for span in sorted(by_parent.get(parent, []), key=lambda s: s.start_ns):
            if len(lines) >= max_lines:
                return
            kind = span.attributes.get("openinference.span.kind")
            tokens = ""
            if kind == "LLM":
                tokens = (
                    f"  {span.attributes.get('llm.token_count.prompt', 0)} in / "
                    f"{span.attributes.get('llm.token_count.completion', 0)} out"
                )
            error = "  ERROR" if span.status_code == 2 else ""
            lines.append(f"{'  ' * (depth + 1)}{span.name} [{kind}]{tokens}{error}")
            walk(span.span_id, depth + 1)

    walk(None, 0)
    if len(lines) >= max_lines:
        lines.append("  ...")
    return lines


def verify(
    summary: Summary,
    host_url: str,
    api_key: str,
    *,
    sample: int,
    timeout: float,
    client: httpx.Client | None = None,
) -> list[str]:
    """Compare a sample of imported traces with what TraceRoot stored.

    Ingest is asynchronous, so each trace is polled until its span count matches or
    the timeout passes. Returns a list of mismatch descriptions (empty when clean).
    """
    client = client or httpx.Client(timeout=30, follow_redirects=True)
    base = f"{host_url.rstrip('/')}/api/v1/public/traces"
    headers = {"Authorization": f"Bearer {api_key}"}
    trace_ids = list(summary.per_trace)
    chosen = random.sample(trace_ids, min(sample, len(trace_ids)))
    deadline = time.monotonic() + timeout
    problems: list[str] = []
    for trace_hex in chosen:
        expected = summary.per_trace[trace_hex]
        stored: dict[str, Any] | None = None
        while True:
            response = client.get(f"{base}/{trace_hex}", headers=headers)
            if response.status_code == 200:
                data = response.json()
                stored = data.get("data", data)
                if len(stored.get("spans") or []) >= expected.spans:
                    break
            if time.monotonic() > deadline:
                break
            time.sleep(3)
        if stored is None:
            problems.append(f"{trace_hex}: not found in TraceRoot")
            continue
        spans = stored.get("spans") or []
        llm = [s for s in spans if s.get("span_kind") == "LLM"]
        got = (
            len(spans),
            sum(s.get("input_tokens") or 0 for s in llm),
            sum(s.get("output_tokens") or 0 for s in llm),
        )
        want = (expected.spans, expected.input_tokens, expected.output_tokens)
        if got != want:
            problems.append(f"{trace_hex}: expected spans/in/out {want}, TraceRoot has {got}")
    return problems
