from enum import StrEnum


class SpanKind(StrEnum):
    LLM = "LLM"
    AGENT = "AGENT"
    TOOL = "TOOL"
    SPAN = "SPAN"
    # Offline-evaluation span kinds emitted by the SDK: the evaluation-item root,
    # the candidate task span, and each scorer span.
    EVALUATION = "EVALUATION"
    TASK = "TASK"
    SCORER = "SCORER"


class SpanStatus(StrEnum):
    OK = "OK"
    ERROR = "ERROR"


class MemberRole(StrEnum):
    VIEWER = "VIEWER"
    MEMBER = "MEMBER"
    ADMIN = "ADMIN"
