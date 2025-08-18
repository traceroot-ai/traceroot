"""Advanced rate limiting configuration with Redis support."""

import os
from typing import Callable, Optional

from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address

try:
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False


def get_user_id_key(request: Request) -> str:
    """Extract user ID from request for rate limiting."""
    # Check for user ID in headers (if using JWT or API keys)
    user_id = request.headers.get("x-user-id")
    if user_id:
        return f"user:{user_id}"

    # Check for API key
    api_key = request.headers.get("x-api-key")
    if api_key:
        return f"api_key:{api_key}"

    # Fallback to IP address
    return get_remote_address(request)


def get_api_key_key(request: Request) -> str:
    """Extract API key from request for rate limiting."""
    api_key = request.headers.get("x-api-key") or request.headers.get("authorization")
    if api_key:
        # Remove 'Bearer ' prefix if present
        if api_key.startswith("Bearer "):
            api_key = api_key[7:]
        return f"api_key:{api_key}"

    # Fallback to IP address
    return get_remote_address(request)


def create_advanced_limiter(
    redis_url: Optional[str] = None,
    key_func: Optional[Callable[[Request],
                                str]] = None
) -> Limiter:
    """Create a Limiter with advanced configuration.

    Args:
        redis_url: Redis connection URL for distributed rate limiting
        key_func: Custom function to extract rate limiting key from request

    Returns:
        Configured Limiter instance
    """
    if key_func is None:
        key_func = get_remote_address

    # Set up storage backend
    storage_uri = redis_url or os.getenv("REDIS_URL")

    if storage_uri and REDIS_AVAILABLE:
        # Use Redis for distributed rate limiting
        return Limiter(
            key_func=key_func,
            storage_uri=storage_uri,
            headers_enabled=True,  # Include rate limit in response headers
        )
    else:
        # Use in-memory storage (default)
        return Limiter(
            key_func=key_func,
            headers_enabled=True,
        )


# Example configurations
def create_ip_based_limiter(redis_url: Optional[str] = None) -> Limiter:
    """Create limiter that rate limits by IP address."""
    return create_advanced_limiter(redis_url=redis_url, key_func=get_remote_address)


def create_user_based_limiter(redis_url: Optional[str] = None) -> Limiter:
    """Create limiter that rate limits by user ID."""
    return create_advanced_limiter(redis_url=redis_url, key_func=get_user_id_key)


def create_api_key_limiter(redis_url: Optional[str] = None) -> Limiter:
    """Create limiter that rate limits by API key."""
    return create_advanced_limiter(redis_url=redis_url, key_func=get_api_key_key)


# Environment-based configuration
def get_limiter_from_env() -> Limiter:
    """Create limiter based on environment variables."""
    redis_url = os.getenv("REDIS_URL")
    rate_limit_strategy = os.getenv("RATE_LIMIT_STRATEGY", "ip").lower()

    if rate_limit_strategy == "user":
        return create_user_based_limiter(redis_url)
    elif rate_limit_strategy == "api_key":
        return create_api_key_limiter(redis_url)
    else:
        return create_ip_based_limiter(redis_url)
