from pydantic import BaseModel, Field

from rest.agent.typing import LogFeature, SpanFeature


class LogFeatureSelectorOutput(BaseModel):
    r"""Log feature selector output.
    """
    log_features: list[LogFeature] = Field(
        description=(
            "The list of log features that are necessary "
            "to answer the user's message."
        )
    )


class SpanFeatureSelectorOutput(BaseModel):
    r"""Span feature selector output.
    """
    span_features: list[SpanFeature] = Field(
        description=(
            "The list of span features that are necessary "
            "to answer the user's message."
        )
    )
