"""Celery application configuration.

This module configures Celery with Redis as the broker and result backend.
Runs ClickHouse migrations on worker startup.
"""

import logging
import os
import subprocess

from celery import Celery
from celery.signals import worker_ready
from dotenv import load_dotenv

logger = logging.getLogger(__name__)

# Load environment variables from .env file
load_dotenv()

# Configure logging for worker tasks
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s: %(levelname)s/%(processName)s] %(name)s - %(message)s",
)

# Redis URL from environment or default
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
REDIS_RESULT_URL = os.getenv("REDIS_RESULT_URL", "redis://localhost:6379/1")

app = Celery("traceroot")

app.conf.update(
    # Broker and backend
    broker_url=REDIS_URL,
    result_backend=REDIS_RESULT_URL,
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

# Auto-discover tasks from worker.tasks module
app.autodiscover_tasks(["worker"])


@worker_ready.connect
def on_worker_ready(**kwargs):
    """Run ClickHouse migrations when worker starts."""
    logger.info("Running ClickHouse migrations on worker startup...")
    try:
        result = subprocess.run(
            ["./db/clickhouse/migrate.sh", "up"],
            capture_output=True,
            text=True,
            env={
                **os.environ,
                "CLICKHOUSE_HOST": os.getenv("CLICKHOUSE_HOST", "localhost"),
                "CLICKHOUSE_PORT": os.getenv("CLICKHOUSE_NATIVE_PORT", "9000"),
                "CLICKHOUSE_USER": os.getenv("CLICKHOUSE_USER", "clickhouse"),
                "CLICKHOUSE_PASSWORD": os.getenv("CLICKHOUSE_PASSWORD", "clickhouse"),
                "CLICKHOUSE_DATABASE": os.getenv("CLICKHOUSE_DATABASE", "default"),
            },
        )

        if result.stdout:
            for line in result.stdout.strip().split("\n"):
                logger.info(f"goose: {line}")

        if result.returncode != 0:
            raise RuntimeError(f"goose migration failed: {result.stderr}")

        logger.info("ClickHouse migrations completed successfully")

    except FileNotFoundError:
        logger.warning("goose not found. Install with: brew install goose")
        raise
    except Exception as e:
        logger.error(f"ClickHouse migration failed: {e}")
        raise
