"""Public API timestamps are always serialized with an explicit UTC offset.

Postgres (``timestamp without time zone``) and ClickHouse (``DateTime64``) hand the
readers *naive* UTC datetimes. Serialized as-is they read ``2026-11-09T14:00:28.414000``,
which is not a valid RFC 3339 ``date-time`` and which most clients (JavaScript's
``Date``, Go's ``time.Parse``, ``jq``'s ``fromdate``) read as local time or reject. The
response models must emit ``...Z`` so a consumer never has to guess the zone.
"""

import json
from datetime import UTC, datetime, timedelta, timezone

import pytest

from rest.schemas.common import as_utc
from rest.schemas.detectors import RunItem
from rest.schemas.public import (
    AlertSummary,
    DashboardSummary,
    DashboardWidgetItem,
    DetectorDetail,
    DetectorItem,
    FindingSummary,
    SignalDetail,
    SignalSummary,
    WidgetDetail,
)

NAIVE = datetime(2026, 11, 9, 14, 0, 28, 414000)
AWARE_PLUS_2 = datetime(2026, 11, 9, 16, 0, 28, 414000, tzinfo=timezone(timedelta(hours=2)))
EXPECTED = "2026-11-09T14:00:28.414000Z"


def _dumped(model) -> dict:
    return json.loads(model.model_dump_json())


class TestAsUtc:
    def test_naive_is_read_as_utc(self):
        assert as_utc(NAIVE) == NAIVE.replace(tzinfo=UTC)
        assert as_utc(NAIVE).tzinfo is UTC

    def test_aware_is_converted_to_utc(self):
        result = as_utc(AWARE_PLUS_2)
        assert result.utcoffset() == timedelta(0)
        assert result == AWARE_PLUS_2  # same instant

    def test_microsecond_precision_is_kept(self):
        assert as_utc(NAIVE).microsecond == 414000


class TestResponseModelsEmitUtcOffset:
    def test_detector_item(self):
        item = DetectorItem(
            detector_id="d1", name="n", template="loop", enabled=True, created_at=NAIVE
        )
        assert _dumped(item)["created_at"] == EXPECTED

    def test_detector_detail_created_and_updated(self):
        detail = DetectorDetail(
            detector_id="d1",
            name="n",
            template="loop",
            enabled=True,
            created_at=NAIVE,
            prompt="p",
            output_schema=None,
            sample_rate=25,
            enable_rca=True,
            detection_model=None,
            detection_provider=None,
            detection_source=None,
            updated_at=NAIVE,
            trigger_conditions=None,
        )
        dumped = _dumped(detail)
        assert dumped["created_at"] == EXPECTED
        assert dumped["updated_at"] == EXPECTED

    def test_aware_input_is_normalized_to_utc(self):
        item = DetectorItem(
            detector_id="d1", name="n", template="loop", enabled=True, created_at=AWARE_PLUS_2
        )
        assert _dumped(item)["created_at"] == EXPECTED

    def test_detector_run_item(self):
        run = RunItem(
            run_id="r",
            detector_id="d",
            project_id="p",
            trace_id="t",
            finding_id=None,
            status="done",
            timestamp=NAIVE,
            summary="s",
        )
        assert _dumped(run)["timestamp"] == EXPECTED

    @pytest.mark.parametrize(
        "model",
        [
            FindingSummary,
            DetectorItem,
            DetectorDetail,
            DashboardSummary,
            DashboardWidgetItem,
            WidgetDetail,
            AlertSummary,
            SignalSummary,
            SignalDetail,
            RunItem,
        ],
    )
    def test_every_datetime_field_is_utc_typed(self, model):
        """No response model may declare a bare ``datetime`` (it would drift back to naive)."""
        for name, field in model.model_fields.items():
            annotation = repr(field.annotation)
            if "datetime" in annotation:
                # ``UtcDatetime`` keeps its validator in the field metadata; for
                # ``UtcDatetime | None`` it sits inside the Optional's annotation.
                assert "AfterValidator" in annotation or any(
                    type(m).__name__ == "AfterValidator" for m in field.metadata
                ), f"{model.__name__}.{name} is a bare datetime; use UtcDatetime"
