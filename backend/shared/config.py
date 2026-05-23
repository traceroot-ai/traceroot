"""Centralized configuration for the TraceRoot backend.

All environment variables are read once at import time via Pydantic Settings.
Services import ``settings`` from this module instead of calling os.getenv().

Environment variables are loaded from .env by entrypoints (rest/main.py,
worker/celery_app.py) before this module is first imported.
"""

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class ClickHouseSettings(BaseSettings):
    """ClickHouse connection settings.

    Env vars: CLICKHOUSE_HOST, CLICKHOUSE_PORT, CLICKHOUSE_NATIVE_PORT,
    CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, CLICKHOUSE_DATABASE
    """

    model_config = SettingsConfigDict(env_prefix="CLICKHOUSE_")

    host: str = "localhost"
    port: int = 8123
    native_port: int = 9000
    user: str = "clickhouse"
    password: str = "clickhouse"
    database: str = "default"


class S3Settings(BaseSettings):
    """S3/MinIO settings for trace data storage.

    Env vars: S3_ENDPOINT_URL, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
    S3_BUCKET_NAME, S3_REGION
    """

    model_config = SettingsConfigDict(env_prefix="S3_")

    endpoint_url: str | None = None
    access_key_id: str | None = None
    secret_access_key: str | None = None
    bucket_name: str = "traceroot"
    region: str = "us-east-1"


class RedisSettings(BaseSettings):
    """Redis settings for Celery broker and result backend.

    Env vars: REDIS_URL, REDIS_RESULT_URL
    """

    model_config = SettingsConfigDict(env_prefix="REDIS_")

    url: str = "redis://localhost:6379/0"
    result_url: str = "redis://localhost:6379/1"


RATE_LIMIT_PLANS: tuple[str, ...] = ("free", "starter", "pro", "enterprise")


def normalize_plan(plan: str | None) -> str:
    """Normalize a billing-plan string to a known plan, defaulting to ``free``.

    Unknown or missing plans fall back to the most restrictive tier so a
    mis-resolved plan never grants more quota than intended.
    """
    candidate = (plan or "").strip().lower()
    return candidate if candidate in RATE_LIMIT_PLANS else "free"


class RateLimitSettings(BaseSettings):
    """Tiered rate-limit settings for the public REST API.

    Two buckets (``ingest``, ``read``) across four plans. Limit values use the
    ``limits`` library format ``"<count>/<period>"`` (period: second, minute,
    hour, day). Every value is individually overridable via env, e.g.
    ``RATE_LIMIT_INGEST_PRO=30000/minute`` — which is also how the Enterprise
    tier is tuned per-deployment in v1 (no DB-backed override yet).

    Env vars: RATE_LIMIT_ENABLED, RATE_LIMIT_STORAGE_URI, and
    RATE_LIMIT_{INGEST,READ}_{FREE,STARTER,PRO,ENTERPRISE}.
    """

    model_config = SettingsConfigDict(env_prefix="RATE_LIMIT_")

    # Master kill-switch: RATE_LIMIT_ENABLED=false disables all enforcement.
    enabled: bool = True
    # Storage backend; defaults to the main Redis URL (REDIS_URL) so limits are
    # shared across REST replicas. Set "memory://" for single-process use.
    storage_uri: str | None = None

    # Ingestion bucket: POST /api/v1/public/traces (keyed per workspace).
    ingest_free: str = "1000/minute"
    ingest_starter: str = "5000/minute"
    ingest_pro: str = "20000/minute"
    ingest_enterprise: str = "100000/minute"

    # Read bucket: dashboard GET endpoints sharing one per-workspace budget.
    read_free: str = "60/minute"
    read_starter: str = "300/minute"
    read_pro: str = "1000/minute"
    read_enterprise: str = "5000/minute"

    def limit_for(self, bucket: str, plan: str) -> str:
        """Resolve the limit string for a ``(bucket, plan)`` pair.

        Falls back to the free tier for unknown plans and to the read bucket
        for unknown bucket names — both the most restrictive choice.
        """
        bucket_name = bucket if bucket in ("ingest", "read") else "read"
        return str(getattr(self, f"{bucket_name}_{normalize_plan(plan)}"))


class Settings(BaseSettings):
    """Root settings for the TraceRoot backend.

    Nested settings (clickhouse, s3, redis) each read from their own
    prefixed env vars. Top-level fields read from unprefixed env vars.
    """

    # PostgreSQL (shared with Prisma — read-only for Python)
    database_url: str = "postgresql://postgres:postgres@localhost:5432/postgres"

    # CORS
    cors_origins: list[str] = ["http://localhost:3000"]

    # Internal backend-to-web URL for server-to-server calls (e.g. validate-api-key);
    # may be a Docker-internal host like http://web:3000.
    traceroot_ui_url: str = "http://localhost:3000"
    # Host/browser-usable UI URL used in links handed to clients (whoami.ui_base_url,
    # trace_url). Falls back to NEXT_PUBLIC_APP_URL so operators need not set a second
    # var. Must NOT be a Docker-internal service URL.
    traceroot_public_ui_url: str = Field(
        "http://localhost:3000",
        validation_alias=AliasChoices("TRACEROOT_PUBLIC_UI_URL", "NEXT_PUBLIC_APP_URL"),
    )
    internal_api_secret: str = ""

    # Service-specific settings
    clickhouse: ClickHouseSettings = ClickHouseSettings()
    s3: S3Settings = S3Settings()
    redis: RedisSettings = RedisSettings()
    rate_limit: RateLimitSettings = RateLimitSettings()


settings = Settings()
