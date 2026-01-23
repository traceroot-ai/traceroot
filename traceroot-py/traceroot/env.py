"""Environment variable definitions for Traceroot SDK.

This module defines all environment variables used to configure the Traceroot SDK.
Each variable includes documentation on its purpose, expected values, and defaults.

Usage:
    import os
    from traceroot.env import TRACEROOT_API_KEY

    api_key = os.environ.get(TRACEROOT_API_KEY)
"""

# =============================================================================
# Authentication
# =============================================================================

TRACEROOT_API_KEY = "TRACEROOT_API_KEY"
"""
.. envvar:: TRACEROOT_API_KEY

API key for authenticating with the Traceroot backend.
Required for sending traces to Traceroot.

**Example:** ``tr_abc123...``
"""

# =============================================================================
# Connection
# =============================================================================

TRACEROOT_HOST_URL = "TRACEROOT_HOST_URL"
"""
.. envvar:: TRACEROOT_HOST_URL

Base URL of the Traceroot API endpoint.

**Default:** ``https://api.traceroot.ai``
"""

TRACEROOT_TIMEOUT = "TRACEROOT_TIMEOUT"
"""
.. envvar:: TRACEROOT_TIMEOUT

HTTP request timeout in seconds for API calls.

**Default:** ``30``
"""

# =============================================================================
# Batching & Flushing
# =============================================================================

TRACEROOT_FLUSH_AT = "TRACEROOT_FLUSH_AT"
"""
.. envvar:: TRACEROOT_FLUSH_AT

Maximum number of spans in a batch before triggering a flush.
Higher values reduce HTTP overhead but increase memory usage.

**Default:** ``100``
"""

TRACEROOT_FLUSH_INTERVAL = "TRACEROOT_FLUSH_INTERVAL"
"""
.. envvar:: TRACEROOT_FLUSH_INTERVAL

Maximum delay in seconds between automatic flushes.
Lower values provide faster data visibility but increase HTTP overhead.

**Default:** ``5.0``
"""

# =============================================================================
# Feature Flags
# =============================================================================

TRACEROOT_ENABLED = "TRACEROOT_ENABLED"
"""
.. envvar:: TRACEROOT_ENABLED

Enable or disable the Traceroot SDK. When disabled, all tracing calls become no-ops.
Accepts: "true", "false", "1", "0", "yes", "no", "on", "off" (case-insensitive)

**Default:** ``true``
"""

TRACEROOT_DEBUG = "TRACEROOT_DEBUG"
"""
.. envvar:: TRACEROOT_DEBUG

Enable debug mode for verbose logging.
Useful for troubleshooting SDK issues.

**Default:** ``false``
"""

# =============================================================================
# Tracing Context
# =============================================================================

TRACEROOT_ENVIRONMENT = "TRACEROOT_ENVIRONMENT"
"""
.. envvar:: TRACEROOT_ENVIRONMENT

Deployment environment name (e.g., "production", "staging", "development").
Used for filtering and grouping traces in the Traceroot UI.

**Default:** ``default``
"""

TRACEROOT_RELEASE = "TRACEROOT_RELEASE"
"""
.. envvar:: TRACEROOT_RELEASE

Release version or commit hash of the application.
Useful for tracking traces across deployments.

**Example:** ``v1.2.3`` or ``abc123def``
"""

TRACEROOT_SERVICE_NAME = "TRACEROOT_SERVICE_NAME"
"""
.. envvar:: TRACEROOT_SERVICE_NAME

Name of the service generating traces.
Used for identifying the source of traces in multi-service architectures.

**Default:** ``unknown_service``
"""
