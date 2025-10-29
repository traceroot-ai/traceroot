"""Cache types for different data categories."""

from enum import Enum


class CacheType(Enum):
    """Enum for different cache types to support separate backends."""

    TRACE = "trace"
    LOG = "log"
    GITHUB = "github"
    AGENT = "agent"
    CHAT = "chat"
