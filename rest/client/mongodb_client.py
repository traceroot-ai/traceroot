from typing import Any, Optional

from rest.config import (ChatMetadata, ChatMetadataHistory, PaymentRecord,
                         UserSubscription, WorkflowCheckbox)


class TraceRootMongoDBClient:

    def __init__(self):
        pass

    async def get_chat_history(
        self,
        chat_id: str | None = None,
    ) -> list[dict] | None:
        pass

    async def insert_chat_record(self, message: dict[str, Any]):
        pass

    async def get_chat_metadata_history(
        self,
        trace_id: str | None = None,
    ) -> ChatMetadataHistory | None:
        pass

    async def get_chat_metadata(self, chat_id: str) -> ChatMetadata | None:
        """Get chat metadata by chat_id.

        Args:
            chat_id: The chat ID to look up

        Returns:
            ChatMetadata object if found, None otherwise
        """

    async def insert_chat_metadata(self, metadata: dict[str, Any]):
        pass

    async def insert_integration_token(
        self,
        user_email: str,
        token: str,
        token_type: str,
    ) -> bool:
        pass

    async def get_integration_token(
        self,
        user_email: str,
        token_type: str,
    ) -> str | None:
        pass

    async def delete_integration_token(
        self,
        user_email: str,
        token_type: str,
    ) -> bool:
        pass

    async def insert_traceroot_token(
        self,
        token: str,
        user_credentials: dict[str, Any],
        delete_existing: bool = False,
    ) -> bool:
        pass

    async def get_traceroot_token(
        self,
        hashed_user_sub: str,
    ) -> str | None:
        pass

    async def delete_traceroot_token(
        self,
        hashed_user_sub: str,
    ) -> bool:
        pass

    async def get_credentials_by_token(
        self,
        token: str,
    ) -> dict[str, Any] | None:
        pass

    # Subscription management methods
    async def create_subscription(
        self,
        subscription: UserSubscription,
    ) -> bool:
        pass

    async def update_subscription(
        self,
        user_email: str,
        hasAccess: bool,
        subscription_plan: str,
        start_date: str,
        payment_email: str = None,
    ) -> bool:
        pass

    async def get_subscription(
        self,
        user_email: str,
    ) -> Optional[UserSubscription]:
        pass

    async def add_payment_to_subscription(
        self,
        user_email: str,
        payment_record: PaymentRecord,
    ) -> bool:
        pass

    async def get_workflow(
        self,
        user_email: str,
    ) -> Optional[WorkflowCheckbox]:
        """Get workflow configuration for a user.

        Args:
            user_email: The user email to look up

        Returns:
            WorkflowCheckbox object if found, None otherwise
        """

    async def insert_workflow(
        self,
        user_email: str,
        checkbox_type: str,
    ) -> bool:
        """Insert or update workflow configuration for a user.

        Args:
            user_email: The user email
            checkbox_type: The checkbox type to enable

        Returns:
            True if successful, False otherwise
        """

    async def delete_workflow(
        self,
        user_email: str,
        checkbox_type: str,
    ) -> bool:
        """Delete workflow configuration for a user.

        Args:
            user_email: The user email
            checkbox_type: The checkbox type to disable

        Returns:
            True if successful, False otherwise
        """
