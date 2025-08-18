from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel

from rest.agent.typing import LogFeature, SpanFeature
from rest.config import LogEntry, Span


class LogNode(BaseModel):
    r"""Log node in the tree.
    """
    # Log related information #################################################
    # UTC timestamp of the log
    log_utc_timestamp: datetime
    # Log level: DEBUG, INFO, WARNING, ERROR, CRITICAL
    log_level: str
    # File name
    log_file_name: str
    # Function name
    log_func_name: str
    # Log message
    log_message: str
    # Log line number
    log_line_number: int
    # Source code line
    log_source_code_line: str
    # Source code lines above the log
    log_source_code_lines_above: list[str]
    # Source code lines below the log
    log_source_code_lines_below: list[str]

    def to_dict(self, features: list[LogFeature]) -> dict[str, str]:
        feature_mapping = {
            LogFeature.LOG_UTC_TIMESTAMP: str(self.log_utc_timestamp),
            LogFeature.LOG_LEVEL: self.log_level,
            LogFeature.LOG_FILE_NAME: self.log_file_name,
            LogFeature.LOG_FUNC_NAME: self.log_func_name,
            LogFeature.LOG_MESSAGE_VALUE: self.log_message,
            LogFeature.LOG_LINE_NUMBER: str(self.log_line_number),
            LogFeature.LOG_SOURCE_CODE_LINE: self.log_source_code_line,
            LogFeature.LOG_SOURCE_CODE_LINES_ABOVE: self.log_source_code_lines_above,
            LogFeature.LOG_SOURCE_CODE_LINES_BELOW: self.log_source_code_lines_below,
        }
        return {feature.value: feature_mapping[feature] for feature in features}


class SpanNode(BaseModel):
    r"""Span node in the tree.
    """
    # Trace related information ###############################################
    # Unique span id
    span_id: str
    # Full name of the function with the file name
    func_full_name: str
    # Latency of the span in seconds
    span_latency: float
    # Span utc start time
    span_utc_start_time: datetime
    # Span utc end time
    span_utc_end_time: datetime

    # Logs in the span, sorted by log_utc_timestamp from oldest to newest
    logs: list[LogNode] = []

    # Structure related information ###########################################
    # Children nodes, sorted by span_utc_start_time from oldest to newest
    children_spans: list["SpanNode"] = []

    def to_dict(
        self,
        span_features: list[SpanFeature] = list(SpanFeature),
        log_features: list[LogFeature] = list(LogFeature),
    ) -> dict[str,
              Any]:
        res = {"span_id": self.span_id, "func_full_name": self.func_full_name}
        feature_mapping = {
            SpanFeature.SPAN_LATENCY: str(self.span_latency),
            SpanFeature.SPAN_UTC_START_TIME: str(self.span_utc_start_time),
            SpanFeature.SPAN_UTC_END_TIME: str(self.span_utc_end_time),
        }
        for feature in span_features:
            res[feature.value] = feature_mapping[feature]

        events: list[tuple[datetime, LogNode | "SpanNode"]] = []
        for log in self.logs:
            events.append((log.log_utc_timestamp.timestamp(), log))
        for child_span in self.children_spans:
            events.append((child_span.span_utc_start_time.timestamp(), child_span))
        events.sort(key=lambda x: x[0])
        log_count = 0
        for _, obj in events:
            if isinstance(obj, LogNode):
                res[f"log_{log_count}"] = obj.to_dict(log_features)
                log_count += 1
            else:
                res[obj.span_id] = obj.to_dict(span_features, log_features)
        return res


def create_logs_map(
    trace_logs: list[dict[str,
                          list[LogEntry]]],
) -> dict[str,
          list[LogEntry]]:
    r"""Create a mapping from span_id to list of LogEntry objects."""
    logs_map = {}
    for logs_dict in trace_logs:
        for span_id, log_entries in logs_dict.items():
            if span_id not in logs_map:
                logs_map[span_id] = []
            logs_map[span_id].extend(log_entries)
    return logs_map


def convert_log_entry_to_log_node(log_entry: LogEntry) -> LogNode:
    r"""Convert LogEntry to LogNode."""
    return LogNode(
        log_utc_timestamp=datetime.fromtimestamp(
            log_entry.time,
            tz=timezone.utc,
        ),
        log_level=log_entry.level,
        log_file_name=log_entry.file_name,
        log_func_name=log_entry.function_name,
        log_message=log_entry.message,
        log_line_number=log_entry.line_number,
        log_source_code_line=log_entry.line or "",
        log_source_code_lines_above=log_entry.lines_above or [],
        log_source_code_lines_below=log_entry.lines_below or [],
    )


def convert_span_to_span_node(
    span: Span,
    logs_map: dict[str,
                   list[LogEntry]],
) -> SpanNode:
    r"""Convert Span to SpanNode recursively."""
    # Convert logs for this span
    span_logs = []
    if span.id in logs_map:
        for log_entry in logs_map[span.id]:
            log_node = convert_log_entry_to_log_node(log_entry)
            span_logs.append(log_node)

    # Sort logs by timestamp
    span_logs.sort(key=lambda log: log.log_utc_timestamp)

    # Convert child spans recursively
    children_spans = []
    for child_span in span.spans:
        child_span_node = convert_span_to_span_node(child_span, logs_map)
        children_spans.append(child_span_node)

    # Sort child spans by start time
    children_spans.sort(key=lambda child: child.span_utc_start_time)

    return SpanNode(
        span_id=span.id,
        func_full_name=span.name,
        span_latency=span.duration,
        span_utc_start_time=datetime.fromtimestamp(
            span.start_time,
            tz=timezone.utc,
        ),
        span_utc_end_time=datetime.fromtimestamp(
            span.end_time,
            tz=timezone.utc,
        ),
        logs=span_logs,
        children_spans=children_spans,
    )


def build_heterogeneous_tree(
    span: Span,
    trace_logs: list[dict[str,
                          list[LogEntry]]]
) -> SpanNode:
    r"""Build a heterogeneous tree from a trace and trace logs.
    """
    # Create logs mapping
    logs_map = create_logs_map(trace_logs)

    # Convert the input span to SpanNode
    span_node = convert_span_to_span_node(span, logs_map)

    return span_node
