"""
Traces and logs tracking utility with Autumn.
"""

import logging
import os
from datetime import datetime, timezone
from typing import Any, Optional

from autumn import Autumn

from rest.config.trace import Trace

try:
    from rest.utils.ee.auth import hash_user_sub
except ImportError:
    from rest.utils.auth import hash_user_sub

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
                logger.info(
                    "TracesAndLogsTracker initialized successfully with "
                    "Autumn."
                )
            except Exception as e:
                logger.error(f"Failed to initialize Autumn client: {e}")
                self.autumn = None

    async def track_traces_and_logs(
        self,
        customer_id: str,
        trace_count: int,
        log_count: int,
        period_days: Optional[int] = None
    ) -> bool:
        """
        Track traces and logs usage for a customer.

        Args:
            customer_id: The customer identifier (user UUID/sub from JWT)
            trace_count: Number of traces in the period
            log_count: Number of logs in the period
            period_days: Days since last payment/onboarding
                (optional, for logging)

        Returns:
            bool: True if tracking was successful, False otherwise
        """
        if not self.autumn:
            logger.warning(
                "Autumn client not available. Skipping traces and logs "
                "tracking."
            )
            return False

        if trace_count < 0 or log_count < 0:
            logger.warning(
                f"Invalid counts - traces: {trace_count}, logs: {log_count}. "
                "Skipping tracking."
            )
            return False

        try:
            # Track combined traces and logs using the single feature ID that
            # exists in Autumn
            total_traces_and_logs = trace_count + log_count
            await self.autumn.track(
                customer_id=customer_id,
                feature_id="trace__log",
                value=total_traces_and_logs
            )

            logger.info(
                f"Successfully tracked traces and logs for customer "
                f"{customer_id}: "
                f"{trace_count} traces, {log_count} logs, "
                f"{total_traces_and_logs} total items" +
                (f" over {period_days} days" if period_days else "")
            )
            return True

        except Exception as e:
            logger.error(
                f"Failed to track traces and logs for customer "
                f"{customer_id}: {e}"
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
            # Check access for the single trace__log feature
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
                f"Failed to check traces and logs access for customer "
                f"{customer_id}: {e}"
            )
            # Default to allowing access if check fails
            return True

    async def set_traces_and_logs_usage(self, customer_id: str, value: int) -> bool:
        """
        Set the traces and logs usage directly in Autumn.

        Args:
            customer_id: The customer identifier
            value: The total number of traces and logs

        Returns:
            bool: True if setting usage was successful
        """
        if not self.autumn:
            logger.warning("Autumn client not available. Skipping usage update.")
            return False

        try:
            await self.autumn.features.set_usage(
                customer_id=customer_id,
                feature_id='trace__log',
                value=value,
            )

            logger.info(
                f"Successfully set traces and logs usage for customer "
                f"{customer_id} to {value}"
            )
            return True

        except Exception as e:
            logger.error(
                f"Failed to set traces and logs usage for customer "
                f"{customer_id}: {e}"
            )
            return False

    def extract_traces_and_logs_from_traces(self, traces: list[Trace]) -> tuple[int, int]:
        """
        Extract trace and log counts from a list of traces.

        Args:
            traces: List of Trace objects

        Returns:
            tuple: (trace_count, total_log_count)
        """
        try:
            trace_count = len(traces)
            total_log_count = 0

            for trace in traces:
                # Sum all log types for this trace
                trace_logs = (
                    (trace.num_debug_logs or 0) + (trace.num_info_logs or 0) +
                    (trace.num_warning_logs or 0) + (trace.num_error_logs or 0) +
                    (trace.num_critical_logs or 0)
                )
                total_log_count += trace_logs

            logger.debug(
                f"Extracted traces and logs - Traces: {trace_count}, "
                f"Logs: {total_log_count}"
            )

            return trace_count, total_log_count

        except Exception as e:
            logger.error(f"Failed to extract traces and logs from traces: {e}")
            return 0, 0

    async def get_customer_traces_and_logs_since_date(
        self,
        customer_id: str,
        since_date: datetime,
        observe_client: Any
    ) -> tuple[int,
               int]:
        """
        Get customer's traces and logs since a specific date.

        Args:
            customer_id: The customer identifier
            since_date: The start date to count from (e.g., last payment date)
            observe_client: The AWS or Jaeger client to query traces

        Returns:
            tuple: (trace_count, total_log_count)
        """
        try:
            log_group_name = hash_user_sub(customer_id)
            end_time = datetime.now(timezone.utc)

            # Get all traces since the specified date
            traces = await observe_client.get_recent_traces(
                start_time=since_date,
                end_time=end_time,
                log_group_name=log_group_name,
            )

            trace_count, log_count = self.extract_traces_and_logs_from_traces(traces)

            return trace_count, log_count

        except Exception as e:
            logger.error(
                f"Failed to get traces and logs for customer {customer_id} "
                f"since {since_date}: {e}"
            )
            return 0, 0


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


async def get_user_traces_and_logs_since_payment(
    user_sub: str,
    last_payment_date: datetime,
    observe_client: Any
) -> dict[str,
          Any]:
    """
    Get comprehensive traces and logs data for a user since their last payment.

    Args:
        user_sub: User's UUID/sub from JWT
        last_payment_date: Date of last payment or onboarding
        observe_client: AWS or Jaeger client instance

    Returns:
        dict: Traces and logs statistics including counts and period info
    """
    tracker = get_traces_and_logs_tracker()

    try:
        trace_count, log_count = (
            await tracker.get_customer_traces_and_logs_since_date(
                customer_id=user_sub,
                since_date=last_payment_date,
                observe_client=observe_client,
            ))

        end_time = datetime.now(timezone.utc)
        days_since_payment = (end_time - last_payment_date).days

        return {
            "customer_id": user_sub,
            "last_payment_date": last_payment_date.isoformat(),
            "current_date": end_time.isoformat(),
            "days_since_payment": days_since_payment,
            "trace_count": trace_count,
            "log_count": log_count,
            "trace__log": trace_count + log_count,
            "period_start": last_payment_date.isoformat(),
            "period_end": end_time.isoformat()
        }

    except Exception as e:
        logger.error(f"Failed to get traces and logs since payment for {user_sub}: {e}")
        return {
            "customer_id": user_sub,
            "error": str(e),
            "trace_count": 0,
            "log_count": 0,
            "trace__log": 0
        }
