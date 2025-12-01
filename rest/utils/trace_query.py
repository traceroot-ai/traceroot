"""Query utilities for trace filtering and response formatting.

This module provides utilities for processing trace query filters and formatting
trace responses. It handles the separation of special filter categories that
require different handling in trace providers.

Filter Category Types:
    Special Categories (extracted separately):
        - service_name: Service name filters
        - service_environment: Service environment filters
        - log: Log content search filters

    Regular Categories (passed through):
        - status: HTTP status code filters
        - error: Error type filters
        - custom annotations: Any other user-defined filters

The separation is necessary because:
- service_name and service_environment have provider-specific query optimizations
- log filters require querying CloudWatch/log systems first
- Regular filters can be applied directly to trace data
"""

from dataclasses import dataclass
from typing import Any

from rest.config import ListTraceResponse, Trace
from rest.rest_types import Operation


@dataclass
class FilterCategories:
    """Separated filter categories for trace queries.

    This dataclass organizes filter parameters into categories that need
    different handling by trace providers. The separation enables:
    - Optimized queries for service_name/service_environment in AWS X-Ray
    - Special log search flow that queries logs first
    - Standard filtering for all other categories

    Attributes:
        service_name_values: Service name filter values (e.g., ['api-service'])
        service_name_operations: Operations for service names (e.g., [Operation.EQ])
        service_environment_values: Environment filter values (e.g., ['production'])
        service_environment_operations: Operations for environments
        log_search_values: Log content search terms (e.g., ['error'])
        log_search_operations: Operations for log search
        remaining_categories: All other filter categories
        remaining_values: Values for remaining categories
        remaining_operations: Operations for remaining categories

    Example:
        >>> filter_cats = FilterCategories(
        ...     service_name_values=['api-service'],
        ...     service_name_operations=[Operation.EQ],
        ...     service_environment_values=['production'],
        ...     service_environment_operations=[Operation.EQ],
        ...     log_search_values=[],
        ...     log_search_operations=[],
        ...     remaining_categories=['status'],
        ...     remaining_values=['500'],
        ...     remaining_operations=[Operation.EQ]
        ... )
        >>> filter_cats.has_log_search
        False
    """

    # Special categories that need separate handling
    service_name_values: list[str]
    service_name_operations: list[Operation]
    service_environment_values: list[str]
    service_environment_operations: list[Operation]
    log_search_values: list[str]
    log_search_operations: list[Operation]

    # Remaining categories for normal filtering
    remaining_categories: list[str]
    remaining_values: list[str]
    remaining_operations: list[Operation]

    @property
    def has_log_search(self) -> bool:
        """Check if log search is active.

        Returns:
            True if there are log search values, False otherwise

        Example:
            >>> filter_cats = FilterCategories(
            ...     service_name_values=[],
            ...     service_name_operations=[],
            ...     service_environment_values=[],
            ...     service_environment_operations=[],
            ...     log_search_values=['error'],
            ...     log_search_operations=[Operation.EQ],
            ...     remaining_categories=[],
            ...     remaining_values=[],
            ...     remaining_operations=[]
            ... )
            >>> filter_cats.has_log_search
            True
        """
        return len(self.log_search_values) > 0


