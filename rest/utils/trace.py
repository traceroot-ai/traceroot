from datetime import datetime

import numpy as np

from rest.config.trace import Span, Trace
from rest.typing import Percentile


def sort_spans_recursively(spans: list[Span]) -> None:
    """
    Sort spans by start_time recursively, including all child spans.

    Args:
        spans: List of spans to sort (modified in-place)
    """
    # Sort the current level spans
    spans.sort(key=lambda span: span.start_time, reverse=False)

    # Recursively sort child spans
    for span in spans:
        if span.spans:
            sort_spans_recursively(span.spans)


def accumulate_logs(span_data: dict) -> dict:
    r"""Accumulate the number of logs from child spans to the parent span.

    Args:
        span_data (dict): The span data

    Returns:
        dict: The span data with the accumulated logs
    """

    def accumulate_span_logs(span: Span) -> None:
        r"""Recursively accumulate logs from child spans to parent span.

        Args:
            span (Span): The span to accumulate logs from
        """
        # First, recursively process all child spans
        for child_span in span.spans:
            accumulate_span_logs(child_span)

        # Then accumulate logs from all child spans to this span
        for child_span in span.spans:
            # Add child span's log counts to parent span
            if child_span.num_debug_logs is not None:
                span.num_debug_logs = (
                    span.num_debug_logs or 0
                ) + child_span.num_debug_logs
            if child_span.num_info_logs is not None:
                span.num_info_logs = (span.num_info_logs or 0) + child_span.num_info_logs
            if child_span.num_warning_logs is not None:
                span.num_warning_logs = (
                    span.num_warning_logs or 0
                ) + child_span.num_warning_logs
            if child_span.num_error_logs is not None:
                span.num_error_logs = (
                    span.num_error_logs or 0
                ) + child_span.num_error_logs
            if child_span.num_critical_logs is not None:
                span.num_critical_logs = (
                    span.num_critical_logs or 0
                ) + child_span.num_critical_logs

    # Process each trace in the span_data dictionary
    for _, spans in span_data.items():
        for span in spans:
            accumulate_span_logs(span)

    return span_data


def accumulate_num_logs_to_traces(traces: list[Trace]) -> None:
    r"""Accumulate log counts from all child spans recursively
    to traces.

    Args:
        traces: List of traces to accumulate logs
            (modified in-place).
    """

    def accumulate_span_logs_recursively(span: Span) -> tuple[int, int, int, int, int]:
        r"""Recursively accumulate logs from a span and all its children.
        Also updates the span's own log counts to include children's logs.

        Args:
            span: The span to accumulate logs (modified in-place).

        Returns:
            tuple: (debug_logs, info_logs, warning_logs,
                error_logs, critical_logs)
        """
        # Start with the span's own logs
        debug_logs = span.num_debug_logs or 0
        info_logs = span.num_info_logs or 0
        warning_logs = span.num_warning_logs or 0
        error_logs = span.num_error_logs or 0
        critical_logs = span.num_critical_logs or 0

        # Recursively accumulate from all child spans
        for child_span in span.spans:
            (child_debug,
             child_info,
             child_warning,
             child_error,
             child_critical) = accumulate_span_logs_recursively(child_span)
            debug_logs += child_debug
            info_logs += child_info
            warning_logs += child_warning
            error_logs += child_error
            critical_logs += child_critical

        # Update the span's own log counts to include children's logs
        span.num_debug_logs = debug_logs
        span.num_info_logs = info_logs
        span.num_warning_logs = warning_logs
        span.num_error_logs = error_logs
        span.num_critical_logs = critical_logs

        return debug_logs, info_logs, warning_logs, error_logs, critical_logs

    for trace in traces:
        if len(trace.spans) > 0:
            trace.start_time = trace.spans[0].start_time
            trace.end_time = trace.spans[0].end_time

            # Accumulate log counts from all child spans recursively
            for span in trace.spans:
                (debug_logs,
                 info_logs,
                 warning_logs,
                 error_logs,
                 critical_logs) = accumulate_span_logs_recursively(span)

                trace.num_debug_logs = (trace.num_debug_logs or 0) + debug_logs
                trace.num_info_logs = (trace.num_info_logs or 0) + info_logs
                trace.num_warning_logs = (trace.num_warning_logs or 0) + warning_logs
                trace.num_error_logs = (trace.num_error_logs or 0) + error_logs
                trace.num_critical_logs = (trace.num_critical_logs or 0) + critical_logs


