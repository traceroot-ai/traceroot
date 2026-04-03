"""Centralized configuration for the Traceroot backend.

All environment variables are read once at import time via Pydantic Settings.
Services import ``settings`` from this module instead of calling os.getenv().

Environment variables are loaded from .env by entrypoints (rest/main.py,
worker/celery_app.py) before this module is first imported.
"""

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


class RateLimitSettings(BaseSettings):
    """Rate limiting settings for the REST API.

    Env vars: RATE_LIMIT_ENABLED, RATE_LIMIT_INGESTION, RATE_LIMIT_API,
    RATE_LIMIT_STORAGE_URI

    Limits use the ``limits`` library format: "<count>/<period>"
    where period is one of: second, minute, hour, day.

    Examples: "100/minute", "1000/hour", "10/second"

    The storage URI defaults to the main Redis URL (REDIS_URL).
    Set RATE_LIMIT_STORAGE_URI to use a dedicated Redis instance or DB.
    """

    model_config = SettingsConfigDict(env_prefix="RATE_LIMIT_")

    enabled: bool = True
    # Public SDK ingestion endpoint — rate-limited per API key
    ingestion: str = "100/minute"
    # Authenticated dashboard API — rate-limited per user ID
    api: str = "300/minute"
    # Override storage backend (defaults to REDIS_URL when unset)
    storage_uri: str | None = None


class Settings(BaseSettings):
    """Root settings for the Traceroot backend.

    Nested settings (clickhouse, s3, redis) each read from their own
    prefixed env vars. Top-level fields read from unprefixed env vars.
    """

    # PostgreSQL (shared with Prisma — read-only for Python)
    database_url: str = "postgresql://postgres:postgres@localhost:5432/postgres"

    # CORS
    cors_origins: list[str] = ["http://localhost:3000"]

    # Internal communication (Python <-> Next.js)
    traceroot_ui_url: str = "http://localhost:3000"
    internal_api_secret: str = ""

    # Service-specific settings
    clickhouse: ClickHouseSettings = ClickHouseSettings()
    s3: S3Settings = S3Settings()
    redis: RedisSettings = RedisSettings()
    rate_limit: RateLimitSettings = RateLimitSettings()


settings = Settings()
