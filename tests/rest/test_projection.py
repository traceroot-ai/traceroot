"""Unit tests for the trace field-group projection vocabulary (`rest.projection`).

Pure logic — no DB, no FastAPI. Covers the `fields` parsing, the alias/group
expansion, the canonical-column mapping the bulk reader uses, and the in-place
merge of bulk span I/O onto skeleton spans.
"""

import pytest

from rest.projection import (
    CORE,
    FULL,
    IO,
    METADATA,
    SKELETON,
    USAGE,
    InvalidFieldsError,
    hydrate_span_io,
    io_columns,
    merge_span_io,
    resolve_span_fields,
)


class _StubReader:
    """Records get_trace_spans_io calls and returns a canned map."""

    def __init__(self, span_io=None):
        self._span_io = span_io or {}
        self.calls = []

    def get_trace_spans_io(self, *, project_id, trace_id, columns):
        self.calls.append({"project_id": project_id, "trace_id": trace_id, "columns": columns})
        return self._span_io


class TestResolveSpanFields:
    def test_none_returns_default(self):
        assert resolve_span_fields(None, default=SKELETON) == SKELETON
        assert resolve_span_fields(None, default=FULL) == FULL

    def test_blank_returns_default(self):
        assert resolve_span_fields("   ", default=SKELETON) == SKELETON
        assert resolve_span_fields("", default=FULL) == FULL

    def test_skeleton_alias(self):
        assert resolve_span_fields("skeleton", default=FULL) == frozenset({CORE, USAGE})

    def test_full_alias(self):
        assert resolve_span_fields("full", default=SKELETON) == frozenset(
            {CORE, USAGE, IO, METADATA}
        )

    def test_io_group(self):
        # core is always implied even when only io is asked for.
        assert resolve_span_fields("io", default=SKELETON) == frozenset({CORE, IO})

    def test_explicit_group_list_equals_full(self):
        assert resolve_span_fields("core,usage,io,metadata", default=SKELETON) == FULL

    def test_core_always_implied(self):
        # Even asking for only metadata yields core (the span tree is never empty).
        assert resolve_span_fields("metadata", default=SKELETON) == frozenset({CORE, METADATA})

    def test_whitespace_and_case_insensitive(self):
        assert resolve_span_fields(" IO , Metadata ", default=SKELETON) == frozenset(
            {CORE, IO, METADATA}
        )

    def test_unknown_token_raises(self):
        with pytest.raises(InvalidFieldsError):
            resolve_span_fields("bogus", default=SKELETON)

    def test_mixed_valid_and_unknown_raises(self):
        with pytest.raises(InvalidFieldsError):
            resolve_span_fields("io,bogus", default=SKELETON)

    def test_error_message_names_the_bad_token(self):
        with pytest.raises(InvalidFieldsError) as exc:
            resolve_span_fields("scores", default=SKELETON)
        assert "scores" in str(exc.value)

    def test_fine_grained_io_input_not_yet_supported(self):
        # io.input / io.output are a deliberate follow-up; today they 400.
        with pytest.raises(InvalidFieldsError):
            resolve_span_fields("io.input", default=SKELETON)


class TestIoColumns:
    def test_skeleton_needs_no_columns(self):
        assert io_columns(SKELETON) == frozenset()

    def test_full_needs_all_three(self):
        assert io_columns(FULL) == frozenset({"input", "output", "metadata"})

    def test_io_maps_to_input_and_output(self):
        assert io_columns(frozenset({CORE, IO})) == frozenset({"input", "output"})

    def test_metadata_only_maps_to_metadata_column(self):
        assert io_columns(frozenset({CORE, METADATA})) == frozenset({"metadata"})


class TestMergeSpanIo:
    def _trace(self):
        return {
            "spans": [
                {"span_id": "s1", "input": None, "output": None, "metadata": None},
                {"span_id": "s2", "input": None, "output": None, "metadata": None},
            ]
        }

    def test_attaches_only_present_columns(self):
        trace = self._trace()
        # Bulk reader returned only the metadata column (fields=metadata projection).
        merge_span_io(trace, {"s1": {"metadata": "the-meta"}})
        assert trace["spans"][0]["metadata"] == "the-meta"
        # Untouched columns stay None.
        assert trace["spans"][0]["input"] is None
        assert trace["spans"][0]["output"] is None

    def test_attaches_all_columns(self):
        trace = self._trace()
        merge_span_io(
            trace,
            {"s1": {"input": "i", "output": "o", "metadata": "m"}},
        )
        assert trace["spans"][0] == {
            "span_id": "s1",
            "input": "i",
            "output": "o",
            "metadata": "m",
        }

    def test_span_missing_from_map_left_untouched(self):
        trace = self._trace()
        merge_span_io(trace, {"s1": {"input": "i", "output": "o"}})
        # s2 was absent from the bulk map — its I/O stays None, no KeyError.
        assert trace["spans"][1]["input"] is None
        assert trace["spans"][1]["output"] is None

    def test_empty_map_is_safe(self):
        trace = self._trace()
        merge_span_io(trace, {})
        assert all(s["input"] is None for s in trace["spans"])

    def test_no_spans_key_is_safe(self):
        merge_span_io({}, {"s1": {"input": "i"}})  # must not raise


class TestHydrateSpanIo:
    def _trace(self):
        return {"spans": [{"span_id": "s1", "input": None, "output": None, "metadata": None}]}

    def test_skeleton_skips_bulk_query(self):
        """The #1040 gate: a skeleton projection must NOT touch the bulk reader."""
        reader = _StubReader()
        trace = self._trace()
        hydrate_span_io(reader, trace, project_id="p", trace_id="t", groups=SKELETON)
        assert reader.calls == []
        assert trace["spans"][0]["input"] is None

    def test_full_fetches_and_merges(self):
        reader = _StubReader({"s1": {"input": "i", "output": "o", "metadata": "m"}})
        trace = self._trace()
        hydrate_span_io(reader, trace, project_id="p", trace_id="t", groups=FULL)
        assert len(reader.calls) == 1
        assert reader.calls[0]["columns"] == frozenset({"input", "output", "metadata"})
        assert reader.calls[0]["project_id"] == "p"
        assert reader.calls[0]["trace_id"] == "t"
        assert trace["spans"][0]["input"] == "i"
        assert trace["spans"][0]["metadata"] == "m"

    def test_io_only_requests_input_output_columns(self):
        reader = _StubReader({"s1": {"input": "i", "output": "o"}})
        trace = self._trace()
        hydrate_span_io(reader, trace, project_id="p", trace_id="t", groups=frozenset({CORE, IO}))
        assert reader.calls[0]["columns"] == frozenset({"input", "output"})
        assert trace["spans"][0]["input"] == "i"
        assert trace["spans"][0]["metadata"] is None
