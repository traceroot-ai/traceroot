"""Root detection for spans whose parent context is REMOTE (W3C traceparent).

A service that is called by another traced service receives the caller's parent
span id, so its entry span never looks parentless — yet it is the trace's locally
observable root: without OTLP ``flags`` the trace keeps a placeholder row
(a child's name, no input/output or metadata) and detectors never run, because
every root consumer keys off an absent ``parent_span_id`` (issue #2710).

The OTLP signal for exactly this is ``Span.flags`` bit pair 0x300
(``SPAN_FLAGS_CONTEXT_HAS_IS_REMOTE_MASK | SPAN_FLAGS_CONTEXT_IS_REMOTE_MASK``):
opentelemetry-python exports ``flags=0x300`` on such an entry span and ``0x100``
on a local root. The fix treats a flagged entry span as parentless — the same
root seat a true local root occupies — while a true local root present in the
same batch keeps the stronger claim either way (its row must survive a second
service's entry span that also carries ``0x300``). Emitters that send no flags at
all (OTel JS) keep today's behavior by design: this file pins that no heuristic
on their part quietly infers a root.
"""

import json

import pytest

from tests.fixtures.otel_payloads import make_attr, make_otel_payload, make_span
from worker.otel_transform import (
    PARENT_IS_REMOTE_KEY,
    _parent_context_is_remote,
    transform_otel_to_clickhouse,
)

TRACE_HEX = "aa" * 16
ENTRY_SPAN_HEX = "bb" * 8
REMOTE_PARENT_HEX = "cc" * 8
CHILD_SPAN_HEX = "dd" * 8
TRUE_ROOT_HEX = "ee" * 8

_PROJECT = "proj-1"


def entry_span_attributes(name: str = "handle_request") -> list[dict]:
    """The traceroot attribute set the repro stamps on a called service's entry span."""
    return [
        make_attr("traceroot.span.type", "AGENT"),
        make_attr("traceroot.span.input", "user question"),
        make_attr("traceroot.span.output", "final answer"),
        make_attr("traceroot.trace.user_id", "u-42"),
        make_attr("traceroot.trace.session_id", "sess-1"),
        make_attr("traceroot.trace.metadata", json.dumps({"plan": "pro"})),
        make_attr("traceroot.git.ref", "main"),
        make_attr("traceroot.git.repo", "acme/app"),
    ]


def _remote_entry_payload(span_id_hex: str, flags: int | None) -> dict:
    span = make_span(
        TRACE_HEX,
        span_id_hex,
        name="handle_request",
        parent_span_id_hex=REMOTE_PARENT_HEX,
        attributes=entry_span_attributes(),
    )
    if flags is not None:
        span["flags"] = flags
    return make_otel_payload([span])


# -- flags decoder ------------------------------------------------------------


class TestParentContextIsRemote:
    @pytest.mark.parametrize("flags", [0x300, 768, "768"])
    def test_both_remote_bits_set_means_remote(self, flags):
        assert _parent_context_is_remote(flags) is True

    @pytest.mark.parametrize("flags", [0x200, 0x100, 0, 512, "512", None, 3.0, True])
    def test_missing_or_partial_flags_do_not_mean_remote(self, flags):
        # 0x100 alone is the local-root marker opentelemetry-python exports;
        # IS_REMOTE (0x200) without HAS_IS_REMOTE is not emitted by the SDKs.
        assert _parent_context_is_remote(flags) is False


# -- transform: flagged entry spans take the root seat -----------------------


