"""Celery application configuration.

This module configures Celery with Redis as the broker and result backend.
Runs ClickHouse migrations on worker startup.
"""

import logging
import os
import subprocess
from pathlib import Path

from celery import Celery
from celery.signals import worker_ready
from dotenv import load_dotenv

logger = logging.getLogger(__name__)

# Load environment variables from .env file
load_dotenv()

from shared.config import settings

# Configure logging for worker tasks
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s: %(levelname)s/%(processName)s] %(name)s - %(message)s",
)

app = Celery("traceroot")

app.conf.update(
    # Broker and backend
    broker_url=settings.redis.url,
    result_backend=settings.redis.result_url,
    # Reliability settings
    task_acks_late=True,  # ACK after task completes (not before)
    task_reject_on_worker_lost=True,  # Requeue if worker dies mid-task
    broker_transport_options={
        "visibility_timeout": 3600,  # 1 hour - time before unacked task is requeued
    },
    # Performance
    worker_prefetch_multiplier=4,  # Prefetch 4 tasks per worker process
    # Serialization (JSON for debuggability)
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    # Timezone
    timezone="UTC",
    enable_utc=True,
    # Result expiration (1 hour)
    result_expires=3600,
)

# Auto-discover tasks from worker.ingest_tasks module
app.autodiscover_tasks(["worker"], related_name="ingest_tasks")


@worker_ready.connect
def on_worker_ready(**kwargs):
    """Run ClickHouse migrations when worker starts."""
    logger.info("Running ClickHouse migrations on worker startup...")
    try:
        ch = settings.clickhouse
        result = subprocess.run(
            [
                str(Path(__file__).resolve().parent.parent / "db" / "clickhouse" / "migrate.sh"),
                "up",
            ],
            capture_output=True,
            text=True,
            env={
                **os.environ,
                "CLICKHOUSE_HOST": ch.host,
                "CLICKHOUSE_PORT": str(ch.native_port),
                "CLICKHOUSE_USER": ch.user,
                "CLICKHOUSE_PASSWORD": ch.password,
                "CLICKHOUSE_DATABASE": ch.database,
            },
        )

        if result.stdout:
            for line in result.stdout.strip().split("\n"):
                logger.info(f"goose: {line}")

        if result.returncode != 0:
            logger.warning(f"ClickHouse migration skipped: {result.stderr.strip()}")
            return

        logger.info("ClickHouse migrations completed successfully")

    except FileNotFoundError:
        logger.warning("goose not found, skipping ClickHouse migrations.")
    except Exception as e:
        logger.error(f"ClickHouse migration failed: {e}")
