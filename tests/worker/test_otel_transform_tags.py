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

    assert span["tags"] == ["v2", "prod", "beta"]


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


@pytest.mark.parametrize(
    "attribute",
    [
        _string("traceroot.trace.tags", json.dumps(["prod", "v2"])),
        _string("tag.tags", json.dumps(["prod", "v2"])),
    ],
    ids=["trace_tags_json_string", "openinference_json_string"],
)
def test_json_string_arrays_are_read_on_every_key(attribute):
    """OTel attributes flatten to strings in some exporters, so every key takes both shapes."""
    (span,) = _transform(make_span(TRACE, "11" * 8, name="root", attributes=[attribute]))

    assert span["tags"] == ["prod", "v2"]


def test_a_plain_string_is_one_tag():
    (span,) = _transform(
        make_span(TRACE, "11" * 8, name="root", attributes=[_string("traceroot.span.tags", "prod")])
    )

    assert span["tags"] == ["prod"]


def test_non_string_elements_are_dropped():
    attribute = {
        "key": "traceroot.span.tags",
        "value": {
            "arrayValue": {
                "values": [{"stringValue": "prod"}, {"intValue": "7"}, {"boolValue": True}]
            }
        },
    }
    (span,) = _transform(make_span(TRACE, "11" * 8, name="root", attributes=[attribute]))

    assert span["tags"] == ["prod"]


def test_tag_count_is_capped():
    from worker.otel_transform import MAX_TAGS_PER_SPAN

    values = [f"t{i}" for i in range(MAX_TAGS_PER_SPAN + 5)]
    (span,) = _transform(
        make_span(TRACE, "11" * 8, name="root", attributes=[_array("traceroot.span.tags", values)])
    )

    assert span["tags"] == values[:MAX_TAGS_PER_SPAN]


def test_trace_tags_survive_a_span_at_the_cap():
    """update_current_trace(tags=) lands on whichever span is current. A span already at
    the cap must not lose the trace's tags, or the trace-level union would miss them."""
    from worker.otel_transform import MAX_TAGS_PER_SPAN

    span_tags = [f"s{i}" for i in range(MAX_TAGS_PER_SPAN + 10)]
    (span,) = _transform(
        make_span(
            TRACE,
            "11" * 8,
            name="root",
            attributes=[
                _array("traceroot.span.tags", span_tags),
                _array("traceroot.trace.tags", ["trace-level"]),
            ],
        )
    )

    assert "trace-level" in span["tags"]
    assert len(span["tags"]) == MAX_TAGS_PER_SPAN


def test_deeply_nested_json_tag_string_is_dropped_not_raised():
    """A string tag is parsed as JSON. Nesting deep enough to overflow the parser must
    drop that value, not abort the batch (Python 3.12 raises RecursionError near depth
    1000; 3.14 near 100000)."""
    depth = 200_000
    attribute = {
        "key": "traceroot.span.tags",
        "value": {"stringValue": "[" * depth + "]" * depth},
    }
    (span,) = _transform(make_span(TRACE, "11" * 8, name="root", attributes=[attribute]))

    assert span["tags"] == []


def test_overlong_tags_are_dropped_not_truncated():
    """A truncated tag is a value nobody sent, and a filter on the real value would miss it."""
    from worker.otel_transform import MAX_TAG_LENGTH

    (span,) = _transform(
        make_span(
            TRACE,
            "11" * 8,
            name="root",
            attributes=[_array("traceroot.span.tags", ["x" * (MAX_TAG_LENGTH + 1), "prod"])],
        )
    )

    assert span["tags"] == ["prod"]


def test_a_tag_at_the_length_cap_is_kept():
    from worker.otel_transform import MAX_TAG_LENGTH

    tag = "x" * MAX_TAG_LENGTH
    (span,) = _transform(
        make_span(TRACE, "11" * 8, name="root", attributes=[_array("tag.tags", [tag])])
    )

    assert span["tags"] == [tag]


def test_tags_survive_on_a_span_with_explicit_metadata():
    """The explicit-metadata branch builds the blob from other keys; tags must not ride on it."""
    (span,) = _transform(
        make_span(
            TRACE,
            "11" * 8,
            name="root",
            attributes=[
                _string("traceroot.span.metadata", json.dumps({"tenant": "acme"})),
                _array("traceroot.span.tags", ["prod"]),
            ],
        )
    )

    assert span["tags"] == ["prod"]
    assert json.loads(span["metadata"]) == {"tenant": "acme"}


def test_trace_tags_move_from_the_strip_list_to_the_tags_field():
    """`traceroot.trace.` was already stripped from metadata; it must now land in tags."""
    (span,) = _transform(
        make_span(
            TRACE,
            "11" * 8,
            name="root",
            attributes=[_array("traceroot.trace.tags", ["prod"]), _string("custom.key", "x")],
        )
    )

    assert span["tags"] == ["prod"]
    assert json.loads(span["metadata"]) == {"custom.key": "x"}


def test_dropped_tags_are_logged_but_a_repeat_is_not_a_drop(caplog):
    """A tag past the cap is lost data and is reported; a repeat of a kept tag is not."""
    from worker.otel_transform import MAX_TAGS_PER_SPAN

    values = [f"t{i}" for i in range(MAX_TAGS_PER_SPAN)]
    with caplog.at_level("WARNING", logger="worker.otel_transform"):
        (span,) = _transform(
            make_span(
                TRACE,
                "11" * 8,
                name="root",
                attributes=[_array("traceroot.span.tags", [*values, "t0"])],
            )
        )
    assert span["tags"] == values
    assert not [r for r in caplog.records if "span tag" in r.getMessage()]

    with caplog.at_level("WARNING", logger="worker.otel_transform"):
        _transform(
            make_span(
                TRACE,
                "11" * 8,
                name="root",
                attributes=[_array("traceroot.span.tags", [*values, "extra"])],
            )
        )
    assert [r for r in caplog.records if "Dropped 1 span tag" in r.getMessage()]
