"""Pagination utilities for trace queries.

This module provides utilities for encoding/decoding pagination tokens and
managing pagination state across different trace providers (AWS, Tencent)
and query types (direct traces, log search).

## Pagination Strategies Explained

Different trace providers and query types use different pagination strategies
based on their underlying API capabilities and constraints.

### 1. AWS X-Ray Pagination (Chunked Time Windows + NextToken)

**Why:** AWS X-Ray has a maximum time range per query (~1 day). For larger
ranges, we split the query into time chunks.

**Strategy:**
- Split large time ranges into chunks (1400 minutes each)
- Within each chunk, AWS returns a NextToken for continuation
- Process chunk by chunk, using NextToken within each chunk

**State Structure:**
```python
{
    'provider': 'aws',
    'chunk_index': 0,       # Which time chunk (0, 1, 2, ...)
    'next_token': 'ABC123'  # AWS X-Ray NextToken (optional)
}
```

**Flow Example (7-day query):**
```
Request 1: Query chunk 0 (day 0-1) → Returns 50 traces + NextToken
Request 2: Query chunk 0 with NextToken → Returns 50 traces + NextToken
Request 3: Query chunk 0 with NextToken → Returns 50 traces (no more in chunk 0)
Request 4: Query chunk 1 (day 1-2) → Returns 50 traces + NextToken
... continues through all chunks
```

### 2. Tencent APM Pagination (Timestamp-Based Exclusion)

**Why:** Tencent APM doesn't provide continuation tokens. Instead, we use
timestamp-based pagination to exclude already-seen traces.

**Strategy:**
- Order traces by start_time descending (newest first)
- Track the last (oldest) span start time we returned
- Next query excludes everything after that timestamp

**State Structure:**
```python
{
    'provider': 'tencent',
    'last_span_start_time': 1234567890  # Microseconds since epoch
}
```

**Flow Example:**
```
Request 1: Query traces → Returns 50 traces (newest: 1000, oldest: 900)
           Save last_span_start_time = 900
Request 2: Query traces where start_time < 900 → Returns 50 traces
           (newest: 899, oldest: 800) Save last_span_start_time = 800
Request 3: Query traces where start_time < 800 → Returns next batch
... continues until no more traces
```

### 3. Log Search Pagination (Cache-Based Offset)

**Why:** Log searches query CloudWatch Logs first (expensive), then fetch traces.
To avoid re-querying logs on every page, we cache ALL trace IDs upfront.

**Strategy:**
- First request: Query logs for ALL matching trace IDs → cache them
- Subsequent requests: Paginate through cached trace ID list (cheap)
- Each page fetches a batch of traces using the cached IDs

**State Structure:**
```python
{
    'type': 'log_search',
    'provider': 'aws',           # Trace provider for fetching traces
    'offset': 0,                 # Current position in cached ID list
    'search_term': 'error',      # Search term (for validation)
    'cache_key': 'log_search_...' # Where trace IDs are cached
}
```

**Flow Example (100 matching traces):**
```
Request 1: Query logs → Get 100 trace IDs → Cache them
           Fetch traces for IDs[0:50] → Return 50 traces
           Save offset = 50
Request 2: Get cached trace IDs → Already have them
           Fetch traces for IDs[50:100] → Return 50 traces
           Save offset = 100
Request 3: offset >= len(IDs) → No more pages
```

## Key Differences Summary

| Provider | Stateful? | Expensive? | Strategy |
|----------|-----------|------------|----------|
| AWS      | Yes       | Medium     | Time chunks + continuation token |
| Tencent  | Yes       | Medium     | Timestamp-based exclusion |
| Log Search | Yes     | High (first request) | Cache all IDs, then paginate |

**Stateful:** Next page depends on previous results (can't jump to arbitrary page)
**Expensive:** How costly it is to re-query from scratch
"""

import base64
import json
from typing import Any, Literal

from fastapi import HTTPException

# Type alias for pagination types
PaginationType = Literal['aws', 'tencent', 'log_search']


def _encode_pagination_token(state: dict[str, Any]) -> str:
    """Encode pagination state into URL-safe opaque token (private).

    This is a private implementation detail. Use PaginationHelper.encode() instead.

    Args:
        state: Dictionary containing pagination state

    Returns:
        Base64-encoded URL-safe string token
    """
    json_str = json.dumps(state, sort_keys=True)
    return base64.urlsafe_b64encode(json_str.encode('utf-8')).decode('utf-8')


