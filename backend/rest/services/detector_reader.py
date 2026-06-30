"""Service for reading detector findings from ClickHouse + Postgres.

Findings live in ClickHouse (`detector_findings`, a `ReplacingMergeTree` keyed by
`timestamp`); the free-text RCA (`detector_rcas`) and the detector catalog
(`detectors`, used to resolve the `--detector` selector and look up templates)
live in Postgres. All reads are scoped to the caller's `project_id`.

Postgres is best-effort for enrichment: an RCA or template lookup that is missing
or fails degrades to ``None`` and never prevents a finding from being returned. A
ClickHouse failure on the finding read itself propagates (the router maps it to a
controlled 500).
"""

import json
import logging
from datetime import datetime
from typing import Any

import psycopg2

from db.clickhouse import get_clickhouse_client
from rest.schemas.public import (
    DetectorResultItem,
    FindingDetail,
    FindingSummary,
    RCAResult,
)
from rest.sql_utils import to_utc_naive
from shared.config import settings

logger = logging.getLogger(__name__)


class DetectorReaderService:
    """Read detector findings (ClickHouse) plus RCA/templates (Postgres)."""

    def __init__(self):
        self._client = get_clickhouse_client()

    # ------------------------------------------------------------------ #
    # Postgres boundary (single read-only seam; mocked in unit tests)
    # ------------------------------------------------------------------ #
    def _pg_rows(self, sql: str, params: tuple) -> list[tuple]:
        """Run a read-only Postgres query and return all rows."""
        conn = psycopg2.connect(settings.database_url)
        try:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                return list(cur.fetchall())
        finally:
            conn.close()

    # ------------------------------------------------------------------ #
    # payload helpers
    # ------------------------------------------------------------------ #
    @staticmethod
    def _parse_payload(payload: str) -> list[dict]:
        """Parse the stored finding payload JSON array; [] on any malformed input."""
        try:
            data = json.loads(payload) if payload else []
        except (ValueError, TypeError):
            return []
        return data if isinstance(data, list) else []

    def _detector_labels(self, payload: str) -> list[str]:
        """Display labels (`detectorName`) for the DETECTORS column."""
        return [
            str(item["detectorName"])
            for item in self._parse_payload(payload)
            if isinstance(item, dict) and item.get("detectorName") is not None
        ]

    # ------------------------------------------------------------------ #
    # list
    # ------------------------------------------------------------------ #
    def list_findings(
        self,
        project_id: str,
        limit: int,
        start_after: datetime | None,
        end_before: datetime | None,
        detector: str | None,
        trace_id: str | None,
    ) -> tuple[list[FindingSummary], int]:
        """List findings for a project, newest first, with the total match count."""
        conditions = ["project_id = {project_id:String}"]
        params: dict[str, Any] = {"project_id": project_id, "limit": limit}

        if start_after is not None:
            conditions.append("timestamp >= {start_after:DateTime64(3)}")
            params["start_after"] = to_utc_naive(start_after)
        if end_before is not None:
            conditions.append("timestamp < {end_before:DateTime64(3)}")
            params["end_before"] = to_utc_naive(end_before)
        if trace_id is not None:
            conditions.append("trace_id = {trace_id:String}")
            params["trace_id"] = trace_id
        if detector is not None:
            # Backend-owned resolution: match a finding whose payload contains any
            # of the resolved detector names. The raw token is always included, so
            # an unresolved token simply matches nothing (empty list, not an error).
            params["detector_names"] = self._resolve_detector_names(project_id, detector)
            conditions.append(
                "arrayExists("
                "x -> JSONExtractString(x, 'detectorName') IN {detector_names:Array(String)}, "
                "JSONExtractArrayRaw(payload))"
            )

        where = " AND ".join(conditions)

        count_query = f"""
            SELECT count(DISTINCT finding_id)
            FROM detector_findings
            WHERE {where}
        """
        count_result = self._client.query(count_query, parameters=params)
        total = count_result.result_rows[0][0] if count_result.result_rows else 0

        # Dedup the ReplacingMergeTree rows (latest per finding_id) BEFORE limiting.
        list_query = f"""
            SELECT finding_id, project_id, trace_id, summary, payload, timestamp
            FROM (
                SELECT finding_id, project_id, trace_id, summary, payload, timestamp
                FROM detector_findings
                WHERE {where}
                ORDER BY timestamp DESC
                LIMIT 1 BY finding_id
            )
            ORDER BY timestamp DESC
            LIMIT {{limit:UInt32}}
        """
        result = self._client.query(list_query, parameters=params)
        items = [
            FindingSummary(
                finding_id=row[0],
                project_id=row[1],
                trace_id=row[2],
                summary=row[3],
                timestamp=row[5],
                detectors=self._detector_labels(row[4]),
            )
            for row in result.result_rows
        ]
        return items, total

    def _resolve_detector_names(self, project_id: str, token: str) -> list[str]:
        """Resolve a `--detector` token to the set of matching detector names.

        Always includes the raw token (so a name typed directly still matches the
        payload), plus any project detector whose id, name, or template equals the
        token. A Postgres failure degrades to just the raw token.
        """
        names = {token}
        try:
            rows = self._pg_rows(
                "SELECT name FROM detectors "
                "WHERE project_id = %s AND (id = %s OR name = %s OR template = %s)",
                (project_id, token, token, token),
            )
            names.update(r[0] for r in rows if r and r[0] is not None)
        except Exception:
            logger.warning("detector resolution failed; using raw token", exc_info=True)
        return list(names)

    # ------------------------------------------------------------------ #
    # detail
    # ------------------------------------------------------------------ #
    def get_finding(self, project_id: str, finding_id: str) -> FindingDetail | None:
        row = self._fetch_finding(
            "finding_id = {finding_id:String}",
            {"project_id": project_id, "finding_id": finding_id},
        )
        return self._build_detail(project_id, row) if row else None

    def get_finding_by_trace(self, project_id: str, trace_id: str) -> FindingDetail | None:
        row = self._fetch_finding(
            "trace_id = {trace_id:String}",
            {"project_id": project_id, "trace_id": trace_id},
        )
        return self._build_detail(project_id, row) if row else None

    def _fetch_finding(self, predicate: str, params: dict) -> tuple | None:
        query = f"""
            SELECT finding_id, project_id, trace_id, summary, payload, timestamp
            FROM detector_findings
            WHERE project_id = {{project_id:String}} AND {predicate}
            ORDER BY timestamp DESC
            LIMIT 1
        """
        result = self._client.query(query, parameters=params)
        rows = result.result_rows
        return rows[0] if rows else None

    def _build_detail(self, project_id: str, row: tuple) -> FindingDetail:
        finding_id, _project_id, trace_id, summary, payload, timestamp = row
        items = [item for item in self._parse_payload(payload) if isinstance(item, dict)]
        detector_ids = [str(item.get("detectorId") or "") for item in items]
        templates = self._read_templates(project_id, [d for d in detector_ids if d])
        results = [
            DetectorResultItem(
                detector_id=detector_id,
                detector_name=str(item.get("detectorName") or ""),
                template=templates.get(detector_id),
                summary=str(item.get("summary") or ""),
                identified=True,
                data=item.get("data"),
            )
            for item, detector_id in zip(items, detector_ids)
        ]
        return FindingDetail(
            finding_id=finding_id,
            project_id=project_id,
            trace_id=trace_id,
            summary=summary,
            timestamp=timestamp,
            detectors=[r.detector_name for r in results],
            results=results,
            rca=self._read_rca(project_id, finding_id),
        )

    def _read_templates(self, project_id: str, detector_ids: list[str]) -> dict[str, str | None]:
        """Map detector_id -> template from Postgres; {} on missing/failed lookup."""
        ids = [d for d in detector_ids if d]
        if not ids:
            return {}
        try:
            rows = self._pg_rows(
                "SELECT id, template FROM detectors WHERE project_id = %s AND id = ANY(%s)",
                (project_id, ids),
            )
            return {r[0]: r[1] for r in rows}
        except Exception:
            logger.warning("template lookup failed; templates will be null", exc_info=True)
            return {}

    def _read_rca(self, project_id: str, finding_id: str) -> RCAResult | None:
        """Read the finding's free-text RCA from Postgres; None if missing/failed."""
        try:
            rows = self._pg_rows(
                "SELECT status, result FROM detector_rcas "
                "WHERE project_id = %s AND finding_id = %s LIMIT 1",
                (project_id, finding_id),
            )
        except Exception:
            logger.warning("RCA lookup failed; returning rca=None", exc_info=True)
            return None
        if not rows:
            return None
        return RCAResult(status=rows[0][0], result=rows[0][1])


# Singleton instance
_service: DetectorReaderService | None = None


def get_detector_reader_service() -> DetectorReaderService:
    """Get or create the singleton DetectorReaderService."""
    global _service
    if _service is None:
        _service = DetectorReaderService()
    return _service