def accumulate_telemetry_languages_to_traces(traces: list[Trace]) -> None:
    r"""Accumulate telemetry SDK languages from all child spans recursively
    to traces.

    Args:
        traces: List of traces to accumulate telemetry SDK languages
            (modified in-place).
    """

    def accumulate_span_languages_recursively(span: Span) -> set[str]:
        r"""Recursively accumulate telemetry SDK languages from a span and
        all its children. Also updates the span's own telemetry_sdk_language
        set to include children's languages.

        Args:
            span: The span to accumulate languages from (modified in-place).

        Returns:
            set[str]: Set of telemetry SDK languages from this span and all
            children.
        """
        # Start with the span's own language
        languages = set()
        if span.telemetry_sdk_language is not None:
            languages.add(span.telemetry_sdk_language)

        # Recursively accumulate from all child spans
        for child_span in span.spans:
            child_languages = accumulate_span_languages_recursively(child_span)
            languages.update(child_languages)

        return languages

    for trace in traces:
        if len(trace.spans) > 0:
            trace.start_time = trace.spans[0].start_time
            trace.end_time = trace.spans[0].end_time

            # Accumulate telemetry SDK languages from
            # all child spans recursively
            for span in trace.spans:
                span_languages = accumulate_span_languages_recursively(span)
                trace.telemetry_sdk_language.update(span_languages)


def construct_traces(
    service_names: list[str | None],
    service_environments: list[str | None],
    trace_ids: list[str],
    start_times: list[datetime],
    durations: list[float],
) -> list[Trace]:
    r"""Construct traces from trace IDs, start times, durations, and end times.

    Args:
        service_names (list[str]): List of service names
        service_environments (list[str]): List of service environments
        trace_ids (list[str]): List of trace IDs
        start_times (list[datetime]): List of start times
        durations (list[float]): List of durations

    Returns:
        list[Trace]: List of traces
    """
    traces: list[Trace] = []
    end_times: list[float] = [
        start_time + duration for start_time, duration in zip(start_times, durations)
    ]

    # Compute percentiles once for all durations
    # Only compute percentiles if there are more than 100 durations
    if durations and len(durations) > 100:
        durations_array = np.array(durations)
        p50 = np.percentile(durations_array, 50)
        p90 = np.percentile(durations_array, 90)
        p95 = np.percentile(durations_array, 95)
    else:
        p50 = p90 = p95 = 0

    # Calculate percentiles for each trace based on all durations
    for i, trace_id in enumerate(trace_ids):
        start_time = start_times[i]
        duration = durations[i]
        end_time = end_times[i]
        if len(durations) > 100:
            if duration <= p50:
                percentile = Percentile.P50
            elif duration <= p90:
                percentile = Percentile.P90
            elif duration <= p95:
                percentile = Percentile.P95
            else:
                percentile = Percentile.P99
        else:
            percentile = Percentile.P50

        service_name = service_names[i]
        service_environment = service_environments[i]
        traces.append(
            Trace(
                id=trace_id,
                start_time=start_time,
                end_time=end_time,
                duration=duration,
                percentile=percentile,
                service_name=service_name,
                service_environment=service_environment,
                num_debug_logs=0,
                num_info_logs=0,
                num_warning_logs=0,
                num_error_logs=0,
                num_critical_logs=0,
                telemetry_sdk_language=set(),
            )
        )
    return traces


def collect_spans_latency_recursively(
    spans: list[Span],
    spans_latency_dict: dict[str,
                             float]
) -> None:
    """Recursively collect span latencies from all
    spans and their children.
    """
    for span in spans:
        spans_latency_dict[span.id] = span.duration
        if span.spans:
            collect_spans_latency_recursively(
                span.spans,
                spans_latency_dict,
            )
