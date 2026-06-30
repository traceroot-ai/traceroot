"""Schema contract tests for the public detector findings API."""

from datetime import datetime

from rest.schemas.common import PaginationMeta
from rest.schemas.public import (
    DetectorResultItem,
    FindingDetail,
    FindingSummary,
    PublicFindingListResponse,
    RCAResult,
)


def test_detector_result_item_fields_are_snake_case():
    item = DetectorResultItem(
        detector_id="d1",
        detector_name="hallucination",
        template="hallucination",
        summary="unsupported claims",
        identified=True,
        data={"k": "v"},
    )
    assert item.model_dump() == {
        "detector_id": "d1",
        "detector_name": "hallucination",
        "template": "hallucination",
        "summary": "unsupported claims",
        "identified": True,
        "data": {"k": "v"},
    }


def test_detector_result_item_allows_null_template_and_data():
    item = DetectorResultItem(
        detector_id="d1",
        detector_name="hallucination",
        template=None,
        summary="s",
        identified=True,
        data=None,
    )
    assert item.template is None
    assert item.data is None


def test_rca_result_result_is_optional():
    assert RCAResult(status="pending", result=None).result is None
    assert RCAResult(status="done", result="root cause").result == "root cause"


def test_finding_detail_allows_null_rca():
    detail = FindingDetail(
        finding_id="f1",
        project_id="p1",
        trace_id="t1",
        summary="x",
        timestamp=datetime(2026, 6, 29, 10, 42),
        detectors=["hallucination"],
        results=[
            DetectorResultItem(
                detector_id="d1",
                detector_name="hallucination",
                template="hallucination",
                summary="s",
                identified=True,
                data=None,
            )
        ],
        rca=None,
    )
    assert detail.rca is None
    assert detail.detectors == ["hallucination"]
    assert detail.results[0].detector_id == "d1"


def test_public_finding_list_response_wraps_summaries_with_pagination():
    resp = PublicFindingListResponse(
        data=[
            FindingSummary(
                finding_id="f1",
                project_id="p1",
                trace_id="t1",
                summary="x",
                timestamp=datetime(2026, 6, 29),
                detectors=["failure", "logic"],
            )
        ],
        meta=PaginationMeta(page=0, limit=50, total=1),
    )
    assert resp.meta.page == 0
    assert resp.data[0].detectors == ["failure", "logic"]
