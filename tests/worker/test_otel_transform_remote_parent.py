"""Root detection for spans whose parent context is REMOTE (W3C traceparent).

A service that is called by another traced service receives the caller's parent
span id, so its entry span is not an ordinary local root — yet it is the trace's
locally observable provisional identity: without OTLP ``flags`` the trace keeps a
placeholder row
(a child's name, no input/output or metadata) and detectors never run, because
every root consumer keys off an absent ``parent_span_id`` (issue #2710).

The OTLP signal for exactly this is ``Span.flags`` bit pair 0x300
(``SPAN_FLAGS_CONTEXT_HAS_IS_REMOTE_MASK | SPAN_FLAGS_CONTEXT_IS_REMOTE_MASK``):
opentelemetry-python exports ``flags=0x300`` on such an entry span and ``0x100``
on a local root. The fix preserves the original parent span id and tracks
remote-root eligibility separately, while a true local root present in the
same batch keeps the stronger claim either way (its row must survive a second
service's entry span that also carries ``0x300``). Payloads without the
TraceRoot SDK marker or an explicit fallback signal keep today's behavior:
missing flags alone never infers a root.
"""

import json

import pytest

from shared.span_attributes import SPAN_IDS_PATH
from tests.fixtures.otel_payloads import make_attr, make_otel_payload, make_span
from worker.otel_transform import (
    PARENT_IS_REMOTE_KEY,
    _parent_context_is_remote,
    nanos_to_datetime,
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


def _span_without_start_time(span: dict) -> dict:
    """Make a span invalid in the way the transformer's second skip path models:
    a missing startTimeUnixNano discards it after the id checks."""
    del span["startTimeUnixNano"]
    return span


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

    def test_non_positive_start_time_is_rejected_by_transform(self):
        span = make_span(TRACE_HEX, ENTRY_SPAN_HEX, name="invalid")
        span["startTimeUnixNano"] = "0"

        traces, spans = transform_otel_to_clickhouse(make_otel_payload([span]), _PROJECT)

        assert traces == []
        assert spans == []


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
        # Root eligibility is separate from the persisted topology.
        assert entry["parent_span_id"] == REMOTE_PARENT_HEX
        assert entry["name"] == "handle_request"
        # Ingest reads this sentinel; the ClickHouse writer does not (named columns).
        assert entry[PARENT_IS_REMOTE_KEY] is True

    def test_entry_span_id_stays_a_hex_id(self):
        traces, spans = transform_otel_to_clickhouse(
            _remote_entry_payload(ENTRY_SPAN_HEX, flags=768), _PROJECT
        )
        # Both wire span ids round-trip; eligibility is tracked separately.
        assert spans[0]["span_id"] == ENTRY_SPAN_HEX
        (row,) = traces
        assert row["trace_id"] == TRACE_HEX

    def test_children_link_to_the_entry_span(self):
        payload = make_otel_payload(
            [
                # The child is exported FIRST, so the transformer sees it before
                # the entry: it builds the eager placeholder trace row ("llm-call",
                # no input), which the entry's claim must then upgrade.
                make_span(
                    TRACE_HEX,
                    CHILD_SPAN_HEX,
                    name="llm-call",
                    parent_span_id_hex=ENTRY_SPAN_HEX,
                    attributes=[make_attr("traceroot.span.type", "LLM")],
                ),
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

        traces, spans = transform_otel_to_clickhouse(payload, _PROJECT)

        by_id = {s["span_id"]: s for s in spans}
        assert by_id[CHILD_SPAN_HEX]["parent_span_id"] == ENTRY_SPAN_HEX
        assert by_id[ENTRY_SPAN_HEX]["parent_span_id"] == REMOTE_PARENT_HEX
        # The entry's upgrade fires even though the child was processed first and
        # already created the shallow trace row; the child stays a child and never
        # takes the root seat.
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
        """No flags and no SDK fallback marker: a parented span is not inferred into a root."""
        payload = _remote_entry_payload(ENTRY_SPAN_HEX, flags)

        traces, spans = transform_otel_to_clickhouse(payload, _PROJECT)

        (row,) = traces
        assert row["name"] == "handle_request"  # falls back to the span name it carries
        assert row.get("input") is None
        (entry,) = spans
        assert entry["parent_span_id"] == REMOTE_PARENT_HEX

    def test_typescript_empty_ids_path_is_a_guarded_remote_entry_fallback(self):
        payload = make_otel_payload(
            [
                make_span(
                    TRACE_HEX,
                    ENTRY_SPAN_HEX,
                    name="handle_request",
                    parent_span_id_hex=REMOTE_PARENT_HEX,
                    attributes=[
                        make_attr("traceroot.sdk.name", "traceroot-ts"),
                        {
                            "key": SPAN_IDS_PATH,
                            "value": {"arrayValue": {"values": []}},
                        },
                        make_attr("traceroot.span.input", "ts input"),
                    ],
                )
            ]
        )

        traces, spans = transform_otel_to_clickhouse(payload, _PROJECT)

        assert traces[0]["root_kind"] == 1
        assert traces[0]["input"] == "ts input"
        assert spans[0]["parent_span_id"] == REMOTE_PARENT_HEX
        assert spans[0][PARENT_IS_REMOTE_KEY] is True

    def test_typescript_nonempty_ids_path_is_an_ordinary_child(self):
        payload = make_otel_payload(
            [
                make_span(
                    TRACE_HEX,
                    ENTRY_SPAN_HEX,
                    name="child",
                    parent_span_id_hex=REMOTE_PARENT_HEX,
                    attributes=[
                        make_attr("traceroot.sdk.name", "traceroot-ts"),
                        {
                            "key": SPAN_IDS_PATH,
                            "value": {
                                "arrayValue": {"values": [{"stringValue": REMOTE_PARENT_HEX}]}
                            },
                        },
                    ],
                )
            ]
        )

        _traces, spans = transform_otel_to_clickhouse(payload, _PROJECT)

        assert PARENT_IS_REMOTE_KEY not in spans[0]

    def test_typescript_fallback_does_not_override_explicit_local_flags(self):
        payload = make_otel_payload(
            [
                make_span(
                    TRACE_HEX,
                    ENTRY_SPAN_HEX,
                    name="child",
                    parent_span_id_hex=REMOTE_PARENT_HEX,
                    flags=256,
                    attributes=[
                        make_attr("traceroot.sdk.name", "traceroot-ts"),
                        {"key": SPAN_IDS_PATH, "value": {"arrayValue": {"values": []}}},
                    ],
                )
            ]
        )

        _traces, spans = transform_otel_to_clickhouse(payload, _PROJECT)

        assert PARENT_IS_REMOTE_KEY not in spans[0]

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
        upgraded the row. The entry's input must not leak into the winning root row."""
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
        assert "input" not in row
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

    def test_earliest_remote_entry_claims_and_later_ones_cannot_overwrite(self):
        """Two services' entries of one rootless trace in one batch: the earlier
        span start claims the root seat, and a later entry — an additional
        view of the same trace — must not replace the established name, input,
        output, or start time. This matches the cross-batch ingest rule, where
        an entry-only batch can fill an absent row but never replants an
        existing one. Both spans preserve their original remote parent ids."""
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
                    start_nanos=1705320000000000000,
                ),
                make_span(
                    TRACE_HEX,
                    second_entry_hex,
                    name="enqueue_job",
                    parent_span_id_hex="02" * 8,
                    flags=768,
                    start_nanos=1705320009000000000,
                    attributes=[
                        make_attr("traceroot.span.input", "second input"),
                        make_attr("traceroot.span.output", "second output"),
                    ],
                ),
            ]
        )

        traces, spans = transform_otel_to_clickhouse(payload, _PROJECT)

        (row,) = traces
        # The first entry's identity survives; every distinct value the later
        # entry carries (name, input, output, start time) must not overwrite it.
        assert row["name"] == "handle_request"
        assert row["input"] == "user question"
        assert row["output"] == "final answer"
        assert row["trace_start_time"] == nanos_to_datetime(1705320000000000000)
        by_id = {s["span_id"]: s for s in spans}
        assert by_id[ENTRY_SPAN_HEX]["parent_span_id"] == REMOTE_PARENT_HEX
        assert by_id[ENTRY_SPAN_HEX][PARENT_IS_REMOTE_KEY] is True
        assert by_id[second_entry_hex]["parent_span_id"] == "02" * 8
        assert by_id[second_entry_hex][PARENT_IS_REMOTE_KEY] is True

    def test_remote_entry_followed_by_children_keeps_the_claimed_metadata(self):
        """Children exported after the entry never take the root seat, so their
        names/inputs stay off the trace row even when they arrive last."""
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
                    attributes=[
                        make_attr("traceroot.span.type", "LLM"),
                        make_attr("traceroot.span.input", "child input"),
                    ],
                ),
            ]
        )

        traces, _spans = transform_otel_to_clickhouse(payload, _PROJECT)

        (row,) = traces
        assert row["name"] == "handle_request"
        assert row["input"] == "user question"

    def test_claims_stay_isolated_across_traces_in_one_batch(self):
        """Two traces, each with a true root and its own remote entry, in one
        batch: every trace resolves to its true root regardless of position."""
        other_trace_hex = "11" * 16
        other_entry_hex = "12" * 8
        other_true_root_hex = "13" * 8
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
                make_span(
                    other_trace_hex,
                    other_entry_hex,
                    name="other-entry",
                    parent_span_id_hex="14" * 8,
                    attributes=[make_attr("traceroot.span.input", "other input")],
                    flags=768,
                ),
                make_span(other_trace_hex, other_true_root_hex, name="other-root"),
            ]
        )

        traces, _spans = transform_otel_to_clickhouse(payload, _PROJECT)

        rows = {row["trace_id"]: row for row in traces}
        assert rows[TRACE_HEX]["name"] == "agent-run"
        assert rows[other_trace_hex]["name"] == "other-root"

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


