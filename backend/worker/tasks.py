"""Celery task definitions.

This module defines the async tasks that process trace data from S3 to ClickHouse.
"""

import logging

from worker.celery_app import app

logger = logging.getLogger(__name__)


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
    from worker.transformer import transform_otel_to_clickhouse

    logger.info(f"Processing S3 traces: {s3_key} for project {project_id}")

    try:
        # 1. Download from S3
        s3_service = get_s3_service()
        otel_data = s3_service.download_json(s3_key)
        logger.debug(f"Downloaded OTEL data from {s3_key}")

        # 2. Transform to ClickHouse format
        traces, spans = transform_otel_to_clickhouse(otel_data, project_id)
        logger.info(
            f"Transformed {len(traces)} traces and {len(spans)} spans from {s3_key}"
        )

        # 3. Insert into ClickHouse
        if traces or spans:
            ch_client = get_clickhouse_client()

            if traces:
                ch_client.insert_traces_batch(traces)
                logger.info(f"Inserted {len(traces)} traces into ClickHouse")

            if spans:
                ch_client.insert_spans_batch(spans)
                logger.info(f"Inserted {len(spans)} spans into ClickHouse")

        return {
            "s3_key": s3_key,
            "project_id": project_id,
            "traces": len(traces),
            "spans": len(spans),
        }

    except Exception as e:
        logger.error(f"Failed to process {s3_key}: {e}", exc_info=True)
        raise  # Re-raise to trigger Celery retry
