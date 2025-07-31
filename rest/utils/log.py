from datetime import datetime, timezone
from typing import Any

from rest.config.log import LogEntry, TraceLogs


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
        level = items[1]

        # Message
        message = items[-1]

        # Commit ID
        github_owner = items[4]
        github_repo = items[5]
        commit_id = items[3]
        github_url = (f"https://github.com/"
                      f"{github_owner}/"
                      f"{github_repo}/tree/"
                      f"{commit_id}/")

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
