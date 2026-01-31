"""PostgreSQL database module."""

from db.postgres.engine import close_db, get_session, init_db
from db.postgres.models import (
    ApiKeyModel,
    Base,
)
from db.postgres.api_key import (
    ApiKey,
    ApiKeyWithSecret,
    create_api_key,
    delete_api_key,
    get_api_key_by_hash,
    get_api_key_by_id,
    list_api_keys_by_project,
    update_api_key,
    update_api_key_last_used,
    delete_api_keys_by_project,
)

__all__ = [
    # Engine
    "get_session",
    "init_db",
    "close_db",
    # Models
    "Base",
    "ApiKeyModel",
    # API Key functions
    "ApiKey",
    "ApiKeyWithSecret",
    "create_api_key",
    "delete_api_key",
    "get_api_key_by_hash",
    "get_api_key_by_id",
    "list_api_keys_by_project",
    "delete_api_keys_by_project",
    "update_api_key",
    "update_api_key_last_used",
]
