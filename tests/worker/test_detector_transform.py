"""Tests for the detector-only multi-project transform wrapper.

The detector worker serves every project off one queue, so a single OTLP
batch can carry self-traces for several projects. The wrapper groups spans
by their per-span ``traceroot.project_id`` attribute and runs the shared
transform once per project group — the shared transform itself stays
single-project and untouched.
"""

import base64

import pytest

from worker.detector_transform import (
    UnattributableSpanError,
    transform_detector_traces,
)


def _b64_trace_id(byte: int) -> str:
    return base64.b64encode(bytes([byte] * 16)).decode()


def _b64_span_id(byte: int) -> str:
    return base64.b64encode(bytes([byte] * 8)).decode()


def _attr(key: str, value: str) -> dict:
    return {"key": key, "value": {"stringValue": value}}


def _span(trace_byte: int, span_byte: int, attributes: list[dict] | None = None) -> dict:
    return {
        "traceId": _b64_trace_id(trace_byte),
        "spanId": _b64_span_id(span_byte),
        "name": "detector-run",
        "startTimeUnixNano": "1700000000000000000",
        "endTimeUnixNano": "1700000001000000000",
        "attributes": attributes or [],
    }


def _payload(spans: list[dict]) -> dict:
    return {
        "resourceSpans": [
            {
                "resource": {"attributes": []},
                "scopeSpans": [
                    {"scope": {"name": "detector-worker"}, "spans": spans},
                ],
            }
        ]
    }


class TestProjectFanOut:
    def test_mixed_project_batch_fans_each_trace_to_its_own_project(self):
        payload = _payload(
            [
                _span(0x01, 0x11, [_attr("traceroot.project_id", "proj-a")]),
                _span(0x02, 0x22, [_attr("traceroot.project_id", "proj-b")]),
            ]
        )

        traces, spans = transform_detector_traces(payload)

        span_projects = {s["trace_id"]: s["project_id"] for s in spans}
        assert span_projects == {"01" * 16: "proj-a", "02" * 16: "proj-b"}
        trace_projects = {t["trace_id"]: t["project_id"] for t in traces}
        assert trace_projects == {"01" * 16: "proj-a", "02" * 16: "proj-b"}

    def test_span_without_attribute_uses_fallback_project(self):
        payload = _payload([_span(0x01, 0x11)])

        traces, spans = transform_detector_traces(payload, fallback_project_id="proj-fb")

        assert [s["project_id"] for s in spans] == ["proj-fb"]
        assert [t["project_id"] for t in traces] == ["proj-fb"]

    def test_attributed_and_fallback_spans_mix_in_one_batch(self):
        payload = _payload(
            [
                _span(0x01, 0x11, [_attr("traceroot.project_id", "proj-a")]),
                _span(0x02, 0x22),
            ]
        )

        _traces, spans = transform_detector_traces(payload, fallback_project_id="proj-fb")

        span_projects = {s["trace_id"]: s["project_id"] for s in spans}
        assert span_projects == {"01" * 16: "proj-a", "02" * 16: "proj-fb"}

    def test_span_with_no_attribute_and_no_fallback_is_rejected(self):
        payload = _payload(
            [
                _span(0x01, 0x11, [_attr("traceroot.project_id", "proj-a")]),
                _span(0x02, 0x22),
            ]
        )

        with pytest.raises(UnattributableSpanError):
            transform_detector_traces(payload)

    def test_non_string_attribute_value_is_rejected_not_crashed(self):
        # An array/map/number value must reject the batch like an absent
        # attribute — never crash grouping (unhashable key) and never fall
        # through to the fallback project.
        malformed = {
            "key": "traceroot.project_id",
            "value": {"arrayValue": {"values": [{"stringValue": "proj-a"}]}},
        }
        payload = _payload([_span(0x01, 0x11, [malformed])])

        with pytest.raises(UnattributableSpanError):
            transform_detector_traces(payload, fallback_project_id="proj-fallback")

    def test_numeric_attribute_value_is_rejected_even_with_fallback(self):
        malformed = {"key": "traceroot.project_id", "value": {"intValue": "42"}}
        payload = _payload([_span(0x01, 0x11, [malformed])])

        with pytest.raises(UnattributableSpanError):
            transform_detector_traces(payload, fallback_project_id="proj-fallback")

    def test_empty_payload_returns_empty_lists(self):
        traces, spans = transform_detector_traces({"resourceSpans": []})

        assert traces == []
        assert spans == []


class TestTransformPassThrough:
    def test_source_attribute_is_honored_not_coerced(self):
        """The wrapper must call the shared transform with trust_source=True so
        the worker's traceroot.source=detector marker survives."""
        payload = _payload(
            [
                _span(
                    0x01,
                    0x11,
                    [
                        _attr("traceroot.project_id", "proj-a"),
                        _attr("traceroot.source", "detector"),
                    ],
                )
            ]
        )

        _traces, spans = transform_detector_traces(payload)

        assert spans[0]["source"] == "detector"

    def test_routing_attribute_is_not_leaked_into_span_metadata(self):
        """traceroot.project_id is routing input consumed by the wrapper; it
        must not end up serialized into the span's metadata JSON."""
        payload = _payload([_span(0x01, 0x11, [_attr("traceroot.project_id", "proj-a")])])

        _traces, spans = transform_detector_traces(payload)

        assert "proj-a" not in spans[0].get("metadata", "")

    def test_multi_span_trace_stays_whole_in_one_group(self):
        """A root and child of the same trace (same project) come back as one
        trace record with both spans attributed to it."""
        child = _span(0x01, 0x22, [_attr("traceroot.project_id", "proj-a")])
        child["parentSpanId"] = _b64_span_id(0x11)
        payload = _payload(
            [
                _span(0x01, 0x11, [_attr("traceroot.project_id", "proj-a")]),
                child,
            ]
        )

        traces, spans = transform_detector_traces(payload)

        assert len(traces) == 1
        assert len(spans) == 2
        assert all(s["project_id"] == "proj-a" for s in spans)
