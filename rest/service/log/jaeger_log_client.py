import asyncio
import datetime as dt
import os
from datetime import datetime
from typing import Any, Optional

import requests

from rest.config.log import LogEntry, TraceLogs
from rest.service.log.log_client import LogClient


class JaegerLogClient(LogClient):
    """Client for querying logs from Jaeger."""

    def __init__(self, jaeger_url: str | None = None):
        """Initialize the Jaeger log client.

        Args:
            jaeger_url (str | None): Jaeger base URL. If None,
                uses JAEGER_URL env var or defaults to localhost.
        """
        if jaeger_url is None:
            jaeger_url = os.getenv("JAEGER_URL", "http://localhost:16686")

        api_url = f"{jaeger_url}/api"
        self.traces_url = f"{api_url}/traces"

    async def get_logs_by_trace_id(
        self,
        trace_id: str,
        start_time: datetime | None = None,
        end_time: datetime | None = None,
        log_group_name: str | None = None,
        log_search_term: str | None = None,
    ) -> TraceLogs:
        """Extract logs from Jaeger trace data by trace ID.

        Args:
            trace_id (str): The trace ID to get logs for
            start_time (datetime, optional): Start time of the trace.
                If not provided, searches last 30 days.
            end_time (datetime, optional): End time of the trace.
                If not provided, uses current time.
            log_group_name (str, optional): Not used in Jaeger implementation
            log_search_term (str, optional): Not used in Jaeger implementation

        Returns:
            TraceLogs: Trace logs for the given trace ID
        """
        # If timestamps not provided, use a wide time range (30 days)
        if end_time is None:
            end_time = dt.datetime.now(dt.timezone.utc)
        if start_time is None:
            start_time = end_time - dt.timedelta(days=30)

        # First, get the trace data from Jaeger
        trace_data = await self._get_trace_by_id(trace_id)
        if not trace_data:
            return TraceLogs(logs=[])

        # Extract process information from trace data
        processes = trace_data.get("processes", {})

        # Extract spans from the trace data
        spans_data = trace_data.get("spans", [])

        all_events = []
        for span_data in spans_data:
            span_logs = span_data.get('logs', [])
            if not span_logs:
                continue
            process_id = span_data.get('processID')
            process_data = processes.get(process_id, {}) if process_id else {}

            github_owner: str | None = None
            github_repo: str | None = None
            commit_id: str | None = None

            if 'tags' in process_data:
                process_tags = process_data['tags']
                for tag in process_tags:
                    key = tag.get('key')
                    value = tag.get('value')
                    if key == "service.github_owner":
                        github_owner = value
                    elif key == "service.github_repo_name":
                        github_repo = value
                    elif key == "service.version":
                        commit_id = value

            for span_log in span_logs:
                log: dict[str, Any] = {}
                log["github_owner"] = github_owner
                log["github_repo"] = github_repo
                log["commit_id"] = commit_id
                log["timestamp"] = span_log["timestamp"]

                # Extract fields from the log entry
                fields = span_log.get('fields', [])
                field_map = {}
                for field in fields:
                    key = field.get('key')
                    value = field.get('value')
                    if key and value is not None:
                        field_map[key] = value

                log["level"] = field_map.get('log.level', 'INFO').upper()
                log["message"] = field_map.get('log.message', '')
                log["stack_trace"] = field_map.get('log.stack_trace', '')
                stack_parts = log["stack_trace"].split(':') if log["stack_trace"] else []
                line_number = None
                function_name = None

                if len(stack_parts) >= 2:
                    try:
                        line_number = int(stack_parts[-1]
                                          ) if stack_parts[-1].isdigit() else None
                        function_name = stack_parts[-2]
                    except Exception:
                        line_number = None
                        function_name = None

                log["line_number"] = line_number or 0
                log["function_name"] = function_name or ""
                log["span_id"] = span_data.get('spanID', '')
                log["trace_id"] = trace_data.get('traceID', '')
                log["timestamp"] = span_log["timestamp"]
                all_events.append(log)

        all_events.sort(key=lambda x: x["timestamp"])

        logs: list[dict[str, list[LogEntry]]] = []
        span_logs_dict: dict[str, list[LogEntry]] | None = None

        for event in all_events:
            try:
                # Convert timestamp from microseconds to seconds
                timestamp = event["timestamp"] / 1_000_000.0
                line_number = event["line_number"]
                span_id = event["span_id"]

                # Extract actual file path from stack trace
                stack_trace = event["stack_trace"]

                file_name = ""
                if stack_trace:
                    stack_items = stack_trace.split(' -> ')
                    if stack_items:
                        current_frame = stack_items[-1]
                        frame_parts = current_frame.split(':')
                        if len(frame_parts) >= 1:
                            file_name = frame_parts[0]

                # Construct git URL if we have the required information
                git_url = None
                github_owner = event["github_owner"]
                github_repo = event["github_repo"]
                commit_id = event["commit_id"]

                if (github_owner and github_repo and commit_id and file_name):
                    git_url = (
                        f"https://github.com/"
                        f"{github_owner}/"
                        f"{github_repo}/tree/"
                        f"{commit_id}/"
                        f"{file_name}?plain=1#L{line_number}"
                    )

                # Create LogEntry object
                log_entry = LogEntry(
                    time=timestamp,
                    level=event["level"],
                    message=event["message"],
                    file_name=file_name,
                    function_name=event["function_name"],
                    line_number=line_number,
                    git_url=git_url,
                    commit_id=commit_id,
                )

                # Please see log.py for the logic of grouping logs by span_id
                if span_logs_dict is None:
                    span_logs_dict = {span_id: [log_entry]}
                elif span_id in span_logs_dict:
                    span_logs_dict[span_id].append(log_entry)
                else:
                    logs.append(span_logs_dict)
                    span_logs_dict = {span_id: [log_entry]}

            except Exception as e:
                print(f"Error converting event to LogEntry: {e}")
                continue

        # Add the last span logs to the logs
        if span_logs_dict is not None:
            logs.append(span_logs_dict)

        # Convert to TraceLogs format
        trace_logs = TraceLogs(logs=logs)
        return trace_logs

    async def get_trace_ids_from_logs(
        self,
        start_time: datetime,
        end_time: datetime,
        log_group_name: str,
        search_term: str,
    ) -> list[str]:
        """Get trace IDs from logs.

        Args:
            start_time: Start time for log query
            end_time: End time for log query
            log_group_name: Log group name
            search_term: Search term to look for in log messages

        Returns:
            List of unique trace IDs found in logs containing the search term

        Note:
            This method is not implemented for Jaeger client as Jaeger
            does not support log-based trace ID queries.
        """
        return []

    async def _get_trace_by_id(
        self,
        trace_id: str,
    ) -> Optional[dict[str,
                       Any]]:
        """Get a specific trace by its ID from Jaeger.

        Args:
            trace_id (str): The trace ID to fetch

        Returns:
            Optional[dict[str, Any]]: Trace data or None if not found
        """
        try:
            url = f"{self.traces_url}/{trace_id}"
            response = await self._make_request(url)

            if response and "data" in response:
                traces = response["data"]
                if traces and len(traces) > 0:
                    return traces[0]  # Return first trace

            return None
        except Exception as e:
            print(f"Error getting trace by ID {trace_id}: {e}")
            return None

    async def _make_request(self,
                            url: str,
                            params: Optional[dict] = None) -> Optional[dict[str,
                                                                            Any]]:
        """Make HTTP request to Jaeger API."""
        loop = asyncio.get_event_loop()

        def _request():
            try:
                response = requests.get(url, params=params)
                if response.ok:
                    # Check if response has content before trying to parse JSON
                    if response.content.strip():
                        return response.json()
                    else:
                        print(f"Empty response from {url}")
                        return None
                else:
                    print(f"Error: {response.status_code} - {response.text}")
                    return None
            except requests.exceptions.JSONDecodeError as e:
                print(f"JSON decode error for {url}: {e}")
                return None
            except Exception as e:
                print(f"Request error for {url}: {e}")
                return None

        return await loop.run_in_executor(None, _request)
