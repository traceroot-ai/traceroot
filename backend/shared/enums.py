from enum import StrEnum


class SpanKind(StrEnum):
    LLM = "LLM"
    AGENT = "AGENT"
    TOOL = "TOOL"
    SPAN = "SPAN"


class SpanStatus(StrEnum):
    OK = "OK"
    ERROR = "ERROR"


class MemberRole(StrEnum):
    VIEWER = "VIEWER"
    MEMBER = "MEMBER"
    ADMIN = "ADMIN"