class TestRemoteParentEntrySpan:
    def test_entry_span_gets_the_full_trace_row(self):
        traces, spans = transform_otel_to_clickhouse(
            _remote_entry_payload(ENTRY_SPAN_HEX, flags=768), _PROJECT
        )

        assert len(traces) == 1
        row = traces[0]
        # The reported repro's expected row, name through metadata.
        assert row["name"] == "handle_request"
        assert row["user_id"] == "u-42"
        assert row["session_id"] == "sess-1"
        assert row["input"] == "user question"
        assert row["output"] == "final answer"
        assert json.loads(row["metadata"]) == {"plan": "pro"}
        assert row["git_ref"] == "main"
        assert row["git_repo"] == "acme/app"

        (entry,) = spans
        # Normalized to the locally observable root the rest of the pipeline keys on.
        assert entry["parent_span_id"] is None
        assert entry["name"] == "handle_request"
        # Ingest reads this sentinel; the ClickHouse writer does not (named columns).
        assert entry[PARENT_IS_REMOTE_KEY] is True

    def test_entry_span_id_stays_a_hex_id(self):
        traces, spans = transform_otel_to_clickhouse(
            _remote_entry_payload(ENTRY_SPAN_HEX, flags=768), _PROJECT
        )
        # The wire span id round-trips; only the remote parent id is normalized.
        assert spans[0]["span_id"] == ENTRY_SPAN_HEX
        (row,) = traces
        assert row["trace_id"] == TRACE_HEX

    def test_children_link_to_the_entry_span(self):
        payload = make_otel_payload(
            [
                make_span(
                    TRACE_HEX,
                    ENTRY_SPAN_HEX,
                    name="handle_request",
                    parent_span_id_hex=REMOTE_PARENT_HEX,
                    attributes=entry_span_attributes(),
                    flags=768,
                ),
                make_span(
                    TRACE_HEX,
                    CHILD_SPAN_HEX,
                    name="llm-call",
                    parent_span_id_hex=ENTRY_SPAN_HEX,
                    attributes=[make_attr("traceroot.span.type", "LLM")],
                ),
            ]
        )

        traces, spans = transform_otel_to_clickhouse(payload, _PROJECT)

        by_id = {s["span_id"]: s for s in spans}
        assert by_id[CHILD_SPAN_HEX]["parent_span_id"] == ENTRY_SPAN_HEX
        assert by_id[ENTRY_SPAN_HEX]["parent_span_id"] is None
        # The entry's upgrade fires even though the child is processed first.
        assert traces[0]["name"] == "handle_request"
        assert traces[0]["input"] == "user question"

    def test_a_child_packet_with_the_local_root_marker_is_not_a_root(self):
        """flags=0x100 is a local-root marker; a parented span must stay a child."""
        payload = make_otel_payload(
            [
                make_span(
                    TRACE_HEX,
                    CHILD_SPAN_HEX,
                    name="llm-call",
                    parent_span_id_hex=REMOTE_PARENT_HEX,
                    attributes=entry_span_attributes(),
                    flags=256,
                )
            ]
        )

        traces, spans = transform_otel_to_clickhouse(payload, _PROJECT)

        (row,) = traces
        # A placeholder: child name, no input/output/metadata, no upgrade.
        assert row["name"] == "llm-call"
        assert row.get("input") is None
        assert row.get("output") is None
        assert row.get("metadata") is None
        assert row["user_id"] == "u-42"  # child-sourced in the eager record
        (child,) = spans
        # The dangling remote parent id survives on the span row.
        assert child["parent_span_id"] == REMOTE_PARENT_HEX
        assert PARENT_IS_REMOTE_KEY not in child

    @pytest.mark.parametrize("flags", [None, 0])
    def test_no_remote_flags_keeps_today_s_placeholder_behavior(self, flags):
        """No flags set (OTel JS): a parented span is never inferred into a root."""
        payload = _remote_entry_payload(ENTRY_SPAN_HEX, flags)

        traces, spans = transform_otel_to_clickhouse(payload, _PROJECT)

        (row,) = traces
        assert row["name"] == "handle_request"  # falls back to the span name it carries
        assert row.get("input") is None
        (entry,) = spans
        assert entry["parent_span_id"] == REMOTE_PARENT_HEX

    def test_null_padded_parent_with_remote_flags_is_still_a_true_root(self):
        """An all-zero parent id decodes to absent: the span is a local root regardless."""
        span = make_span(
            TRACE_HEX,
            ENTRY_SPAN_HEX,
            name="handle_request",
            attributes=entry_span_attributes(),
            flags=768,
        )
        span["parentSpanId"] = "AAAAAAAAAAA="  # 8 zero bytes

        traces, spans = transform_otel_to_clickhouse(make_otel_payload([span]), _PROJECT)

        (entry,) = spans
        assert entry["parent_span_id"] is None
        assert PARENT_IS_REMOTE_KEY not in entry
        assert traces[0]["input"] == "user question"


# -- a true local root outranks a remote-parent entry in the same batch -------


