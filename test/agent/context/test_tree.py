from datetime import datetime, timezone

from rest.agent.context.tree import (LogNode, SpanNode,
                                     build_heterogeneous_tree,
                                     convert_log_entry_to_log_node,
                                     convert_span_to_span_node,
                                     create_logs_map)
from rest.agent.typing import LogFeature, SpanFeature
from rest.config.log import LogEntry
from rest.config.trace import Span


def test_log_node_creation():
    """Test creating a LogNode instance."""
    timestamp = datetime.now(timezone.utc)
    log_node = LogNode(
        log_utc_timestamp=timestamp,
        log_level="INFO",
        log_file_name="test.py",
        log_func_name="test_function",
        log_message="Test message",
        log_line_number=42,
        log_source_code_line="print('hello')",
        log_source_code_lines_above=["# comment above"],
        log_source_code_lines_below=["# comment below"],
    )

    assert log_node.log_utc_timestamp == timestamp
    assert log_node.log_level == "INFO"
    assert log_node.log_file_name == "test.py"
    assert log_node.log_func_name == "test_function"
    assert log_node.log_message == "Test message"
    assert log_node.log_line_number == 42
    assert log_node.log_source_code_line == "print('hello')"
    assert log_node.log_source_code_lines_above == ["# comment above"]
    assert log_node.log_source_code_lines_below == ["# comment below"]