def _decode_pagination_token(token: str) -> dict[str, Any]:
    """Decode pagination token back to state dictionary (private).

    This is a private implementation detail. Use PaginationHelper.decode() instead.

    Args:
        token: Base64-encoded pagination token string

    Returns:
        Dictionary containing pagination state

    Raises:
        ValueError: If token is invalid or cannot be decoded
    """
    try:
        json_str = base64.urlsafe_b64decode(token.encode('utf-8')).decode('utf-8')
        return json.loads(json_str)
    except (ValueError, json.JSONDecodeError) as e:
        raise ValueError(f"Invalid pagination token: {e}")


class PaginationHelper:
    """Universal pagination helper for all trace queries.

    This helper provides type-safe utilities for working with pagination tokens
    and state across different trace providers and query types. It handles:
    - Token encoding/decoding with proper error handling
    - Type detection and validation
    - Factory methods for creating pagination states
    - Type-safe state inspection

    Usage:
        # Encoding pagination state
        >>> state = PaginationHelper.create_aws_state(chunk_index=0, next_token='ABC')
        >>> token = PaginationHelper.encode(state)

        # Decoding pagination token
        >>> state = PaginationHelper.decode(token)  # Raises HTTPException on error
        >>> if PaginationHelper.is_log_search(state):
        ...     print("This is log search pagination")

        # Creating pagination states
        >>> aws_state = PaginationHelper.create_aws_state(0, 'token123')
        >>> tencent_state = PaginationHelper.create_tencent_state(1234567890)
        >>> log_state = PaginationHelper.create_log_search_state(50, 'error', 'cache_key')
    """

    @staticmethod
    def encode(state: dict | None) -> str | None:
        """Encode pagination state to URL-safe token.

        Public API for encoding pagination state. This is the recommended way
        to encode pagination tokens instead of using the private function directly.

        Args:
            state: Pagination state dict or None

        Returns:
            Base64-encoded token string, or None if state is None

        Example:
            >>> state = {'provider': 'aws', 'next_token': 'ABC'}
            >>> token = PaginationHelper.encode(state)
            >>> token
            'eyJuZXh0X3Rva2VuIjoiQUJDIiwicHJvdmlkZXIiOiJhd3MifQ=='
        """
        if not state:
            return None
        return _encode_pagination_token(state)

    @staticmethod
    def decode(token: str | None) -> dict | None:
        """Decode pagination token with HTTP error handling.

        Public API for decoding pagination tokens. This is the recommended way
        to decode tokens instead of using the private function directly.

        This method automatically converts ValueError to HTTPException for proper
        API error responses, making it safe to use in request handlers.

        Args:
            token: Pagination token string or None

        Returns:
            Decoded pagination state dict, or None if token is None

        Raises:
            HTTPException: 400 error if token is invalid

        Example:
            >>> token = 'eyJwcm92aWRlciI6ImF3cyJ9'
            >>> state = PaginationHelper.decode(token)
            >>> state
            {'provider': 'aws'}
        """
        if not token:
            return None

        try:
            return _decode_pagination_token(token)
        except ValueError as e:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid pagination token: {str(e)}"
            )

    @staticmethod
    def get_type(state: dict | None) -> PaginationType | None:
        """Get pagination type from state.

        Determines the pagination type by inspecting the state structure:
        - Log search has 'type' field set to 'log_search'
        - Trace providers have 'provider' field ('aws' or 'tencent')

        Args:
            state: Pagination state dict

        Returns:
            Pagination type: 'aws', 'tencent', 'log_search', or None

        Example:
            >>> state = {'type': 'log_search', 'offset': 0}
            >>> PaginationHelper.get_type(state)
            'log_search'
            >>> state = {'provider': 'aws', 'chunk_index': 0}
            >>> PaginationHelper.get_type(state)
            'aws'
        """
        if not state:
            return None

        # Log search has 'type' field
        if state.get('type') == 'log_search':
            return 'log_search'

        # Trace providers have 'provider' field
        return state.get('provider')

    @staticmethod
    def is_log_search(state: dict | None) -> bool:
        """Check if pagination is for log search.

        Args:
            state: Pagination state dict

        Returns:
            True if log search pagination, False otherwise

        Example:
            >>> state = {'type': 'log_search', 'offset': 50}
            >>> PaginationHelper.is_log_search(state)
            True
            >>> state = {'provider': 'aws', 'chunk_index': 0}
            >>> PaginationHelper.is_log_search(state)
            False
        """
        return PaginationHelper.get_type(state) == 'log_search'

    @staticmethod
    def create_aws_state(chunk_index: int, next_token: str | None = None) -> dict:
        """Create AWS X-Ray pagination state.

        AWS pagination uses:
        - chunk_index: For splitting large time ranges into chunks
        - next_token: AWS X-Ray API's NextToken for continuation

        Args:
            chunk_index: Current time chunk index (0-based)
            next_token: AWS X-Ray NextToken, None if no more pages in chunk

        Returns:
            AWS pagination state dict

        Example:
            >>> state = PaginationHelper.create_aws_state(0, 'abc123')
            >>> state
            {'provider': 'aws', 'chunk_index': 0, 'next_token': 'abc123'}
        """
        return {'provider': 'aws', 'chunk_index': chunk_index, 'next_token': next_token}

    @staticmethod
    def create_tencent_state(last_span_start_time: int) -> dict:
        """Create Tencent APM pagination state.

        Tencent pagination uses timestamp-based continuation, tracking the
        last span start time to exclude already-fetched traces.

        Args:
            last_span_start_time: Last span start time in microseconds

        Returns:
            Tencent pagination state dict

        Example:
            >>> state = PaginationHelper.create_tencent_state(1234567890)
            >>> state
            {'provider': 'tencent', 'last_span_start_time': 1234567890}
        """
        return {'provider': 'tencent', 'last_span_start_time': last_span_start_time}

    @staticmethod
    def create_log_search_state(
        offset: int,
        search_term: str,
        cache_key: str,
        provider: str = 'aws'
    ) -> dict:
        """Create log search pagination state.

        Log search pagination works differently from direct trace queries:
        1. First request queries logs for ALL matching trace IDs and caches them
        2. Subsequent requests paginate through the cached trace ID list
        3. Each request fetches a batch of traces from the cached IDs

        Args:
            offset: Current offset in the cached trace ID list
            search_term: Log search term (for cache invalidation detection)
            cache_key: Cache key where trace IDs are stored
            provider: Underlying trace provider ('aws' or 'tencent')

        Returns:
            Log search pagination state dict

        Example:
            >>> state = PaginationHelper.create_log_search_state(
            ...     offset=50,
            ...     search_term='error',
            ...     cache_key='log_search_trace_ids:abc123'
            ... )
            >>> state
            {
                'type': 'log_search',
                'provider': 'aws',
                'offset': 50,
                'search_term': 'error',
                'cache_key': 'log_search_trace_ids:abc123'
            }
        """
        return {
            'type': 'log_search',
            'provider': provider,
            'offset': offset,
            'search_term': search_term,
            'cache_key': cache_key
        }

    @staticmethod
    def validate_state(state: dict | None) -> bool:
        """Validate pagination state structure.

        Checks that the pagination state has all required fields for its type:
        - AWS: requires 'chunk_index'
        - Tencent: requires 'last_span_start_time'
        - Log search: requires 'offset' and 'search_term'

        Args:
            state: Pagination state dict to validate

        Returns:
            True if valid structure, False otherwise

        Example:
            >>> aws_state = {'provider': 'aws', 'chunk_index': 0}
            >>> PaginationHelper.validate_state(aws_state)
            True
            >>> invalid_state = {'provider': 'aws'}  # Missing chunk_index
            >>> PaginationHelper.validate_state(invalid_state)
            False
        """
        if not state:
            return True  # None is valid (first page)

        # Must have either 'type' or 'provider' to determine pagination type
        if 'type' not in state and 'provider' not in state:
            return False

        # Validate based on pagination type
        pagination_type = PaginationHelper.get_type(state)

        if pagination_type == 'aws':
            return 'chunk_index' in state
        elif pagination_type == 'tencent':
            return 'last_span_start_time' in state
        elif pagination_type == 'log_search':
            return all(k in state for k in ['offset', 'search_term'])

        return False