class TestTrueRootPrecedence:
    def test_true_root_wins_when_processed_after_the_entry(self):
        """Both claimants in one batch, entry first: the true root's re-claim must
        overwrite the row's identity (name/start/user) even though the entry already
        upgraded the row. The entry's input lives on only because the true root
        carries none of its own (upstream's keep-if-later-root-lacks-it rule)."""
        payload = make_otel_payload(
            [
                make_span(
                    TRACE_HEX,
                    ENTRY_SPAN_HEX,
                    name="handle_request",
                    parent_span_id_hex=REMOTE_PARENT_HEX,
                    attributes=entry_span_attributes(),
                    flags=768,
                ),
                make_span(TRACE_HEX, TRUE_ROOT_HEX, name="agent-run"),
            ]
        )

        traces, _spans = transform_otel_to_clickhouse(payload, _PROJECT)

        (row,) = traces
        assert row["name"] == "agent-run"  # true root's identity, not the entry's
        assert row["input"] == "user question"  # entry-enriched; true root had no input
        assert row["user_id"] == "u-42"  # entry's trace.user survives the re-claim

    def test_true_root_wins_when_processed_before_the_entry(self):
        """Both claimants in one batch, true root first: the flagged entry must not
        replant the row's identity over the true root's. It ranks below the true
        root for everything; only its name (here: none survives, the true root's
        stays) and child-allowed fills apply. Trace input/output/user set from the
        entry stay unset in this order — the same upstream rule that governs any
        child processed after its trace's root upgrade. Cross-BATCH order (the
        realistic path) is guarded at the ingest layer: an entry-only batch can
        fill an absent root but can never replace a true root's row."""
        payload = make_otel_payload(
            [
                make_span(TRACE_HEX, TRUE_ROOT_HEX, name="agent-run"),
                make_span(
                    TRACE_HEX,
                    ENTRY_SPAN_HEX,
                    name="handle_request",
                    parent_span_id_hex=REMOTE_PARENT_HEX,
                    attributes=entry_span_attributes(),
                    flags=768,
                ),
            ]
        )

        traces, _spans = transform_otel_to_clickhouse(payload, _PROJECT)

        (row,) = traces
        assert row["name"] == "agent-run"
        # The entry must not replant the trace row's identity over the true root's.
        assert "input" not in row

    def test_last_remote_entry_finalizes_when_no_true_root_exists(self):
        """Two services' entries of one rootless trace: the later-processed one wins."""
        second_entry_hex = "01" * 8
        payload = make_otel_payload(
            [
                make_span(
                    TRACE_HEX,
                    ENTRY_SPAN_HEX,
                    name="handle_request",
                    parent_span_id_hex=REMOTE_PARENT_HEX,
                    attributes=entry_span_attributes(),
                    flags=768,
                ),
                make_span(
                    TRACE_HEX,
                    second_entry_hex,
                    name="enqueue_job",
                    parent_span_id_hex="02" * 8,
                    flags=768,
                ),
            ]
        )

        traces, spans = transform_otel_to_clickhouse(payload, _PROJECT)

        (row,) = traces
        assert row["name"] == "enqueue_job"
        by_id = {s["span_id"]: s for s in spans}
        assert by_id[ENTRY_SPAN_HEX]["parent_span_id"] is None
        assert by_id[second_entry_hex]["parent_span_id"] is None

    def test_trace_isolation_does_not_leak_remote_root_claims(self):
        """One trace's true root must not disqualify another trace's entry span."""
        other_hex = "bb" * 16
        payload = make_otel_payload(
            [
                make_span(
                    TRACE_HEX,
                    ENTRY_SPAN_HEX,
                    name="handle_request",
                    parent_span_id_hex=REMOTE_PARENT_HEX,
                    attributes=entry_span_attributes(),
                    flags=768,
                ),
                make_span(other_hex, TRUE_ROOT_HEX, name="other-root"),
            ]
        )

        traces, _ = transform_otel_to_clickhouse(payload, _PROJECT)

        rows = {row["trace_id"]: row for row in traces}
        assert rows[TRACE_HEX]["name"] == "handle_request"
        assert rows[TRACE_HEX]["input"] == "user question"
        assert rows[other_hex]["name"] == "other-root"
