"""Tags reach a span's `tags` field in every format the SDKs send (#1748).

The four wire formats, as the SDKs send them today:
- traceroot-py `@observe(tags=...)`: `traceroot.span.tags`, a string array
- traceroot-py `update_current_trace(tags=...)`: `traceroot.trace.tags`, a string array,
  on whichever span is current
- traceroot-ts `updateCurrentTrace({tags})`: `traceroot.span.tags`, a JSON-encoded string
- OpenInference `using_attributes(tags=...)` / `usingAttributes`: `tag.tags`, a string array
"""

import json

import pytest

from tests.fixtures.otel_payloads import make_otel_payload, make_span
from worker.otel_transform import transform_otel_to_clickhouse

TRACE = "ab" * 16


def _array(key: str, values: list[str]) -> dict:
    return {
        "key": key,
        "value": {"arrayValue": {"values": [{"stringValue": v} for v in values]}},
    }


def _string(key: str, value: str) -> dict:
    return {"key": key, "value": {"stringValue": value}}


def _transform(*spans: dict) -> list[dict]:
    _, out = transform_otel_to_clickhouse(make_otel_payload(list(spans)), project_id="proj-1")
    return out


@pytest.mark.parametrize(
    "attribute",
    [
        _array("traceroot.span.tags", ["prod", "v2"]),
        _array("traceroot.trace.tags", ["prod", "v2"]),
        _string("traceroot.span.tags", json.dumps(["prod", "v2"])),
        _array("tag.tags", ["prod", "v2"]),
    ],
    ids=["py_observe", "py_update_current_trace", "ts_update_current_trace", "openinference"],
)
def test_each_sdk_format_lands_in_span_tags(attribute):
    (span,) = _transform(make_span(TRACE, "11" * 8, name="root", attributes=[attribute]))

    assert span["tags"] == ["prod", "v2"]


def test_tags_from_every_key_on_one_span_are_merged_once():
    (span,) = _transform(
        make_span(
            TRACE,
            "11" * 8,
            name="root",
            attributes=[
                _array("traceroot.span.tags", ["prod"]),
                _array("traceroot.trace.tags", ["v2", "prod"]),
                _array("tag.tags", ["beta"]),
            ],
        )
    )

    assert span["tags"] == ["prod", "v2", "beta"]


def test_tag_set_on_a_nested_span_is_kept_on_that_span():
    """update_current_trace(tags=) inside a nested function stamps the child span."""
    root = make_span(TRACE, "11" * 8, name="root")
    child = make_span(
        TRACE,
        "22" * 8,
        name="child",
        parent_span_id_hex="11" * 8,
        attributes=[_array("traceroot.trace.tags", ["prod"])],
    )

    spans = {s["name"]: s for s in _transform(root, child)}

    assert spans["child"]["tags"] == ["prod"]
    assert spans["root"]["tags"] == []


def test_blank_and_padded_tags_are_cleaned():
    (span,) = _transform(
        make_span(
            TRACE,
            "11" * 8,
            name="root",
            attributes=[_array("traceroot.span.tags", ["  prod ", "", "   ", "prod"])],
        )
    )

    assert span["tags"] == ["prod"]


def test_a_span_without_tags_gets_an_empty_list():
    (span,) = _transform(make_span(TRACE, "11" * 8, name="root"))

    assert span["tags"] == []


def test_tag_keys_stay_out_of_the_metadata_blob():
    (span,) = _transform(
        make_span(
            TRACE,
            "11" * 8,
            name="root",
            attributes=[_array("tag.tags", ["prod"]), _string("custom.key", "x")],
        )
    )

    assert "tag.tags" not in json.loads(span["metadata"])
