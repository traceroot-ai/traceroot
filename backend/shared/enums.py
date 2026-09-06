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


# The span kinds that mark a span as part of an offline-evaluation run, and the source
# of truth for the trace-level `is_evaluation` flag written at ingest.
#
# This is the only trustworthy signal: it comes from the SDK's eval engine
# (traceroot.span.type), never from user-supplied configuration. In particular it must
# not be conflated with `environment`, which is the user's own deployment tag
# (TRACEROOT_ENVIRONMENT: production, staging, ...). Deriving classification from
# `environment` both misses every eval run in a project that sets the tag and
# misclassifies a customer who happens to name their environment "evaluation".
#
# Note this membership answers "is this span part of an eval run", which is a DIFFERENT
# question from "does this span count toward the candidate's cost" — the latter needs a
# subtree walk that drops SCORER spans and everything under them (see
# worker.ingest_tasks._task_cost_by_trace). Do not collapse the two.
EVALUATION_SPAN_KINDS = frozenset(
    {SpanKind.EVALUATION, SpanKind.TASK, SpanKind.SCORER},
)


class SpanStatus(StrEnum):
    OK = "OK"
    ERROR = "ERROR"


class MemberRole(StrEnum):
    VIEWER = "VIEWER"
    MEMBER = "MEMBER"
    ADMIN = "ADMIN"
