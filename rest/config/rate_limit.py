"""Rate limiting configuration for TraceRoot API."""

from dataclasses import dataclass
from typing import Optional


@dataclass
class RateLimitConfig:
    """Configuration for rate limiting."""

    # Per-endpoint limits (requests per time period)
    list_traces_limit: str = "360/minute"
    get_logs_limit: str = "240/minute"
    post_chat_limit: str = "30/minute"
    get_chat_metadata_history_limit: str = "360/minute"
    get_chat_metadata_limit: str = "120/minute"
    get_chat_history_limit: str = "120/minute"
    get_line_context_content_limit: str = "240/minute"
    post_integrate_limit: str = "20/minute"
    get_integrate_limit: str = "60/minute"
    delete_integrate_limit: str = "20/minute"
    # TODO: Improve this
    get_verify_credentials_limit: str = "7200/minute"

    # Global defaults
    default_limit: str = "120/minute"

    # Storage backend (optional - defaults to in-memory)
    redis_url: Optional[str] = None

    # Custom key function options
    use_user_id: bool = False  # If True, rate limit per user instead of IP
    use_api_key: bool = False  # If True, rate limit per API key


# Default configuration
DEFAULT_RATE_LIMIT_CONFIG = RateLimitConfig()


def get_rate_limit_config() -> RateLimitConfig:
    """Get rate limit configuration."""
    # You can extend this to load from environment variables or config files
    return DEFAULT_RATE_LIMIT_CONFIG
