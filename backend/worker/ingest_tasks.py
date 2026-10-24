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


def _root_kind_value(value) -> int:
    """Accept ClickHouse Enum8 labels and numeric test/client values."""

    if isinstance(value, str):
        return {"placeholder": 0, "remote_parent": 1, "root": 2}.get(value, 0)
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _merge_trace_record(incoming: dict, existing: dict | None) -> dict:
    """Merge one replacement row using logical root precedence.

    Root identity fields are copied only from the winning root.  User/session
    fields are the exception: SDKs stamp them on children too, so a non-null
    value from the existing row is retained when the winning root omits it.
    Evaluation classification is monotonic across all batches.
    """

    from shared.trace_identity import TraceRootKind, trace_root_version

    incoming_kind = _root_kind_value(incoming.get("root_kind", 0))
    incoming = dict(incoming)
    incoming["root_kind"] = incoming_kind
    incoming["root_version"] = incoming.get("root_version") or trace_root_version(
        incoming_kind,
        incoming.get("trace_start_time"),
        bool(incoming.get("is_evaluation")),
    )
    if existing is None:
        return incoming

    stored = dict(existing)
    stored["root_kind"] = _root_kind_value(stored.get("root_kind", 0))
    stored["root_version"] = int(stored.get("root_version") or 0)
    incoming_wins = incoming["root_version"] > stored["root_version"]
    winner = incoming if incoming_wins else stored
    loser = stored if incoming_wins else incoming
    merged = dict(winner)

    for field in ("user_id", "session_id"):
        if merged.get(field) is None and loser.get(field) is not None:
            merged[field] = loser[field]

    # Deployment/source metadata is non-root identity but still logical trace
    # state.  Preserve an already-known valid value when the winning root omits
    # it; input/output/metadata intentionally do NOT use this fallback.
    for field in ("environment", "git_ref", "git_repo", "source"):
        if merged.get(field) is None and loser.get(field) is not None:
            merged[field] = loser[field]

    merged["is_evaluation"] = int(
        bool(stored.get("is_evaluation")) or bool(incoming.get("is_evaluation"))
    )
    # Preserve the logical root version while making a newly discovered eval
    # classification win a same-root replacement deterministically.
    if merged["is_evaluation"]:
        merged["root_version"] = int(merged["root_version"]) | 1
    elif merged.get("root_kind") == int(TraceRootKind.PLACEHOLDER):
        merged["root_version"] = 0
    return merged


def _trace_rows_by_id(ch_client, project_id: str, trace_ids: list[str]) -> dict[str, dict]:
    """Read only the requested logical trace rows using the trace-id sort key."""

    if not trace_ids:
        return {}
    result = ch_client.query(
        """
        SELECT trace_id, root_kind, root_version, trace_start_time, name, source,
               user_id, session_id, git_ref, git_repo, input, output, metadata,
               environment, is_evaluation
        FROM traces
        WHERE project_id = {project_id:String}
          AND trace_id IN {trace_ids:Array(String)}
        ORDER BY root_version DESC, ch_update_time DESC
        LIMIT 1 BY project_id, trace_id
        """,
        parameters={"trace_ids": trace_ids, "project_id": project_id},
    )
    rows: dict[str, dict] = {}
    for row in result.result_rows:
        if len(row) == 1:
            # Compatibility with narrow unit-test doubles and old clients that
            # only returned the existence probe shape.
            rows[row[0]] = {"trace_id": row[0], "root_kind": 0, "root_version": 0}
            continue
        values = dict(
            zip(
                (
                    "trace_id",
                    "root_kind",
                    "root_version",
                    "trace_start_time",
                    "name",
                    "source",
                    "user_id",
                    "session_id",
                    "git_ref",
                    "git_repo",
                    "input",
                    "output",
                    "metadata",
                    "environment",
                    "is_evaluation",
                ),
                row,
            )
        )
        rows[values["trace_id"]] = values
    return rows


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
    ``psycopg2.connect`` each time is pure connection churn. A small module-level
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
    ClickHouse. ``backfill_eval_result_costs`` closes that gap by re-running this
    derivation for not-yet-derived result rows; it keys off the ``cost_derived_at`` marker
    stamped below (NOT ``cost IS NULL``), so a zero-cost trace settles after one pass
    instead of being re-swept forever.

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
    broken = False
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
                # Mark EVERY examined result row as derivation-attempted — a state distinct
                # from `cost IS NULL`, so a zero-cost trace (NULLIF above) or one whose
                # spans never landed settles instead of being re-swept by the backfill
                # forever. Ingest never filters on this column, so the late-SPAN
                # self-healing above is unaffected; only ``backfill_eval_result_costs``
                # reads it.
                cur.execute(
                    "UPDATE evaluation_results SET cost_derived_at = now()"
                    " WHERE project_id = %s AND trace_id = ANY(%s)",
                    (project_id, eval_trace_ids),
                )
        conn.commit()
    except Exception:
        broken = True
        # rollback() on an already-dead connection can itself raise; swallow that so the
        # finally still runs and the poisoned connection is evicted, not recycled.
        try:
            conn.rollback()
        except Exception:
            logger.warning("eval cost derivation: rollback failed", exc_info=True)
        logger.warning("eval cost derivation failed", exc_info=True)
    finally:
        # Close (evict) a connection that errored rather than return a possibly-broken
        # handle to the pool for the next borrower to trip over.
        pg_pool.putconn(conn, close=broken)


