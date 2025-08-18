"""
Token tracking utility for LLM usage with Autumn.
"""

import logging
import os
from typing import Any, Optional

from autumn import Autumn

logger = logging.getLogger(__name__)


class TokenTracker:
    """Utility class for tracking LLM token usage with Autumn."""

    def __init__(self):
        """Initialize the TokenTracker with Autumn client."""
        self.autumn_token = os.getenv("AUTUMN_SECRET_KEY")
        if not self.autumn_token:
            logger.warning(
                "AUTUMN_SECRET_KEY not found in environment variables. "
                "Token tracking will be disabled."
            )
            self.autumn = None
        else:
            try:
                self.autumn = Autumn(token=self.autumn_token)
                logger.info("TokenTracker initialized successfully with Autumn.")
            except Exception as e:
                logger.error(f"Failed to initialize Autumn client: {e}")
                self.autumn = None

    async def track_llm_tokens(
        self,
        customer_id: str,
        token_count: int,
        model: Optional[str] = None
    ) -> bool:
        """
        Track LLM token usage for a customer.

        Args:
            customer_id: The customer identifier (user UUID/sub from JWT)
            token_count: Number of tokens consumed
            model: The LLM model used (optional, for logging)

        Returns:
            bool: True if tracking was successful, False otherwise
        """
        if not self.autumn:
            logger.warning("Autumn client not available. Skipping token tracking.")
            return False

        if token_count <= 0:
            logger.warning(f"Invalid token count: {token_count}. Skipping tracking.")
            return False

        try:
            await self.autumn.track(
                customer_id=customer_id,
                feature_id="llm_tokens",
                value=token_count
            )

            logger.info(
                f"Successfully tracked {token_count} tokens for customer "
                f"{customer_id}" + (f" using model {model}" if model else "")
            )
            return True

        except Exception as e:
            logger.error(f"Failed to track tokens for customer {customer_id}: {e}")
            return False

    async def check_token_access(self, customer_id: str) -> bool:
        """
        Check if a customer has access to use LLM tokens.

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
                feature_id="llm_tokens"
            )

            logger.info(
                f"Token access check for customer {customer_id}: "
                f"{result.allowed}"
            )
            return result.allowed

        except Exception as e:
            logger.error(f"Failed to check token access for customer {customer_id}: {e}")
            # Default to allowing access if check fails
            return True

    def extract_token_usage(self, openai_response: Any) -> int:
        """
        Extract token usage from OpenAI API response.

        Args:
            openai_response: The response object from OpenAI API

        Returns:
            int: Total tokens used, or 0 if extraction fails
        """
        try:
            if hasattr(openai_response, 'usage') and openai_response.usage:
                usage = openai_response.usage
                total_tokens = getattr(usage, 'total_tokens', 0)

                # Log detailed usage information
                prompt_tokens = getattr(usage, 'prompt_tokens', 0)
                completion_tokens = getattr(usage, 'completion_tokens', 0)

                logger.debug(
                    f"Token usage - Prompt: {prompt_tokens}, "
                    f"Completion: {completion_tokens}, Total: {total_tokens}"
                )

                return total_tokens
            else:
                logger.warning("No usage information found in OpenAI response")
                return 0

        except Exception as e:
            logger.error(f"Failed to extract token usage: {e}")
            return 0


# Global instance
_token_tracker: Optional[TokenTracker] = None


def get_token_tracker() -> TokenTracker:
    """Get the global TokenTracker instance."""
    global _token_tracker
    if _token_tracker is None:
        _token_tracker = TokenTracker()
    return _token_tracker


async def track_tokens_for_user(
    user_sub: str,
    openai_response: Any,
    model: Optional[str] = None
) -> bool:
    """
    Convenience function to track tokens for a user.

    Args:
        user_sub: User's UUID/sub from JWT (used as customer_id)
        openai_response: OpenAI API response object
        model: Model name used for the request

    Returns:
        bool: True if tracking was successful
    """
    tracker = get_token_tracker()
    token_count = tracker.extract_token_usage(openai_response)

    if token_count > 0:
        return await tracker.track_llm_tokens(
            customer_id=user_sub,
            token_count=token_count,
            model=model
        )

    return False


async def check_user_token_access(user_sub: str) -> bool:
    """
    Check if a user has access to use LLM tokens.

    Args:
        user_sub: User's UUID/sub from JWT

    Returns:
        bool: True if user has access
    """
    tracker = get_token_tracker()
    return await tracker.check_token_access(customer_id=user_sub)
