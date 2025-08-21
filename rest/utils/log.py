import json
from datetime import datetime, timezone
from typing import Any

from rest.config.log import LogEntry, TraceLogs
from rest.utils.constants import SKIP_LOG_FIELDS


def process_log_events(all_events: list[dict[str, Any]]) -> TraceLogs:
    """Process AWS CloudWatch log events into structured TraceLogs.

    Args:
        all_events: List of raw CloudWatch log events

    Returns:
        TraceLogs: Structured trace logs with LogEntry objects
    """
    logs: list[dict[str, list[LogEntry]]] = []
    span_logs: dict[str, list[LogEntry]] | None = None

    for event in all_events:
        message: str = event['message']
        if message.startswith("{") and message.endswith("}"):
            log_entry, span_id = _load_json(message)
        else:
            log_entry, span_id = _string_manipulation(message)
        if log_entry is None or span_id is None:
            continue

        # For the first span log
        if span_logs is None:
            span_logs = {span_id: [log_entry]}
        # If the span continues logging, add the log entry to the span
        elif span_id in span_logs:
            span_logs[span_id].append(log_entry)
        # Store previous span and start a new span log
        else:
            logs.append(span_logs)
            span_logs = {span_id: [log_entry]}

    # Add the last span logs to the logs
    if span_logs is not None:
        logs.append(span_logs)

    trace_logs = TraceLogs(logs=logs)
    return trace_logs


def _load_json(message: str, ) -> tuple[LogEntry, str] | tuple[None, None]:
    json_data = json.loads(message)
    time_str = json_data['timestamp']
    time_obj = datetime.strptime(time_str, "%Y-%m-%d %H:%M:%S,%f")
    # Make it timezone-aware as UTC to avoid local timezone assumptions
    time_obj = time_obj.replace(tzinfo=timezone.utc)
    time = time_obj.timestamp()
    level = json_data['level'].upper()
    # For now for WARN to WARNING for typescript case
    if level == "WARN":
        level = "WARNING"
    # Create a filtered JSON message with original message and non-skipped fields
    filtered_data = {'message': json_data['message']}

    # Add other data fields that are not in the skip list
    for key, value in json_data.items():
        if key not in SKIP_LOG_FIELDS and key != 'message':
            filtered_data[key] = value

    if len(filtered_data) > 1:
        message = json.dumps(filtered_data)
    else:
        message = json_data['message']

    if 'stack_trace' in json_data:
        stack = json_data['stack_trace']
        stack_items = stack.split(' -> ')
        code_info = stack_items[-1]
        code_info = code_info.replace('///(rsc)/./', '')
        code_info_items = code_info.split(':')
        file_path = code_info_items[-3]
        function_name = code_info_items[-2]
        line_number = int(code_info_items[-1])
    else:
        return None, None

    github_owner = json_data['github_owner']
    github_repo = json_data['github_repo_name']
    commit_id = json_data['github_commit_hash']
    span_id = json_data['span_id']

    github_url = (
        f"https://github.com/"
        f"{github_owner}/"
        f"{github_repo}/tree/"
        f"{commit_id}/"
    )
    github_url = f"{github_url}{file_path}?plain=1#L{line_number}"

    log_entry = LogEntry(
        time=time,
        level=level,
        message=message,
        file_name=file_path,
        function_name=function_name,
        line_number=line_number,
        git_url=github_url,
        commit_id=commit_id,
    )
    return log_entry, span_id


def _string_manipulation(message: str) -> tuple[LogEntry, str] | tuple[None, None]:
    if "no-trace" in message:
        return None, None

    items = message.split(';')

    # Time
    time_str = items[0]
    # Handle milliseconds by padding to microseconds if needed
    if ',' in time_str:
        date_part, ms_part = time_str.split(',')
        # Pad milliseconds to 6 digits for microseconds
        ms_part = ms_part.ljust(6, '0')
        time_str = f"{date_part},{ms_part}"
    time_obj = datetime.strptime(time_str, "%Y-%m-%d %H:%M:%S,%f")
    # Make it timezone-aware as UTC to avoid local timezone assumptions
    time_obj = time_obj.replace(tzinfo=timezone.utc)
    time = time_obj.timestamp()

    # Log level
    level = items[1].upper()

    # Message
    message = items[-1]

    # Commit ID
    github_owner = items[4]
    github_repo = items[5]
    commit_id = items[3]
    github_url = (
        f"https://github.com/"
        f"{github_owner}/"
        f"{github_repo}/tree/"
        f"{commit_id}/"
    )

    # File name, function name, and line number
    stack = items[9]
    stack_items = stack.split(' -> ')
    code_info = stack_items[-1]
    code_info = code_info.replace('///(rsc)/./', '')
    code_info_items = code_info.split(':')
    file_path = code_info_items[-3]
    function_name = code_info_items[-2]
    line_number = int(code_info_items[-1])

    # Support other github like pages
    github_url = f"{github_url}{file_path}?plain=1#L{line_number}"

    # Span ID
    span_id = items[8]

    log_entry = LogEntry(
        time=time,
        level=level,
        message=message,
        file_name=file_path,
        function_name=function_name,
        line_number=line_number,
        git_url=github_url,
        commit_id=commit_id,
    )
    return log_entry, span_id
