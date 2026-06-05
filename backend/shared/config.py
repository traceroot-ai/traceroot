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


settings = Settings()
