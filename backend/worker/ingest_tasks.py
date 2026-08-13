"""Celery task definitions.

This module defines the async tasks that process trace data from S3 to ClickHouse.
"""

import json
import logging
import threading
from collections import defaultdict
from datetime import datetime

from shared.enums import SpanKind
from worker.celery_app import app

logger = logging.getLogger(__name__)


def _json_serializer(obj: object) -> str:
    """JSON serializer for datetime objects in span dicts."""
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


def _publish_live_spans(spans: list[dict], project_id: str) -> None:
    """Publish spans to Redis for live trace streaming.

    Groups spans by trace_id and publishes to per-trace channels.
    Never raises — Redis failures must not break the ingest pipeline.
    """
    try:
        import redis as redis_lib

        from shared.config import settings

        # Create a fresh Redis connection per call — do NOT use the singleton
        # get_redis_client() here because Celery uses prefork and module-level
        # singletons created before/across fork() crash on macOS (SIGABRT).
        redis_client = redis_lib.from_url(settings.redis.url, decode_responses=True)

        # Group spans by trace_id
        by_trace: dict[str, list[dict]] = defaultdict(list)
        for span in spans:
            by_trace[span["trace_id"]].append(span)

        for trace_id, trace_spans in by_trace.items():
            channel = f"trace:live:{project_id}:{trace_id}"

            # Publish spans
            payload = json.dumps(
                {"type": "spans", "spans": trace_spans},
                default=_json_serializer,
            )
            redis_client.publish(channel, payload)

            # Check if trace is complete (root span with end time)
            for span in trace_spans:
                if span.get("parent_span_id") is None and span.get("span_end_time") is not None:
                    redis_client.publish(
                        channel,
                        json.dumps({"type": "trace_complete"}),
                    )
                    break

        redis_client.close()

    except Exception:
        logger.warning("Failed to publish live spans to Redis", exc_info=True)


def _task_cost_by_trace(rows) -> dict[str, float]:
    """Per-trace span-cost sum EXCLUDING the scorer subtree (scorer spans + descendants).

    An evaluation trace is ``EVALUATION(root) -> TASK -> SCORER`` (see the SDK eval
    engine). A scorer can itself call an LLM — an ``llm_judge`` self-instruments its
    model call, and a hand-rolled ``@scorer`` function may call a provider directly —
    and that LLM span lands in the SAME trace under the SCORER span. Folding its cost
    into the result would over-report what it costs to run the CANDIDATE, so we drop
    every scorer span and its whole subtree and sum only the remaining (task) spans.

    ``rows`` are ``(trace_id, span_id, parent_span_id, span_kind, cost)``. ``cost`` is
    set only on LLM leaf spans (otel_transform), so this is a no-op unless a leaf has one.
    """
    from collections import defaultdict

    per_trace: dict[str, dict] = defaultdict(
        lambda: {"children": defaultdict(list), "kind": {}, "cost": {}}
    )
    for trace_id, span_id, parent_span_id, span_kind, cost in rows:
        t = per_trace[trace_id]
        t["kind"][span_id] = span_kind
        t["cost"][span_id] = cost
        if parent_span_id:
            t["children"][parent_span_id].append(span_id)

    result: dict[str, float] = {}
    for trace_id, t in per_trace.items():
        excluded: set[str] = set()
        stack = [sid for sid, kind in t["kind"].items() if kind == SpanKind.SCORER]
        while stack:
            sid = stack.pop()
            if sid in excluded:
                continue
            excluded.add(sid)
            stack.extend(t["children"].get(sid, ()))
        total = 0.0
        for sid, cost in t["cost"].items():
            if sid in excluded or cost is None:
                continue
            total += float(cost)
        result[trace_id] = total
    return result


_PG_POOL = None
_PG_POOL_LOCK = threading.Lock()


def _get_pg_pool():
    """A lazily-created, thread-safe Postgres connection pool for the worker.

    Cost derivation runs once per eval-bearing batch; opening a fresh
    ``psycopg2.connect`` each time is pure connection churn (M17). A small module-level
    ``ThreadedConnectionPool`` reuses connections across batches within a worker process.
    """
    global _PG_POOL
    if _PG_POOL is None:
        with _PG_POOL_LOCK:
            if _PG_POOL is None:
                from psycopg2 import pool as _pg_pool

                from shared.config import settings

                _PG_POOL = _pg_pool.ThreadedConnectionPool(1, 8, settings.database_url)
    return _PG_POOL


