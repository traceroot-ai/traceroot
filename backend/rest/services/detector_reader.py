"""Service for reading detector findings from ClickHouse + Postgres.

Findings live in ClickHouse (`detector_findings`, a `ReplacingMergeTree` keyed by
`timestamp`); the free-text RCA (`detector_rcas`) and the detector catalog
(`detectors`, used to resolve the `--detector` selector and look up templates)
live in Postgres. All reads are scoped to the caller's `project_id`.

Postgres is best-effort for enrichment: an RCA or template lookup that is missing
or fails degrades to ``None`` (or, for the kept-answer fallback of an RCA, to the
latest attempt) and never prevents a finding from being returned. A ClickHouse
failure on the finding read itself propagates (the router maps it to a
controlled 500).
"""

import json
import logging
from datetime import datetime
from typing import Any

import psycopg2

from db.clickhouse import get_clickhouse_client
from rest.retention import get_retention_cutoff
from rest.schemas.public import (
    DetectorDetail,
    DetectorItem,
    DetectorResultItem,
    FindingDetail,
    FindingSignal,
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
    # detector catalog
    # ------------------------------------------------------------------ #
    def list_detectors(
        self,
        project_id: str,
        limit: int,
        start_after: datetime | None = None,
        end_before: datetime | None = None,
    ) -> tuple[list[DetectorItem], int]:
        """List the project's detectors from the Postgres catalog, newest first.

        The ``start_after`` / ``end_before`` window mirrors the findings/traces list
        windows. Unlike the best-effort RCA/template enrichment reads, a failure
        here is NOT swallowed: it propagates so the router returns a controlled 500.

        Args:
            project_id (str): Owning project; every query is scoped to it.
            limit (int): Max items in the returned page (already validated by the router).
            start_after (datetime | None): Inclusive lower bound on ``create_time``.
            end_before (datetime | None): Exclusive upper bound on ``create_time``.

        Returns:
            tuple[list[DetectorItem], int]: The page of :class:`DetectorItem` ordered
            by ``create_time`` DESC, plus the total number of catalog rows matching
            the filters (for pagination).
        """
        conditions = ["project_id = %s"]
        params: list[Any] = [project_id]
        if start_after is not None:
            conditions.append("create_time >= %s")
            params.append(to_utc_naive(start_after))
        if end_before is not None:
            conditions.append("create_time < %s")
            params.append(to_utc_naive(end_before))
        where = " AND ".join(conditions)

        count_rows = self._pg_rows(f"SELECT count(*) FROM detectors WHERE {where}", tuple(params))
        total = count_rows[0][0] if count_rows else 0

        rows = self._pg_rows(
            f"SELECT id, name, template, enabled, create_time FROM detectors "
            f"WHERE {where} ORDER BY create_time DESC LIMIT %s",
            (*params, limit),
        )
        items = [
            DetectorItem(
                detector_id=row[0],
                name=row[1],
                template=row[2],
                enabled=row[3],
                created_at=row[4],
            )
            for row in rows
        ]
        return items, total

    def get_detector(self, project_id: str, detector_id: str) -> DetectorDetail | None:
        """Fetch one detector's full configuration, with its optional trigger.

        Like :meth:`list_detectors`, a Postgres failure here propagates so the
        router returns a controlled 500 (this is a primary read, not
        best-effort enrichment).

        Args:
            project_id (str): Owning project; scopes the lookup.
            detector_id (str): Detector id (``detectors.id``).

        Returns:
            DetectorDetail | None: The detector with trigger conditions when
            the row exists in the project, else None (router maps to 404).
        """
        rows = self._pg_rows(
            "SELECT d.id, d.name, d.template, d.enabled, d.create_time, d.prompt, "
            "d.output_schema, d.sample_rate, d.enable_rca, d.detection_model, "
            "d.detection_provider, d.detection_source, d.update_time, t.conditions "
            "FROM detectors d "
            "LEFT JOIN detector_triggers t ON t.detector_id = d.id "
            "WHERE d.project_id = %s AND d.id = %s",
            (project_id, detector_id),
        )
        if not rows:
            return None
        row = rows[0]
        return DetectorDetail(
            detector_id=row[0],
            name=row[1],
            template=row[2],
            enabled=row[3],
            created_at=row[4],
            prompt=row[5],
            output_schema=row[6],
            sample_rate=row[7],
            enable_rca=row[8],
            detection_model=row[9],
            detection_provider=row[10],
            detection_source=row[11],
            updated_at=row[12],
            trigger_conditions=row[13],
        )

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
        """List a project's detector findings, newest first, with the total match count.

        ``detector_findings`` is a ``ReplacingMergeTree(timestamp)``, so every query
        first dedups to the latest row per ``finding_id`` (``LIMIT 1 BY``), and
        filter placement is both correctness- and cost-critical:

        * ``project_id`` / ``trace_id`` (immutable across re-ingested versions) and
          ``start_after`` are applied BEFORE the dedup. ``start_after`` is safe
          there because a finding's latest version carries the max timestamp, so it
          survives ``timestamp >= start`` iff its latest version does — this scopes
          the expensive dedup + count to the window instead of all history.
        * ``end_before`` and the payload-based ``detector`` predicate are
          version-sensitive and applied AFTER the dedup; on raw pre-merge rows an
          older version ``< end_before`` (or an outdated payload) could otherwise
          resurface a finding whose latest version no longer matches.

        Args:
            project_id (str): Owning project; every query is scoped to it.
            limit (int): Max findings in the returned page (already validated by the router).
            start_after (datetime | None): Inclusive lower bound on ``timestamp``.
            end_before (datetime | None): Exclusive upper bound on ``timestamp``.
            detector (str | None): Optional selector (id / name / template); resolved
                server-side to the matching detector names+ids and matched against
                the stored payload. An unresolved token simply matches nothing.
            trace_id (str | None): Optional restriction to a single trace's finding.

        Returns:
            tuple[list[FindingSummary], int]: The page of :class:`FindingSummary`
            ordered by ``timestamp`` DESC, plus the total number of distinct findings
            matching the filters.
        """
        params: dict[str, Any] = {"project_id": project_id, "limit": limit}

        # Pre-dedup filters (see the docstring: safe here + they prune the scan).
        base_conditions = ["project_id = {project_id:String}"]
        if trace_id is not None:
            base_conditions.append("trace_id = {trace_id:String}")
            params["trace_id"] = trace_id
        if start_after is not None:
            base_conditions.append("timestamp >= {start_after:DateTime64(3)}")
            params["start_after"] = to_utc_naive(start_after)

        # Post-dedup, version-sensitive filters (see the docstring).
        outer_conditions: list[str] = []
        if end_before is not None:
            outer_conditions.append("timestamp < {end_before:DateTime64(3)}")
            params["end_before"] = to_utc_naive(end_before)
        if detector is not None:
            # Backend-owned resolution: match a finding whose payload contains any
            # of the resolved tokens by detectorName OR detectorId. The raw token is
            # always included, so `detector=<id>` matches a payload detectorId even
            # when Postgres resolves nothing; an unresolved token matches nothing
            # (empty list, not an error).
            params["detector_names"] = self._resolve_detector_names(project_id, detector)
            outer_conditions.append(
                "arrayExists("
                "x -> JSONExtractString(x, 'detectorName') IN {detector_names:Array(String)} "
                "OR JSONExtractString(x, 'detectorId') IN {detector_names:Array(String)}, "
                "JSONExtractArrayRaw(payload))"
            )

        base_where = " AND ".join(base_conditions)
        outer_where = (" WHERE " + " AND ".join(outer_conditions)) if outer_conditions else ""

        # Dedup the ReplacingMergeTree rows to the latest per finding_id first.
        deduped = f"""
            SELECT finding_id, project_id, trace_id, summary, payload, timestamp
            FROM detector_findings
            WHERE {base_where}
            ORDER BY timestamp DESC
            LIMIT 1 BY finding_id
        """

        count_query = f"SELECT count() FROM ({deduped}){outer_where}"
        count_result = self._client.query(count_query, parameters=params)
        total = count_result.result_rows[0][0] if count_result.result_rows else 0

        list_query = f"""
            SELECT finding_id, project_id, trace_id, summary, payload, timestamp
            FROM ({deduped}){outer_where}
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
        run_ids = self._run_ids_for_findings(project_id, [it.finding_id for it in items])
        signals = self._read_signals(project_id, [it.finding_id for it in items])
        for it in items:
            it.run_ids = run_ids.get(it.finding_id, [])
            it.signals = [
                FindingSignal(detector_id=detector_id, **fields)
                for detector_id, fields in signals.get(it.finding_id, {}).items()
            ]
        return items, total

    def _run_ids_for_findings(
        self, project_id: str, finding_ids: list[str]
    ) -> dict[str, list[str]]:
        """Map finding_id -> its producing run_ids.

        A finding is per-trace but a run is per-(trace, detector), so a finding
        that fired N detectors has N runs, each referencing it via ``finding_id``;
        this reverses that for a page of findings in one bounded query. Kept
        separate from the finding SQL so the delicate dedup/version filtering
        there stays untouched. ``FINAL`` reads canonical (post-merge) run rows so
        a run re-evaluated back to non-triggering (its current version drops the
        ``finding_id``) is not attributed from a stale pre-merge row; sorted for a
        stable list. ``{}`` on missing/failed lookup — run_ids are a display
        convenience, never a reason to fail the read.

        Args:
            project_id (str): Owning project; scopes the lookup.
            finding_ids (list[str]): The finding ids of the current page.

        Returns:
            dict[str, list[str]]: ``finding_id -> sorted list of run_ids``, for
            findings that have at least one run.
        """
        ids = [f for f in finding_ids if f]
        if not ids:
            return {}
        try:
            result = self._client.query(
                "SELECT finding_id, arraySort(groupUniqArray(run_id)) AS run_ids "
                "FROM detector_runs FINAL "
                "WHERE project_id = {project_id:String} "
                "AND finding_id IN {finding_ids:Array(String)} "
                "GROUP BY finding_id",
                parameters={"project_id": project_id, "finding_ids": ids},
            )
            return {row[0]: list(row[1]) for row in result.result_rows}
        except Exception:
            logger.warning("run_id lookup failed; run_ids will be empty", exc_info=True)
            return {}

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
    def get_finding(
        self, project_id: str, finding_id: str, billing_plan: str | None = None
    ) -> FindingDetail | None:
        """Get one finding by id.

        Stored finding ids are uuid-hyphenated, but display surfaces render
        them dashless to match run/trace id shape — compare
        hyphen-insensitively so an id copied from either surface resolves.

        Args:
            project_id (str): Project that owns the finding.
            finding_id (str): The finding id, with or without hyphens.
            billing_plan (str | None): The caller's plan; an RCA inherited from
                a signal is read only from findings inside its retention window.

        Returns:
            FindingDetail | None: The finding, or None when no row matches.
        """
        row = self._fetch_finding(
            "replaceAll(finding_id, '-', '') = replaceAll({finding_id:String}, '-', '')",
            {"project_id": project_id, "finding_id": finding_id},
        )
        return self._build_detail(project_id, row, billing_plan) if row else None

    def get_finding_by_trace(
        self, project_id: str, trace_id: str, billing_plan: str | None = None
    ) -> FindingDetail | None:
        row = self._fetch_finding(
            "trace_id = {trace_id:String}",
            {"project_id": project_id, "trace_id": trace_id},
        )
        return self._build_detail(project_id, row, billing_plan) if row else None

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

    def _build_detail(
        self, project_id: str, row: tuple, billing_plan: str | None = None
    ) -> FindingDetail:
        finding_id, _project_id, trace_id, summary, payload, timestamp = row
        items = [item for item in self._parse_payload(payload) if isinstance(item, dict)]
        detector_ids = [str(item.get("detectorId") or "") for item in items]
        templates = self._read_templates(project_id, [d for d in detector_ids if d])
        signals = self._read_signals(project_id, [finding_id]).get(finding_id, {})
        results = [
            DetectorResultItem(
                detector_id=detector_id,
                detector_name=str(item.get("detectorName") or ""),
                template=templates.get(detector_id),
                summary=str(item.get("summary") or ""),
                identified=True,
                data=item.get("data"),
                **signals.get(detector_id, {}),
            )
            for item, detector_id in zip(items, detector_ids)
        ]
        rca = self._read_rca(project_id, finding_id)
        if rca is None and signals:
            rca = self._read_inherited_rca(project_id, results, billing_plan)
        return FindingDetail(
            finding_id=finding_id,
            project_id=project_id,
            trace_id=trace_id,
            summary=summary,
            timestamp=timestamp,
            detectors=[r.detector_name for r in results],
            results=results,
            rca=rca,
            run_ids=self._run_ids_for_findings(project_id, [finding_id]).get(finding_id, []),
            signals=[
                FindingSignal(detector_id=detector_id, **fields)
                for detector_id, fields in signals.items()
            ],
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
        """Read the finding's free-text RCA from Postgres; None if missing or the lookup fails.

        The finding's row holds only the latest attempt, which a later signal on
        the same trace resets and may fail. While that attempt is not done, the
        newest successful answer kept on one of the finding's signal openings
        stands for it; if that second lookup fails, the latest attempt is
        returned as it is.
        """
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
        status, result = rows[0]
        if status != "done":
            try:
                kept = self._pg_rows(
                    "SELECT sr.result FROM signal_rcas sr "
                    "JOIN detector_rcas dr ON dr.finding_id = sr.finding_id "
                    "WHERE dr.project_id = %s AND sr.finding_id = %s "
                    "AND sr.result IS NOT NULL "
                    "ORDER BY sr.create_time DESC LIMIT 1",
                    (project_id, finding_id),
                )
            except Exception:
                # The latest attempt's state is still worth returning.
                logger.warning(
                    "kept RCA lookup failed; returning the latest attempt", exc_info=True
                )
                kept = []
            if kept:
                return RCAResult(status="done", result=kept[0][0])
        return RCAResult(status=status, result=result)

    def _read_signals(
        self, project_id: str, finding_ids: list[str]
    ) -> dict[str, dict[str, dict[str, str]]]:
        """Map finding_id -> detector_id -> the signal its hit belongs to.

        Best-effort like the other Postgres enrichment: ``{}`` on a failed
        lookup, and a hit that is not grouped (signals off, or not assigned
        yet) is simply absent.
        """
        ids = [f for f in finding_ids if f]
        if not ids:
            return {}
        try:
            rows = self._pg_rows(
                "SELECT sh.finding_id, sh.detector_id, s.id, s.title, s.status "
                "FROM signal_hits sh JOIN signals s ON s.id = sh.signal_id "
                "WHERE sh.project_id = %s AND sh.finding_id = ANY(%s)",
                (project_id, ids),
            )
        except Exception:
            logger.warning("signal lookup failed; signal fields will be null", exc_info=True)
            return {}
        out: dict[str, dict[str, dict[str, str]]] = {}
        for finding_id, detector_id, signal_id, title, status in rows:
            out.setdefault(finding_id, {})[detector_id] = {
                "signal_id": signal_id,
                "signal_title": title,
                "signal_status": status,
            }
        return out

    def _read_inherited_rca(
        self,
        project_id: str,
        results: list[DetectorResultItem],
        billing_plan: str | None = None,
    ) -> RCAResult | None:
        """The RCAs a finding inherits from the signals its hits joined.

        A hit that joins a known signal runs no RCA of its own; the signal's
        canonical RCA (the successful answer kept on its newest opening that has
        one; a later failed attempt on a shared finding does not remove it)
        stands for it. The answer comes from another trace, so with a plan it is
        read only from openings whose finding was detected inside the plan's
        retention window, as the finding itself is.
        One section per grouped detector, labelled with the signal and the trace
        the RCA analysed. None when no signal has a finished RCA or the lookup
        fails.
        """
        grouped = [r for r in results if r.signal_id]
        if not grouped:
            return None
        cutoff = get_retention_cutoff(billing_plan) if billing_plan else None
        retained = (
            " AND EXISTS (SELECT 1 FROM signal_hits rh "
            "WHERE rh.finding_id = sr.finding_id AND rh.seen_at >= %s)"
            if cutoff
            else ""
        )
        params: tuple = ([r.signal_id for r in grouped], project_id)
        try:
            rows = self._pg_rows(
                "SELECT DISTINCT ON (sr.signal_id) sr.signal_id, sr.result, "
                "(SELECT sh.trace_id FROM signal_hits sh "
                " WHERE sh.finding_id = sr.finding_id LIMIT 1) "
                "FROM signal_rcas sr JOIN detector_rcas dr ON dr.finding_id = sr.finding_id "
                "WHERE sr.signal_id = ANY(%s) AND dr.project_id = %s AND sr.result IS NOT NULL"
                + retained
                + " ORDER BY sr.signal_id, sr.reopen_seq DESC",
                (*params, cutoff) if cutoff else params,
            )
        except Exception:
            logger.warning("inherited RCA lookup failed; returning rca=None", exc_info=True)
            return None
        by_signal = {row[0]: (row[1], row[2]) for row in rows}
        sections = []
        for r in grouped:
            if r.signal_id not in by_signal:
                continue
            result, trace_id = by_signal[r.signal_id]
            source = f"from trace {trace_id}" if trace_id else "from an earlier trace"
            sections.append(
                f'## {r.detector_name}: signal "{r.signal_title}"\n'
                f"This hit joined a known signal, so no new RCA ran. "
                f"The signal's RCA, {source}:\n\n{result or ''}"
            )
        if not sections:
            return None
        return RCAResult(status="done", result="\n\n".join(sections), inherited=True)


# Singleton instance
_service: DetectorReaderService | None = None


def get_detector_reader_service() -> DetectorReaderService:
    """Get or create the singleton DetectorReaderService."""
    global _service
    if _service is None:
        _service = DetectorReaderService()
    return _service