def test_log_node_to_dict_all_features():
    """Test LogNode to_dict with all features."""
    timestamp = datetime(2023, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    log_node = LogNode(
        log_utc_timestamp=timestamp,
        log_level="ERROR",
        log_file_name="error.py",
        log_func_name="error_function",
        log_message="Error occurred",
        log_line_number=100,
        log_source_code_line="raise Exception()",
        log_source_code_lines_above=["try:", "    do_something()"],
        log_source_code_lines_below=["except:", "    handle_error()"],
    )

    all_features = list(LogFeature)
    result = log_node.to_dict(all_features)

    expected = {
        "log utc timestamp": "2023-01-01 12:00:00+00:00",
        "log level": "ERROR",
        "file name": "error.py",
        "function name": "error_function",
        "log message value": "Error occurred",
        "line number": "100",
        "log line source code": "raise Exception()",
        "lines above log source code": ["try:", "    do_something()"],
        "lines below log source code": ["except:", "    handle_error()"],
    }

    assert result == expected


def test_log_node_to_dict_subset_features():
    """Test LogNode to_dict with only a subset of features."""
    timestamp = datetime(2023, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    log_node = LogNode(
        log_utc_timestamp=timestamp,
        log_level="WARNING",
        log_file_name="warn.py",
        log_func_name="warn_function",
        log_message="Warning message",
        log_line_number=50,
        log_source_code_line="warn('test')",
        log_source_code_lines_above=[],
        log_source_code_lines_below=[],
    )

    features = [
        LogFeature.LOG_LEVEL, LogFeature.LOG_MESSAGE_VALUE,
        LogFeature.LOG_LINE_NUMBER
    ]
    result = log_node.to_dict(features)

    expected = {
        "log level": "WARNING",
        "log message value": "Warning message",
        "line number": "50",
    }

    assert result == expected


def test_span_node_creation():
    """Test creating a SpanNode instance."""
    start_time = datetime(2023, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    end_time = datetime(2023, 1, 1, 12, 0, 1, tzinfo=timezone.utc)

    span_node = SpanNode(
        span_id="span123",
        func_full_name="module.function",
        span_latency=1.5,
        span_utc_start_time=start_time,
        span_utc_end_time=end_time,
    )

    assert span_node.span_id == "span123"
    assert span_node.func_full_name == "module.function"
    assert span_node.span_latency == 1.5
    assert span_node.span_utc_start_time == start_time
    assert span_node.span_utc_end_time == end_time
    assert span_node.logs == []
    assert span_node.children_spans == []


def test_span_node_to_dict_no_children_no_logs():
    """Test SpanNode to_dict with no children or logs."""
    start_time = datetime(2023, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    end_time = datetime(2023, 1, 1, 12, 0, 1, tzinfo=timezone.utc)

    span_node = SpanNode(
        span_id="span123",
        func_full_name="module.function",
        span_latency=1.5,
        span_utc_start_time=start_time,
        span_utc_end_time=end_time,
    )

    result = span_node.to_dict()

    expected = {
        "span_id": "span123",
        "func_full_name": "module.function",
        "span latency": "1.5",
        "span utc start time": "2023-01-01 12:00:00+00:00",
        "span utc end time": "2023-01-01 12:00:01+00:00",
    }

    assert result == expected


def test_span_node_to_dict_with_logs():
    """Test SpanNode to_dict with logs."""
    start_time = datetime(2023, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    end_time = datetime(2023, 1, 1, 12, 0, 1, tzinfo=timezone.utc)
    log_time = datetime(2023, 1, 1, 12, 0, 0, 500000, tzinfo=timezone.utc)

    log_node = LogNode(
        log_utc_timestamp=log_time,
        log_level="INFO",
        log_file_name="test.py",
        log_func_name="test_func",
        log_message="Test log",
        log_line_number=10,
        log_source_code_line="print('test')",
        log_source_code_lines_above=[],
        log_source_code_lines_below=[],
    )

    span_node = SpanNode(
        span_id="span123",
        func_full_name="module.function",
        span_latency=1.5,
        span_utc_start_time=start_time,
        span_utc_end_time=end_time,
        logs=[log_node],
    )

    # Test with minimal features for simplicity
    span_features = [SpanFeature.SPAN_LATENCY]
    log_features = [LogFeature.LOG_LEVEL, LogFeature.LOG_MESSAGE_VALUE]

    result = span_node.to_dict(span_features, log_features)

    expected = {
        "span_id": "span123",
        "func_full_name": "module.function",
        "span latency": "1.5",
        "log_0": {
            "log level": "INFO",
            "log message value": "Test log",
        },
    }

    assert result == expected


def test_span_node_to_dict_with_children():
    """Test SpanNode to_dict with child spans."""
    parent_start = datetime(2023, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    parent_end = datetime(2023, 1, 1, 12, 0, 2, tzinfo=timezone.utc)
    child_start = datetime(2023, 1, 1, 12, 0, 1, tzinfo=timezone.utc)
    child_end = datetime(2023, 1, 1, 12, 0, 1, 500000, tzinfo=timezone.utc)

    child_span = SpanNode(
        span_id="child123",
        func_full_name="child.function",
        span_latency=0.5,
        span_utc_start_time=child_start,
        span_utc_end_time=child_end,
    )

    parent_span = SpanNode(
        span_id="parent123",
        func_full_name="parent.function",
        span_latency=2.0,
        span_utc_start_time=parent_start,
        span_utc_end_time=parent_end,
        children_spans=[child_span],
    )

    span_features = [SpanFeature.SPAN_LATENCY]
    result = parent_span.to_dict(span_features, [])

    expected = {
        "span_id": "parent123",
        "func_full_name": "parent.function",
        "span latency": "2.0",
        "child123": {
            "span_id": "child123",
            "func_full_name": "child.function",
            "span latency": "0.5",
        },
    }

    assert result == expected


def test_create_logs_map_empty_input():
    """Test create_logs_map with empty input."""
    result = create_logs_map([])
    assert result == {}


def test_create_logs_map_single_dict():
    """Test create_logs_map with single dictionary."""
    log_entry = LogEntry(
        time=1672574400.0,
        level="INFO",
        message="Test message",
        function_name="test_func",
        file_name="test.py",
        line_number=10,
    )

    trace_logs = [{"span1": [log_entry]}]
    result = create_logs_map(trace_logs)

    expected = {"span1": [log_entry]}
    assert result == expected


def test_create_logs_map_multiple_dicts():
    """Test create_logs_map with multiple dictionaries."""
    log_entry1 = LogEntry(
        time=1672574400.0,
        level="INFO",
        message="First message",
        function_name="func1",
        file_name="file1.py",
        line_number=10,
    )

    log_entry2 = LogEntry(
        time=1672574401.0,
        level="ERROR",
        message="Second message",
        function_name="func2",
        file_name="file2.py",
        line_number=20,
    )

    trace_logs = [
        {
            "span1": [log_entry1]
        },
        {
            "span1": [log_entry2],
            "span2": [log_entry1]
        },
    ]

    result = create_logs_map(trace_logs)

    expected = {
        "span1": [log_entry1, log_entry2],
        "span2": [log_entry1],
    }
    assert result == expected


def test_convert_log_entry_basic():
    """Test converting basic LogEntry to LogNode."""
    log_entry = LogEntry(
        time=1672574400.0,  # 2023-01-01 12:00:00 UTC
        level="DEBUG",
        message="Debug message",
        function_name="debug_func",
        file_name="debug.py",
        line_number=25,
    )

    result = convert_log_entry_to_log_node(log_entry)

    assert result.log_utc_timestamp == datetime(2023,
                                                1,
                                                1,
                                                12,
                                                0,
                                                0,
                                                tzinfo=timezone.utc)
    assert result.log_level == "DEBUG"
    assert result.log_file_name == "debug.py"
    assert result.log_func_name == "debug_func"
    assert result.log_message == "Debug message"
    assert result.log_line_number == 25
    assert result.log_source_code_line == ""
    assert result.log_source_code_lines_above == []
    assert result.log_source_code_lines_below == []


def test_convert_log_entry_with_source_code():
    """Test converting LogEntry with source code to LogNode."""
    log_entry = LogEntry(
        time=1672574400.0,
        level="INFO",
        message="Info message",
        function_name="info_func",
        file_name="info.py",
        line_number=30,
        line="logger.info('Info message')",
        lines_above=["def info_func():", "    # some setup"],
        lines_below=["    return True"],
    )

    result = convert_log_entry_to_log_node(log_entry)

    assert result.log_source_code_line == "logger.info('Info message')"
    assert result.log_source_code_lines_above == [
        "def info_func():", "    # some setup"
    ]
    assert result.log_source_code_lines_below == ["    return True"]


def test_convert_span_no_logs_no_children():
    """Test converting span with no logs or children."""
    span = Span(
        id="span123",
        parent_id=None,
        name="test.function",
        start_time=1672574400.0,
        end_time=1672574401.0,
        duration=1.0,
    )

    logs_map = {}
    result = convert_span_to_span_node(span, logs_map)

    assert result.span_id == "span123"
    assert result.func_full_name == "test.function"
    assert result.span_latency == 1.0
    assert result.span_utc_start_time == datetime(
        2023,
        1,
        1,
        12,
        0,
        0,
        tzinfo=timezone.utc,
    )
    assert result.span_utc_end_time == datetime(
        2023,
        1,
        1,
        12,
        0,
        1,
        tzinfo=timezone.utc,
    )
    assert result.logs == []
    assert result.children_spans == []


def test_convert_span_with_logs():
    """Test converting span with logs."""
    span = Span(
        id="span123",
        parent_id=None,
        name="test.function",
        start_time=1672574400.0,
        end_time=1672574401.0,
        duration=1.0,
    )

    log_entry = LogEntry(
        time=1672574400.5,
        level="INFO",
        message="Test log",
        function_name="test_func",
        file_name="test.py",
        line_number=10,
    )

    logs_map = {"span123": [log_entry]}
    result = convert_span_to_span_node(span, logs_map)

    assert len(result.logs) == 1
    assert result.logs[0].log_message == "Test log"
    assert result.logs[0].log_level == "INFO"


def test_convert_span_with_children():
    """Test converting span with child spans."""
    child_span = Span(
        id="child123",
        parent_id="parent123",
        name="child.function",
        start_time=1672574400.5,
        end_time=1672574400.8,
        duration=0.3,
    )

    parent_span = Span(
        id="parent123",
        parent_id=None,
        name="parent.function",
        start_time=1672574400.0,
        end_time=1672574401.0,
        duration=1.0,
        spans=[child_span],
    )

    logs_map = {}
    result = convert_span_to_span_node(parent_span, logs_map)

    assert len(result.children_spans) == 1
    assert result.children_spans[0].span_id == "child123"
    assert result.children_spans[0].func_full_name == "child.function"


def test_convert_span_sorts_logs_by_timestamp():
    """Test that logs are sorted by timestamp."""
    span = Span(
        id="span123",
        parent_id=None,
        name="test.function",
        start_time=1672574400.0,
        end_time=1672574401.0,
        duration=1.0,
    )

    log_entry1 = LogEntry(
        time=1672574400.8,  # Later timestamp
        level="INFO",
        message="Second log",
        function_name="test_func",
        file_name="test.py",
        line_number=20,
    )

    log_entry2 = LogEntry(
        time=1672574400.2,  # Earlier timestamp
        level="DEBUG",
        message="First log",
        function_name="test_func",
        file_name="test.py",
        line_number=10,
    )

    logs_map = {"span123": [log_entry1, log_entry2]}  # Unsorted order
    result = convert_span_to_span_node(span, logs_map)

    assert len(result.logs) == 2
    assert result.logs[
        0].log_message == "First log"  # Earlier timestamp should be first
    assert result.logs[
        1].log_message == "Second log"  # Later timestamp should be second


def test_convert_span_sorts_children_by_start_time():
    """Test that child spans are sorted by start time."""
    child_span1 = Span(
        id="child1",
        parent_id="parent123",
        name="child1.function",
        start_time=1672574400.8,  # Later start time
        end_time=1672574400.9,
        duration=0.1,
    )

    child_span2 = Span(
        id="child2",
        parent_id="parent123",
        name="child2.function",
        start_time=1672574400.2,  # Earlier start time
        end_time=1672574400.4,
        duration=0.2,
    )

    parent_span = Span(
        id="parent123",
        parent_id=None,
        name="parent.function",
        start_time=1672574400.0,
        end_time=1672574401.0,
        duration=1.0,
        spans=[child_span1, child_span2],  # Unsorted order
    )

    logs_map = {}
    result = convert_span_to_span_node(parent_span, logs_map)

    assert len(result.children_spans) == 2
    assert result.children_spans[
        0].span_id == "child2"  # Earlier start time should be first
    assert result.children_spans[
        1].span_id == "child1"  # Later start time should be second


def test_build_heterogeneous_tree_simple():
    """Test building a simple heterogeneous tree."""
    span = Span(
        id="root",
        parent_id=None,
        name="root.function",
        start_time=1672574400.0,
        end_time=1672574401.0,
        duration=1.0,
    )

    log_entry = LogEntry(
        time=1672574400.5,
        level="INFO",
        message="Root log",
        function_name="root_func",
        file_name="root.py",
        line_number=5,
    )

    trace_logs = [{"root": [log_entry]}]

    result = build_heterogeneous_tree(span, trace_logs)

    assert result.span_id == "root"
    assert result.func_full_name == "root.function"
    assert len(result.logs) == 1
    assert result.logs[0].log_message == "Root log"
    assert result.children_spans == []


def test_build_heterogeneous_tree_complex():
    r"""Test building a complex heterogeneous tree
    with nested spans and multiple logs."""
    # Create child span
    child_span = Span(
        id="child",
        parent_id="parent",
        name="child.function",
        start_time=1672574400.3,
        end_time=1672574400.7,
        duration=0.4,
    )

    # Create parent span with child
    parent_span = Span(
        id="parent",
        parent_id=None,
        name="parent.function",
        start_time=1672574400.0,
        end_time=1672574401.0,
        duration=1.0,
        spans=[child_span],
    )

    # Create log entries
    parent_log = LogEntry(
        time=1672574400.1,
        level="INFO",
        message="Parent log",
        function_name="parent_func",
        file_name="parent.py",
        line_number=10,
    )

    child_log = LogEntry(
        time=1672574400.5,
        level="DEBUG",
        message="Child log",
        function_name="child_func",
        file_name="child.py",
        line_number=15,
    )

    trace_logs = [
        {
            "parent": [parent_log]
        },
        {
            "child": [child_log]
        },
    ]

    result = build_heterogeneous_tree(parent_span, trace_logs)

    # Verify parent span
    assert result.span_id == "parent"
    assert result.func_full_name == "parent.function"
    assert len(result.logs) == 1
    assert result.logs[0].log_message == "Parent log"

    # Verify child span
    assert len(result.children_spans) == 1
    child_result = result.children_spans[0]
    assert child_result.span_id == "child"
    assert child_result.func_full_name == "child.function"
    assert len(child_result.logs) == 1
    assert child_result.logs[0].log_message == "Child log"


def test_build_heterogeneous_tree_empty_logs():
    """Test building tree with empty trace logs."""
    span = Span(
        id="span123",
        parent_id=None,
        name="test.function",
        start_time=1672574400.0,
        end_time=1672574401.0,
        duration=1.0,
    )

    trace_logs = []

    result = build_heterogeneous_tree(span, trace_logs)

    assert result.span_id == "span123"
    assert result.func_full_name == "test.function"
    assert result.logs == []
    assert result.children_spans == []
