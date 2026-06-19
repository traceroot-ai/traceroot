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

# Per-plan rate limits — product decision in code, not an ops knob. Format is
# the ``limits`` library's ``"<count>/<period>"`` (period: second|minute|hour|day).
# Enterprise mirrors Pro until a real Enterprise customer lands; per-workspace
# overrides for that case will arrive as a DB-backed mechanism, not env knobs.
_PLAN_LIMITS_INGEST: dict[str, str] = {
    "free": "1000/minute",
    "starter": "5000/minute",
    "pro": "20000/minute",
    "enterprise": "20000/minute",
}
_PLAN_LIMITS_READ: dict[str, str] = {
    "free": "60/minute",
    "starter": "300/minute",
    "pro": "1000/minute",
    "enterprise": "1000/minute",
}
# Export builds and serializes a full trace bundle, so it is the heaviest read
# and gets its own, strictly tighter tier than the shared `read` budget.
_PLAN_LIMITS_EXPORT: dict[str, str] = {
    "free": "10/minute",
    "starter": "60/minute",
    "pro": "240/minute",
    "enterprise": "240/minute",
}


def normalize_plan(plan: str | None) -> str:
    """Normalize a billing-plan string to a known plan, defaulting to ``free``.

    Unknown or missing plans fall back to the most restrictive tier so a
    mis-resolved plan never grants more quota than intended.

    Args:
        plan (str | None): Raw plan string (case-insensitive, may be None).

    Returns:
        str: One of ``RATE_LIMIT_PLANS``; ``free`` when ``plan`` is missing or
            unrecognized.
    """
    candidate = (plan or "").strip().lower()
    return candidate if candidate in RATE_LIMIT_PLANS else "free"


class RateLimitSettings(BaseSettings):
    """Operational rate-limit settings for the public REST API.

    Plan tiers are a product decision and live as code constants
    (``_PLAN_LIMITS_INGEST``, ``_PLAN_LIMITS_READ``, ``_PLAN_LIMITS_EXPORT`` above)
    — not env-overridable.
    The knobs here are the operational ones an SRE legitimately needs at runtime.

    Self-host disables rate limiting entirely (the limiter is built disabled
    when billing is off — see ``rest.rate_limit``), so these knobs only take
    effect on cloud (billing-enabled) deployments.

    Env vars: RATE_LIMIT_ENABLED, RATE_LIMIT_STORAGE_URI.
    """

    model_config = SettingsConfigDict(env_prefix="RATE_LIMIT_")

    # Master kill-switch: RATE_LIMIT_ENABLED=false disables all enforcement.
    enabled: bool = True
    # Storage backend; defaults to the main Redis URL (REDIS_URL) so limits are
    # shared across REST replicas. Set "memory://" for single-process use.
    storage_uri: str | None = None

    def limit_for(self, bucket: str, plan: str) -> str:
        """Resolve the limit string for a ``(bucket, plan)`` pair.

        Falls back to the read bucket for unknown bucket names and the free
        tier for unknown plans — both the most restrictive choice.
        """
        table = {
            "ingest": _PLAN_LIMITS_INGEST,
            "export": _PLAN_LIMITS_EXPORT,
        }.get(bucket, _PLAN_LIMITS_READ)
        return table[normalize_plan(plan)]


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