@app.task(name="worker.ingest_tasks.backfill_eval_result_costs")
def backfill_eval_result_costs(batch_size: int = 500) -> dict:
    """Reconcile eval-result costs that ingest could not fill.

    Cost is normally derived at span-ingest, but a result row that COMMITS AFTER its spans
    were already processed is never revisited (see the LIMITATION note on
    ``_update_eval_result_costs``) and stays ``cost = NULL`` despite priced LLM spans
    sitting in ClickHouse. This periodic sweep re-runs that same derivation for recent
    NOT-YET-DERIVED results (``cost_derived_at IS NULL``), grouped by project. Because
    derivation stamps ``cost_derived_at`` regardless of the resulting cost, a zero-cost
    trace settles after one pass instead of being re-swept forever; bounded to
    ``batch_size`` newest-first rows within a recent window (backed by the partial index
    ``ix_eval_result_cost_backfill``), the next run picks up any remainder.

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
    broken = False
    try:
        with conn.cursor() as cur:
            # Candidates are NOT-YET-DERIVED results (cost_derived_at IS NULL), not
            # `cost IS NULL` — the latter also matches zero-cost traces that were already
            # derived, which would be re-swept every tick and could starve a genuinely
            # late row behind them. ORDER BY create_time DESC processes the newest (most
            # likely still-arriving) candidates first so no row is indefinitely skipped;
            # the recent-window bound keeps the scan on the partial index small. See
            # migration ``ix_eval_result_cost_backfill``.
            cur.execute(
                "SELECT project_id, trace_id FROM evaluation_results "
                "WHERE cost_derived_at IS NULL AND trace_id IS NOT NULL "
                "AND create_time > now() - interval '7 days' "
                "ORDER BY create_time DESC "
                "LIMIT %s",
                (batch_size,),
            )
            rows = cur.fetchall()
        conn.commit()
    except Exception:
        broken = True
        try:
            conn.rollback()
        except Exception:
            logger.warning("eval cost backfill: rollback failed", exc_info=True)
        logger.warning("eval cost backfill query failed", exc_info=True)
        rows = []
    finally:
        pg_pool.putconn(conn, close=broken)

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
    autoretry_for=(Exception,),
    retry_backoff=True,
    retry_backoff_max=600,  # Max 10 minutes between retries
    max_retries=5,
)
def finalize_remote_detector_runs(project_id: str, trace_id: str) -> None:
    """Make the final detector decision for a remote-only provisional root.

    The task reuses the detector worker's existing quiescence interval.  A
    caller root arriving during the interval therefore gets a chance to claim
    all detectors with the complete trace; a remote-only trace is evaluated
    only after no new span has arrived for the same interval.
    """

    from db.clickhouse.client import get_clickhouse_client
    from worker.detector_tasks import EVALUATOR_DELAY, enqueue_detector_runs

    ch_client = get_clickhouse_client()
    result = ch_client.query(
        """
        SELECT greatest(0, date_diff('millisecond', max(ch_create_time), now64(3)))
        FROM spans
        WHERE project_id = {project_id:String} AND trace_id = {trace_id:String}
        """,
        parameters={"project_id": project_id, "trace_id": trace_id},
    )
    row = result.result_rows[0] if result.result_rows else None
    quiet_ms = int(row[0]) if row and row[0] is not None else 0
    if quiet_ms < EVALUATOR_DELAY:
        finalize_remote_detector_runs.apply_async(
            args=[project_id, trace_id],
            countdown=max(1, (EVALUATOR_DELAY - quiet_ms) / 1000),
        )
        return

    # The final Redis NX claim and deterministic sampling remain in the normal
    # path, so a caller-root batch racing this task cannot create a duplicate.
    enqueue_detector_runs(project_id, {trace_id})


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
    from worker.otel_transform import PARENT_IS_REMOTE_KEY, transform_otel_to_clickhouse

    logger.info(f"Processing S3 traces: {s3_key} for project {project_id}")

    try:
        # 1. Download from S3
        s3_service = get_s3_service()
        otel_data = s3_service.download_json(s3_key)
        logger.debug(f"Downloaded OTEL data from {s3_key}")

        # 2. Transform to ClickHouse format
        traces, spans = transform_otel_to_clickhouse(otel_data, project_id)
        logger.info(f"Transformed {len(traces)} traces and {len(spans)} spans from {s3_key}")

        locally_rooted_trace_ids = {
            s["trace_id"]
            for s in spans
            if s.get("parent_span_id") is None and not s.get(PARENT_IS_REMOTE_KEY)
        }
        remotely_rooted_trace_ids = {s["trace_id"] for s in spans if s.get(PARENT_IS_REMOTE_KEY)}

        # 3. Insert into ClickHouse
        if traces or spans:
            ch_client = get_clickhouse_client()

            if traces:
                existing = _trace_rows_by_id(ch_client, project_id, [t["trace_id"] for t in traces])
                merged_traces = []
                for incoming in traces:
                    merged = _merge_trace_record(incoming, existing.get(incoming["trace_id"]))
                    prior = existing.get(incoming["trace_id"])
                    if prior is None or any(
                        merged.get(field) != prior.get(field)
                        for field in (
                            "root_kind",
                            "root_version",
                            "trace_start_time",
                            "name",
                            "source",
                            "user_id",
                            "session_id",
                            "git_ref",
                            "git_repo",
                            "input",
                            "output",
                            "metadata",
                            "environment",
                            "is_evaluation",
                        )
                    ):
                        merged_traces.append(merged)

                if merged_traces:
                    ch_client.insert_traces_batch(merged_traces)
                    logger.info(f"Inserted {len(merged_traces)} traces into ClickHouse")

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

        # A true local root is eligible for the final detector claim now. A
        # remote-parent entry only schedules a separate quiescence finalizer; it
        # must not consume the final NX claim while the caller root may still
        # arrive with additional duration/metadata.
        if locally_rooted_trace_ids:
            try:
                from worker.detector_tasks import enqueue_detector_runs

                enqueue_detector_runs(project_id, locally_rooted_trace_ids)
            except Exception as e:
                logger.error(f"Failed to call detector tasks: {e}", exc_info=True)
        if remotely_rooted_trace_ids:
            try:
                from worker.detector_tasks import schedule_remote_detector_finalization

                schedule_remote_detector_finalization(project_id, remotely_rooted_trace_ids)
            except Exception as e:
                logger.error(f"Failed to schedule remote detector finalization: {e}", exc_info=True)

        # 4. Publish to Redis for live trace streaming
        if spans:
            # Root eligibility is ingest-internal; do not expose the transient
            # marker through the live Redis payload either.
            _publish_live_spans(
                [
                    {key: value for key, value in span.items() if key != PARENT_IS_REMOTE_KEY}
                    for span in spans
                ],
                project_id,
            )

        return {
            "s3_key": s3_key,
            "project_id": project_id,
            "traces": len(traces),
            "spans": len(spans),
        }

    except Exception as e:
        logger.error(f"Failed to process {s3_key}: {e}", exc_info=True)
        raise  # Re-raise to trigger Celery retry
