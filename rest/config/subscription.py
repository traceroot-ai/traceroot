"""Subscription-related models and configuration."""

from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field


class SubscriptionPlan(str, Enum):
    """Subscription plan types."""
    STARTER = "starter"
    PRO = "pro"
    STARTUPS = "startups"


class PaymentRecord(BaseModel):
    """Payment record model."""
    amount: float = Field(..., description="Payment amount in cents")
    date: str = Field(..., description="Payment date in ISO format")
    stripe_payment_id: str = Field(..., description="Stripe payment ID")


class UserSubscription(BaseModel):
    """User subscription model."""
    user_email: str = Field(..., description="User account email address")
    hasAccess: bool = Field(..., description="Whether user has active access")
    subscription_plan: str = Field(default="starter",
                                   description="Current subscription plan")
    start_date: str = Field(
        ..., description="Subscription start date in ISO format")
    is_trial: bool = Field(default=False,
                           description="Whether this is a trial subscription")
    trial_start_date: Optional[str] = Field(
        None, description="When trial started, if applicable")
    trial_days_remaining: Optional[int] = Field(
        None, description="Number of days remaining in trial")
    payment_history: List[PaymentRecord] = Field(default_factory=list,
                                                 description="Payment history")


class SubscriptionRequest(BaseModel):
    """Request model for creating a subscription."""
    user_email: str
    subscription_plan: str = "starter"
    start_date: str
    hasAccess: bool = True
    is_trial: bool = True


class SubscriptionResponse(BaseModel):
    """Response model for subscription operations."""
    success: bool
    message: str
    subscription: UserSubscription


class UpdateSubscriptionRequest(BaseModel):
    """Request model for updating a subscription."""
    user_email: str
    hasAccess: bool
    subscription_plan: str = "starter"
    start_date: str
    is_trial: bool = False


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
    subscription: UserSubscription
    message: Optional[str] = None