# -- a discarded root-shaped span must not reserve the root seat -------------


class TestInvalidRootDoesNotReserveTheSeat:
    """Root-claim bookkeeping registers only spans that survive validation, so a
    true-root-shaped span discarded by a skip path (missing id, missing start
    time) can never block a later valid remote-parent entry from establishing
    the trace — the trace must not stay a placeholder."""

    def test_true_root_missing_start_time_does_not_block_a_valid_remote_entry(self):
        payload = make_otel_payload(
            [
                # Root-shaped but invalid: no startTimeUnixNano, so the loop
                # discards it after the id checks.
                _span_without_start_time(make_span(TRACE_HEX, TRUE_ROOT_HEX, name="agent-run")),
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

        traces, spans = transform_otel_to_clickhouse(payload, _PROJECT)

        (row,) = traces
        assert row["name"] == "handle_request"
        assert row["input"] == "user question"
        assert row["output"] == "final answer"
        assert row["user_id"] == "u-42"
        # Only the valid entry produced a span row.
        assert [s["span_id"] for s in spans] == [ENTRY_SPAN_HEX]

    def test_root_with_missing_span_id_does_not_block_a_valid_remote_entry(self):
        # spanId decodes to None (empty bytes): the earliest skip path drops it,
        # and it must leave no claim behind either.
        payload = make_otel_payload(
            [
                make_span(TRACE_HEX, "", name="agent-run"),
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

        traces, spans = transform_otel_to_clickhouse(payload, _PROJECT)

        (row,) = traces
        assert row["name"] == "handle_request"
        assert row["input"] == "user question"
        assert [s["span_id"] for s in spans] == [ENTRY_SPAN_HEX]

    def test_discarded_root_does_not_leak_across_traces(self):
        """An invalid root of one trace must not contaminate another trace's
        claims: trace A falls back to its valid remote entry, trace B keeps its
        own true root."""
        other_trace_hex = "11" * 16
        payload = make_otel_payload(
            [
                _span_without_start_time(make_span(TRACE_HEX, TRUE_ROOT_HEX, name="agent-run")),
                make_span(
                    TRACE_HEX,
                    ENTRY_SPAN_HEX,
                    name="handle_request",
                    parent_span_id_hex=REMOTE_PARENT_HEX,
                    attributes=entry_span_attributes(),
                    flags=768,
                ),
                make_span(other_trace_hex, "12" * 8, name="other-root"),
            ]
        )

        traces, _spans = transform_otel_to_clickhouse(payload, _PROJECT)

        rows = {row["trace_id"]: row for row in traces}
        assert rows[TRACE_HEX]["name"] == "handle_request"
        assert rows[TRACE_HEX]["input"] == "user question"
        assert rows[other_trace_hex]["name"] == "other-root"

    def test_a_valid_true_root_still_outranks_the_remote_entry(self):
        """The invalid-root relaxation must not weaken true-root precedence: a
        valid true root claiming after the entry still overwrites the row."""
        payload = make_otel_payload(
            [
                _span_without_start_time(make_span(TRACE_HEX, "01" * 8, name="discarded-root")),
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
        assert row["name"] == "agent-run"
        assert row["user_id"] == "u-42"  # entry's trace.user survives the re-claim
