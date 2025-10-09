"""
Traces and logs tracking utility with Autumn.
"""

import logging
import os
from typing import Optional

from autumn import Autumn

logger = logging.getLogger(__name__)


class TracesAndLogsTracker:
    """Utility class for tracking traces and logs usage with Autumn."""

    def __init__(self):
        """Initialize the TracesAndLogsTracker with Autumn client."""
        self.autumn_token = os.getenv("AUTUMN_SECRET_KEY")

        if not self.autumn_token:
            logger.warning(
                "AUTUMN_SECRET_KEY not found in environment variables. "
                "Traces and logs tracking will be disabled."
            )
            self.autumn = None
        else:
            try:
                self.autumn = Autumn(token=self.autumn_token)
                logger.info("TracesAndLogsTracker initialized successfully with Autumn.")
            except Exception as e:
                logger.error(f"Failed to initialize Autumn client: {e}")
                self.autumn = None

    async def track_traces_and_logs(
        self,
        customer_id: str,
        trace_count: int,
        log_count: int,
    ) -> bool:
        """
        Track traces and logs usage for a customer.

        Args:
            customer_id: The customer identifier (user UUID/sub from JWT)
            trace_count: Number of traces in the period
            log_count: Number of logs in the period

        Returns:
            bool: True if tracking was successful, False otherwise
        """
        if not self.autumn:
            logger.warning(
                "Autumn client not available. Skipping traces and logs tracking."
            )
            return False

        if trace_count < 0 or log_count < 0:
            logger.warning(
                f"Invalid counts - traces: {trace_count}, logs: {log_count}. "
                "Skipping tracking."
            )
            return False

        try:
            # Track combined traces and logs using the single feature ID
            total_traces_and_logs = trace_count + log_count
            await self.autumn.track(
                customer_id=customer_id,
                feature_id="trace__log",
                value=total_traces_and_logs
            )

            logger.info(
                f"Successfully tracked {total_traces_and_logs} traces and logs for "
                f"customer {customer_id}: {trace_count} traces, {log_count} logs"
            )
            return True

        except Exception as e:
            logger.error(
                f"Failed to track traces and logs for customer {customer_id}: {e}"
            )
            return False

    async def check_traces_and_logs_access(self, customer_id: str) -> bool:
        """
        Check if a customer has access to generate more traces/logs.

        Args:
            customer_id: The customer identifier

        Returns:
            bool: True if customer has access, False otherwise
        """
        if not self.autumn:
            logger.warning("Autumn client not available. Allowing access by default.")
            return True

        try:
            result = await self.autumn.check(
                customer_id=customer_id,
                feature_id="trace__log"
            )

            logger.info(
                f"Traces and logs access check for customer {customer_id}: "
                f"allowed={result.allowed}"
            )
            return result.allowed

        except Exception as e:
            logger.error(
                f"Failed to check traces and logs access for customer {customer_id}: {e}"
            )
            # Default to allowing access if check fails
            return True


# Global instance
_traces_and_logs_tracker: Optional[TracesAndLogsTracker] = None


def get_traces_and_logs_tracker() -> TracesAndLogsTracker:
    """Get the global TracesAndLogsTracker instance."""
    global _traces_and_logs_tracker
    if _traces_and_logs_tracker is None:
        _traces_and_logs_tracker = TracesAndLogsTracker()
    return _traces_and_logs_tracker


async def check_user_traces_and_logs_access(user_sub: str) -> bool:
    """
    Check if a user has access to generate more traces/logs.

    Args:
        user_sub: User's UUID/sub from JWT

    Returns:
        bool: True if user has access
    """
    tracker = get_traces_and_logs_tracker()
    return await tracker.check_traces_and_logs_access(customer_id=user_sub)
