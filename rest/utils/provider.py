"""Observability utilities - Shared functions for provider management.

This module provides utilities for managing observability providers
across different drivers (telemetry, chat, etc.).
"""

from typing import Any

from fastapi import Request

from rest.service.provider import ObservabilityProvider

try:
    from rest.utils.ee.auth import get_user_credentials
except ImportError:
    from rest.utils.auth import get_user_credentials


async def get_observe_provider(
    request: Request,
    db_client,
    local_mode: bool,
    default_provider: ObservabilityProvider,
    trace_provider: str | None = None,
    log_provider: str | None = None,
    trace_region: str | None = None,
    log_region: str | None = None,
    user_email: str | None = None,
) -> ObservabilityProvider:
    """Get observability provider based on request.

    Shared utility function for retrieving the appropriate observability provider
    based on local mode, request parameters, and user configuration.

    For local mode, always returns the default Jaeger provider.
    For non-local mode, fetches provider configuration from request params and database.

    Args:
        request: FastAPI request object
        db_client: Database client (MongoDB or SQLite)
        local_mode: Whether running in local mode
        default_provider: Default provider to use in local mode
        trace_provider: Override trace provider (if None, read from query params)
        log_provider: Override log provider (if None, read from query params)
        trace_region: Override trace region (if None, read from query params)
        log_region: Override log region (if None, read from query params)
        user_email: User email for fetching provider config from DB

    Returns:
        ObservabilityProvider instance configured for the request
    """
    if local_mode:
        return default_provider

    # Extract provider parameters from request query params if not provided
    query_params = request.query_params
    if trace_provider is None:
        trace_provider = query_params.get("trace_provider", "aws")
    if log_provider is None:
        log_provider = query_params.get("log_provider", "aws")
    if trace_region is None:
        trace_region = query_params.get("trace_region")
    if log_region is None:
        log_region = query_params.get("log_region")

    # Get user email if not provided
    if user_email is None:
        user_email, _, _ = get_user_credentials(request)

    # Prepare configurations
    trace_config: dict[str, Any] = {}
    log_config: dict[str, Any] = {}

    # Configure trace provider
    if trace_provider == "tencent":
        trace_provider_config = await db_client.get_trace_provider_config(user_email)
        if trace_provider_config and trace_provider_config.get("tencentTraceConfig"):
            tencent_config = trace_provider_config["tencentTraceConfig"]
            trace_config = {
                "region": trace_region or tencent_config.get("region",
                                                             "ap-hongkong"),
                "secret_id": tencent_config.get("secretId"),
                "secret_key": tencent_config.get("secretKey"),
                "apm_instance_id": tencent_config.get("apmInstanceId"),
            }
        else:
            # Fallback to region only if no database config
            trace_config = {"region": trace_region or "ap-hongkong"}
    elif trace_provider == "aws":
        trace_config = {"region": trace_region}
    elif trace_provider == "jaeger":
        # Fetch jaeger config from database if available
        trace_provider_config = await db_client.get_trace_provider_config(user_email)
        if trace_provider_config and trace_provider_config.get("jaegerTraceConfig"):
            jaeger_config = trace_provider_config["jaegerTraceConfig"]
            trace_config = {"url": jaeger_config.get("endpoint")}
        else:
            trace_config = {}

    # Configure log provider
    if log_provider == "tencent":
        log_provider_config = await db_client.get_log_provider_config(user_email)
        if log_provider_config and log_provider_config.get("tencentLogConfig"):
            tencent_config = log_provider_config["tencentLogConfig"]
            log_config = {
                "region": log_region or tencent_config.get("region",
                                                           "ap-hongkong"),
                "secret_id": tencent_config.get("secretId"),
                "secret_key": tencent_config.get("secretKey"),
                "cls_topic_id": tencent_config.get("clsTopicId"),
            }
        else:
            # Fallback to region only if no database config
            log_config = {"region": log_region or "ap-hongkong"}
    elif log_provider == "aws":
        log_config = {"region": log_region}
    elif log_provider == "jaeger":
        # Fetch jaeger config from database if available
        log_provider_config = await db_client.get_log_provider_config(user_email)
        if log_provider_config and log_provider_config.get("jaegerLogConfig"):
            jaeger_config = log_provider_config["jaegerLogConfig"]
            log_config = {"url": jaeger_config.get("endpoint")}
        else:
            log_config = {}

    # Create and return the provider
    return ObservabilityProvider.create(
        trace_provider=trace_provider,
        log_provider=log_provider,
        trace_config=trace_config,
        log_config=log_config,
    )