def _update_eval_result_costs(project_id: str, trace_ids: set[str], ch_client) -> None:
    """Denormalize each evaluation trace's CANDIDATE-TASK cost onto its EvaluationResult.

    The SDK doesn't report per-case cost, so we derive it from the trace's LLM-span cost,
    scoped to the candidate task (the scorer subtree is excluded — see
    ``_task_cost_by_trace`` for why). This lets the runs table read ``result.cost``
    directly. Idempotent + self-healing: recomputed on every batch, so late-arriving spans
    correct the total in BOTH directions. That two-way property is the point — under
    ``BatchSpanProcessor`` a parent exports after its children, so a scorer's LLM child
    routinely lands in an earlier batch than the SCORER span itself. In that window
    nothing seeds the exclusion set and the total is over-reported; the next batch brings
    the SCORER and the recomputed total drops. Skipping the write whenever the new total
    is 0 would freeze that over-report permanently, so the write is unconditional and
    ``NULLIF`` preserves the "a cost-less trace leaves ``cost`` NULL" intent instead.

    LIMITATION — this is driven entirely off ingest, so it self-heals only for late
    SPANS, not for a late RESULT ROW. The two writers are independent: spans arrive
    SDK -> BatchSpanProcessor -> S3 -> Celery, while the ``evaluation_results`` row is
    POSTed from a different service. If every span batch for a trace is processed before
    its result row exists, the lookup below returns empty on each one and nothing ever
    revisits it — ``cost`` stays NULL despite fully-priced LLM spans sitting in
    ClickHouse. Closing that needs a trigger from the other side (derive on result-write
    or run-finalize) or a periodic backfill over ``cost IS NULL AND trace_id IS NOT
    NULL``; both are out of scope here.

    NOTE: once the SDK reports an authoritative per-result cost, this derivation must
    DEFER to it rather than overwrite — it exists only because per-result cost is absent
    today.
    """
    if not trace_ids:
        return
    try:
        pg_pool = _get_pg_pool()
        conn = pg_pool.getconn()
    except Exception:
        logger.warning("eval cost derivation: no Postgres connection", exc_info=True)
        return
    try:
        with conn.cursor() as cur:
            # Only the batch's trace_ids that are evaluation results — bounded lookup.
            cur.execute(
                "SELECT DISTINCT trace_id FROM evaluation_results "
                "WHERE project_id = %s AND trace_id = ANY(%s)",
                (project_id, list(trace_ids)),
            )
            eval_trace_ids = [r[0] for r in cur.fetchall()]
            # No result rows yet for this batch's traces — nothing to write; the read
            # transaction is still ended by the commit below so the pooled connection
            # is handed back clean (not idle-in-transaction).
            if eval_trace_ids:
                # Pull the full span tree (not just cost-bearing spans) so the scorer
                # subtree can be identified and excluded before summing.
                rows = ch_client.query(
                    "SELECT trace_id, span_id, parent_span_id, span_kind, cost FROM spans FINAL"
                    " WHERE project_id = {pid:String} AND trace_id IN {ids:Array(String)}",
                    parameters={"pid": project_id, "ids": eval_trace_ids},
                ).result_rows

                for trace_id, cost in _task_cost_by_trace(rows).items():
                    # Written unconditionally — see the docstring. NULLIF keeps a genuinely
                    # cost-less trace at NULL rather than a misleading 0.00, while still
                    # letting a previously over-reported cost be corrected back down.
                    cur.execute(
                        "UPDATE evaluation_results SET cost = NULLIF(%s, 0), update_time = now()"
                        " WHERE project_id = %s AND trace_id = %s",
                        (cost, project_id, trace_id),
                    )
        conn.commit()
    except Exception:
        # A pooled connection must not be handed back mid-transaction.
        conn.rollback()
        logger.warning("eval cost derivation failed", exc_info=True)
    finally:
        pg_pool.putconn(conn)


@app.task(name="worker.ingest_tasks.backfill_eval_result_costs")
def backfill_eval_result_costs(batch_size: int = 500) -> dict:
    """Reconcile eval-result costs that ingest could not fill (H7).

    Cost is normally derived at span-ingest, but a result row that COMMITS AFTER its spans
    were already processed is never revisited (see the LIMITATION note on
    ``_update_eval_result_costs``) and stays ``cost = NULL`` despite priced LLM spans
    sitting in ClickHouse. This periodic sweep re-runs that same derivation for recent
    null-cost results, grouped by project. Bounded to ``batch_size`` rows and to a recent
    window so it converges instead of perpetually re-sweeping genuinely cost-less traces
    (which ``NULLIF`` deliberately keeps at NULL); the next run picks up any remainder.

    Requires a Celery *beat* process to be scheduled (see ``celery_app.beat_schedule``).
    """
    from collections import defaultdict

    from db.clickhouse.client import get_clickhouse_client

    try:
        pg_pool = _get_pg_pool()
        conn = pg_pool.getconn()
    except Exception:
        logger.warning("eval cost backfill: no Postgres connection", exc_info=True)
        return {"projects": 0, "traces": 0}
    rows: list = []
    try:
        with conn.cursor() as cur:
            # Only recent null-cost results: an older one is either genuinely cost-less
            # (its spans summed to 0) or long past any late-arrival window, so re-deriving
            # it forever would be wasted ClickHouse load.
            cur.execute(
                "SELECT project_id, trace_id FROM evaluation_results "
                "WHERE cost IS NULL AND trace_id IS NOT NULL "
                "AND create_time > now() - interval '7 days' "
                "LIMIT %s",
                (batch_size,),
            )
            rows = cur.fetchall()
        conn.commit()
    except Exception:
        conn.rollback()
        logger.warning("eval cost backfill query failed", exc_info=True)
        rows = []
    finally:
        pg_pool.putconn(conn)

    by_project: dict[str, set[str]] = defaultdict(set)
    for project_id, trace_id in rows:
        by_project[project_id].add(trace_id)
    if not by_project:
        return {"projects": 0, "traces": 0}

    ch_client = get_clickhouse_client()
    traces = 0
    for project_id, trace_ids in by_project.items():
        _update_eval_result_costs(project_id, trace_ids, ch_client)
        traces += len(trace_ids)
    logger.info(
        "eval cost backfill: reconciled %d trace(s) across %d project(s)", traces, len(by_project)
    )
    return {"projects": len(by_project), "traces": traces}