def separate_filter_categories(
    categories: list[str],
    values: list[str],
    operations: list[str],
) -> FilterCategories:
    """Separate special filter categories from regular ones.

    Processes the parallel arrays of categories, values, and operations,
    separating out special categories (service_name, service_environment, log)
    that need different handling. This enables:
    - AWS X-Ray optimized queries for service filters
    - CloudWatch Logs search for log content filters
    - Standard trace filtering for everything else

    Args:
        categories: List of category names (e.g., ['service_name', 'status'])
        values: List of filter values (e.g., ['api-service', '500'])
        operations: List of operation strings (e.g., ['=', '!='])

    Returns:
        FilterCategories with separated special and remaining categories

    Note:
        Categories without corresponding values/operations are added to
        remaining_categories with empty values. Operations are converted
        to Operation enum types.

    Example:
        >>> filter_cats = separate_filter_categories(
        ...     categories=['service_name', 'status', 'log'],
        ...     values=['api-service', '500', 'error'],
        ...     operations=['=', '=', 'contains']
        ... )
        >>> filter_cats.service_name_values
        ['api-service']
        >>> filter_cats.log_search_values
        ['error']
        >>> filter_cats.remaining_categories
        ['status']
        >>> filter_cats.remaining_values
        ['500']

    Raises:
        ValueError: If operation string is not a valid Operation enum value
    """
    # Initialize storage for special categories
    service_name_values = []
    service_name_operations = []
    service_environment_values = []
    service_environment_operations = []
    log_search_values = []
    log_search_operations = []

    # Initialize storage for remaining categories
    remaining_categories = []
    remaining_values = []
    remaining_operations = []

    # Process each category/value/operation triplet
    for i, category in enumerate(categories):
        # Handle categories without corresponding values/operations
        if i >= len(values) or i >= len(operations):
            remaining_categories.append(category)
            continue

        value = values[i]
        operation = operations[i]

        # Route to appropriate list based on category type
        if category == "service_name":
            service_name_values.append(value)
            service_name_operations.append(Operation(operation))
        elif category == "service_environment":
            service_environment_values.append(value)
            service_environment_operations.append(Operation(operation))
        elif category == "log":
            log_search_values.append(value)
            log_search_operations.append(Operation(operation))
        else:
            # Keep all other categories for normal filtering
            remaining_categories.append(category)
            remaining_values.append(value)
            remaining_operations.append(Operation(operation))

    return FilterCategories(
        service_name_values=service_name_values,
        service_name_operations=service_name_operations,
        service_environment_values=service_environment_values,
        service_environment_operations=service_environment_operations,
        log_search_values=log_search_values,
        log_search_operations=log_search_operations,
        remaining_categories=remaining_categories,
        remaining_values=remaining_values,
        remaining_operations=remaining_operations,
    )


class TraceQueryHelper:
    """Helper for building trace query responses.

    This helper provides utilities for formatting trace query results into
    standardized API responses. It handles:
    - Response formatting with pagination tokens
    - Consistent structure across different query types
    - Proper serialization to dict format

    Usage:
        >>> traces = [trace1, trace2, trace3]
        >>> next_token = 'eyJwcm92aWRlciI6ImF3cyJ9'
        >>> response = TraceQueryHelper.format_response(traces, next_token)
        >>> response
        {
            'traces': [...],
            'next_pagination_token': 'eyJwcm92aWRlciI6ImF3cyJ9',
            'has_more': True
        }
    """

    @staticmethod
    def format_response(
        traces: list[Trace],
        next_pagination_token: str | None = None,
    ) -> dict[str,
              Any]:
        """Format traces into ListTraceResponse dict.

        Creates a standardized trace response with pagination information.
        The response includes the traces, pagination token for the next page,
        and a boolean indicating if more results are available.

        Args:
            traces: List of Trace objects to include in response
            next_pagination_token: Encoded token for next page, or None if last page

        Returns:
            Dictionary conforming to ListTraceResponse schema
            - traces: List of trace data
            - next_pagination_token: Token string or None
            - has_more: True if next_pagination_token is not None

        Example:
            >>> traces = [trace1, trace2]
            >>> token = 'abc123'
            >>> response = TraceQueryHelper.format_response(traces, token)
            >>> response['has_more']
            True
            >>> len(response['traces'])
            2

            # Last page example
            >>> response = TraceQueryHelper.format_response(traces, None)
            >>> response['has_more']
            False
            >>> response['next_pagination_token'] is None
            True
        """
        resp = ListTraceResponse(
            traces=traces,
            next_pagination_token=next_pagination_token,
            has_more=next_pagination_token is not None
        )
        return resp.model_dump()
