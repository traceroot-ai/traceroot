from enum import Enum


class LogFeature(Enum):
    r"""Log feature."""

    # Log related features
    LOG_UTC_TIMESTAMP = "log utc timestamp"
    LOG_LEVEL = "log level"
    LOG_FILE_NAME = "file name"
    LOG_FUNC_NAME = "function name"
    LOG_MESSAGE_VALUE = "log message value"
    LOG_LINE_NUMBER = "line number"
    LOG_SOURCE_CODE_LINE = "log line source code"
    # For now disable the context for chat as it may hallucinate
    LOG_SOURCE_CODE_LINES_ABOVE = "lines above log source code"
    LOG_SOURCE_CODE_LINES_BELOW = "lines below log source code"


class SpanFeature(Enum):
    r"""Span feature."""

    # Span related features
    SPAN_LATENCY = "span latency"
    SPAN_UTC_START_TIME = "span utc start time"
    SPAN_UTC_END_TIME = "span utc end time"


class FeatureOps(Enum):
    r"""Feature operations."""

    EQUAL = "equal"
    NOT_EQUAL = "not equal"
    CONTAINS = "contains"
    NOT_CONTAINS = "not contains"


class ISSUE_TYPE(Enum):
    GITHUB_ISSUE = "github_issue"
    GITHUB_PR = "github_pr"