@app.task(
    bind=True,
    autoretry_for=(Exception,),
    retry_backoff=True,
    retry_backoff_max=600,  # Max 10 minutes between retries
    max_retries=5,
)
def process_s3_traces(self, s3_key: str, project_id: str) -> dict:
    """Process OTEL traces from S3 and insert into ClickHouse.

    This task:
    1. Downloads the OTEL JSON from S3
    2. Transforms it to ClickHouse format
    3. Batch inserts traces and spans

    Args:
        s3_key: S3 key where the OTEL JSON is stored
        project_id: Project ID for the traces

    Returns:
        Dict with counts of inserted traces and spans
    """
    # Import here to avoid circular imports and ensure fresh connections
    from db.clickhouse.client import get_clickhouse_client
    from rest.services.s3 import get_s3_service
    from worker.otel_transform import transform_otel_to_clickhouse

    logger.info(f"Processing S3 traces: {s3_key} for project {project_id}")

    try:
        # 1. Download from S3
        s3_service = get_s3_service()
        otel_data = s3_service.download_json(s3_key)
        logger.debug(f"Downloaded OTEL data from {s3_key}")

        # 2. Transform to ClickHouse format
        traces, spans = transform_otel_to_clickhouse(otel_data, project_id)
        logger.info(f"Transformed {len(traces)} traces and {len(spans)} spans from {s3_key}")

        root_bearing_trace_ids = {s["trace_id"] for s in spans if s.get("parent_span_id") is None}

        # 3. Insert into ClickHouse
        if traces or spans:
            ch_client = get_clickhouse_client()

            if traces:
                # Only insert a trace record if this batch contains the root span
                # OR the trace is genuinely new (no existing ClickHouse record).
                # Intermediate batches without the root span must not overwrite a
                # correctly-named trace record with a wrong name.
                trace_records_missing_root = [
                    t for t in traces if t["trace_id"] not in root_bearing_trace_ids
                ]
                if trace_records_missing_root:
                    ids = [t["trace_id"] for t in trace_records_missing_root]
                    result = ch_client.query(
                        "SELECT DISTINCT trace_id FROM traces FINAL"
                        " WHERE trace_id IN {ids:Array(String)}",
                        parameters={"ids": ids},
                    )
                    existing_ids = {row[0] for row in result.result_rows}
                    traces = [
                        t
                        for t in traces
                        if t["trace_id"] in root_bearing_trace_ids
                        or t["trace_id"] not in existing_ids
                    ]

                if traces:
                    ch_client.insert_traces_batch(traces)
                    logger.info(f"Inserted {len(traces)} traces into ClickHouse")

            if spans:
                ch_client.insert_spans_batch(spans)
                logger.info(f"Inserted {len(spans)} spans into ClickHouse")

                # Denormalize eval-trace cost onto EvaluationResult (runs-table Cost).
                #
                # Gated on the batch actually containing evaluation spans. The batch
                # already knows the answer in memory (otel_transform set is_evaluation
                # from the span kind), so gating costs nothing — whereas calling
                # unconditionally puts a Postgres connect + round trip on the main
                # product's ingest hot path, per S3 object, per worker, only to learn
                # "no eval results" for the >99% of batches that carry ordinary traces.
                eval_trace_ids = {s["trace_id"] for s in spans if s.get("is_evaluation")}
                if eval_trace_ids:
                    try:
                        _update_eval_result_costs(project_id, eval_trace_ids, ch_client)
                    except Exception as e:
                        logger.error(f"eval cost derivation errored: {e}", exc_info=True)

        # Trigger detector runs (fire-and-forget, non-blocking). The batch that
        # carries a trace's root span triggers detection exactly once — a Redis
        # lock keyed on (project, trace) dedups against ingest-task retries and
        # duplicate root delivery. Batches without the root span are ignored
        # here; the worker waits out the quiescence window before evaluating,
        # so late spans need no enqueue.
        if root_bearing_trace_ids:
            try:
                from worker.detector_tasks import enqueue_detector_runs

                enqueue_detector_runs(project_id, root_bearing_trace_ids)
            except Exception as e:
                logger.error(f"Failed to call detector tasks: {e}", exc_info=True)

        # 4. Publish to Redis for live trace streaming
        if spans:
            _publish_live_spans(spans, project_id)

        return {
            "s3_key": s3_key,
            "project_id": project_id,
            "traces": len(traces),
            "spans": len(spans),
        }

    except Exception as e:
        logger.error(f"Failed to process {s3_key}: {e}", exc_info=True)
        raise  # Re-raise to trigger Celery retry
