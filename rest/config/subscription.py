"""Subscription-related models and configuration."""

from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field


class SubscriptionPlan(str, Enum):
    """Subscription plan types."""
    STARTER = "starter"
    PRO = "pro"
    STARTUPS = "startups"
    NONE = "none"


class PaymentRecord(BaseModel):
    """Payment record model."""
    amount: float = Field(..., description="Payment amount in cents")
    date: str = Field(..., description="Payment date in ISO format")
    stripe_payment_id: str = Field(..., description="Stripe payment ID")


class UserSubscription(BaseModel):
    """User subscription model."""
    user_email: str = Field(..., description="User account email address")
    hasAccess: bool = Field(..., description="Whether user has active access")
    subscription_plan: str = Field(...,
                                   description="Current subscription plan")
    start_date: str = Field(
        ..., description="Subscription start date in ISO format")
    payment_history: List[PaymentRecord] = Field(default_factory=list,
                                                 description="Payment history")


class SubscriptionRequest(BaseModel):
    """Request model for creating a subscription."""
    user_email: str
    subscription_plan: str
    start_date: str
    hasAccess: bool = True


class SubscriptionResponse(BaseModel):
    """Response model for subscription operations."""
    success: bool
    message: str
    subscription: Optional[UserSubscription] = None


class UpdateSubscriptionRequest(BaseModel):
    """Request model for updating a subscription."""
    user_email: str
    hasAccess: bool
    subscription_plan: str
    start_date: str


class UpdateSubscriptionResponse(BaseModel):
    """Response model for updating a subscription."""
    success: bool
    message: str


class PaymentRecordRequest(BaseModel):
    """Request model for recording a payment."""
    user_email: str
    amount: float
    date: str
    stripe_payment_id: str


class PaymentRecordResponse(BaseModel):
    """Response model for recording a payment."""
    success: bool
    message: str


class GetSubscriptionRequest(BaseModel):
    """Request model for getting subscription information."""
    user_email: str


class GetSubscriptionResponse(BaseModel):
    """Response model for getting subscription information."""
    success: bool
    subscription: Optional[UserSubscription] = None
    message: Optional[str] = None
