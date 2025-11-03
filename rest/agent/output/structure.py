from datetime import datetime

from pydantic import BaseModel, Field

from rest.agent.typing import FeatureOps, LogFeature


class LogNodeSelectorOutput(BaseModel):
    r"""Log node selector output.
    """
    log_features: list[LogFeature] = Field(
        description=(
            "The list of log features that are necessary "
            "to answer the user's message."
        )
    )
    log_feature_values: list[str | int | datetime] = Field(
        description=(
            "The list of feature values that are necessary "
            "to answer the user's message.\n"
            "Notice that log_line_number is integer, "
            "log_utc_timestamp is datetime, "
            "other features are string. Please skip lines above "
            "log source code and lines below log source code."
        )
    )
    log_feature_ops: list[FeatureOps] = Field(
        description=(
            "The list of feature operations that are necessary "
            "to answer the user's message."
        )
    )
