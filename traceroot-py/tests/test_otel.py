"""Integration tests for OpenTelemetry span creation.

Tests the full trace structure using InMemorySpanExporter.
Verifies span names, types, nesting, input/output capture, and error handling.

Note: These tests verify span attributes are set correctly. The actual
HTTP transport to Traceroot is handled by TracerootJSONExporter.
"""

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

import traceroot
from traceroot import observe
from traceroot.constants import SpanAttributes
from tests.utils import reset_traceroot

# Global exporter and provider for all tests (OTel doesn't allow provider override)
_test_exporter = InMemorySpanExporter()
_test_provider = TracerProvider()
_test_provider.add_span_processor(SimpleSpanProcessor(_test_exporter))
_provider_set = False


@pytest.fixture
def memory_exporter():
    """Set up InMemorySpanExporter for testing."""
    global _provider_set

    reset_traceroot()

    # Set provider only once (OTel restriction)
    if not _provider_set:
        trace.set_tracer_provider(_test_provider)
        _provider_set = True

    # Clear any previous spans
    _test_exporter.clear()

    yield _test_exporter

    # Clean up spans after test
    _test_exporter.clear()
    reset_traceroot()


def get_spans_by_name(exporter):
    """Return dict of spans keyed by name."""
    return {span.name: span for span in exporter.get_finished_spans()}


def get_span_attribute(span, key):
    """Get attribute value from span, or None if not set."""
    return span.attributes.get(key) if span.attributes else None


def test_basic_span_creation(memory_exporter):
    """Test basic span is created with correct name."""

    @observe(name="my-operation")
    def my_operation():
        return "result"

    result = my_operation()

    assert result == "result"

    spans = memory_exporter.get_finished_spans()
    assert len(spans) == 1
    assert spans[0].name == "my-operation"


def test_span_type_attribute(memory_exporter):
    """Test span type is set correctly."""

    @observe(name="llm-call", type="llm")
    def llm_call():
        return "response"

    llm_call()

    spans = memory_exporter.get_finished_spans()
    span = spans[0]

    assert get_span_attribute(span, SpanAttributes.SPAN_TYPE) == "llm"


def test_nested_span_hierarchy(memory_exporter):
    """Test nested spans have correct parent-child relationships."""

    @observe(name="grandchild")
    def grandchild():
        return "deep"

    @observe(name="child")
    def child():
        return grandchild()

    @observe(name="parent")
    def parent():
        return child()

    result = parent()

    assert result == "deep"

    spans = memory_exporter.get_finished_spans()
    assert len(spans) == 3

    spans_by_name = get_spans_by_name(memory_exporter)

    parent_span = spans_by_name["parent"]
    child_span = spans_by_name["child"]
    grandchild_span = spans_by_name["grandchild"]

    # Parent should have no parent
    assert parent_span.parent is None

    # Child should have parent as parent
    assert child_span.parent.span_id == parent_span.context.span_id

    # Grandchild should have child as parent
    assert grandchild_span.parent.span_id == child_span.context.span_id


def test_sibling_spans(memory_exporter):
    """Test multiple children at same level."""

    @observe(name="child-a")
    def child_a():
        return "a"

    @observe(name="child-b")
    def child_b():
        return "b"

    @observe(name="parent")
    def parent():
        return child_a() + child_b()

    parent()

    spans_by_name = get_spans_by_name(memory_exporter)

    parent_span = spans_by_name["parent"]

    # Both children should have same parent
    assert spans_by_name["child-a"].parent.span_id == parent_span.context.span_id
    assert spans_by_name["child-b"].parent.span_id == parent_span.context.span_id


def test_input_capture(memory_exporter):
    """Test function arguments are captured in span attributes."""

    @observe(name="process")
    def process(text, count=1):
        return f"{text}-{count}"

    process("hello", count=5)

    spans = memory_exporter.get_finished_spans()
    span = spans[0]

    # Input should be captured in traceroot.input attribute
    input_value = get_span_attribute(span, SpanAttributes.SPAN_INPUT)
    assert input_value is not None
    assert "hello" in input_value
    assert "5" in input_value


def test_output_capture(memory_exporter):
    """Test return values are captured in span attributes."""

    @observe(name="compute")
    def compute():
        return {"answer": 42}

    compute()

    spans = memory_exporter.get_finished_spans()
    span = spans[0]

    # Output should be captured in traceroot.output attribute
    output_value = get_span_attribute(span, SpanAttributes.SPAN_OUTPUT)
    assert output_value is not None
    assert "42" in output_value


def test_capture_disabled(memory_exporter):
    """Test capture_input=False and capture_output=False."""

    @observe(name="sensitive", capture_input=False, capture_output=False)
    def sensitive(password):
        return {"token": "secret"}

    result = sensitive("my-password")

    assert result == {"token": "secret"}  # Function still works

    spans = memory_exporter.get_finished_spans()
    span = spans[0]

    # Input and output should not be captured
    assert get_span_attribute(span, SpanAttributes.SPAN_INPUT) is None
    assert get_span_attribute(span, SpanAttributes.SPAN_OUTPUT) is None


def test_error_sets_span_status(memory_exporter):
    """Test exceptions set span status to ERROR."""
    from opentelemetry.trace import StatusCode

    @observe(name="failing")
    def failing(x):
        raise ValueError(f"Bad value: {x}")

    with pytest.raises(ValueError, match="Bad value: 42"):
        failing(42)

    spans = memory_exporter.get_finished_spans()
    span = spans[0]

    assert span.name == "failing"
    assert span.status.status_code == StatusCode.ERROR


def test_metadata_and_tags(memory_exporter):
    """Test metadata and tags are captured in attributes."""

    @observe(
        name="tagged-op",
        metadata={"version": "1.0", "env": "test"},
        tags=["production", "critical"],
    )
    def tagged_op():
        return "done"

    tagged_op()

    spans = memory_exporter.get_finished_spans()
    span = spans[0]

    # Check tags are set
    tags = get_span_attribute(span, SpanAttributes.SPAN_TAGS)
    assert tags is not None


def test_function_name_as_default(memory_exporter):
    """Test span uses function name when name not specified."""

    @observe()  # No name specified
    def my_special_function():
        return "result"

    my_special_function()

    spans = memory_exporter.get_finished_spans()
    span = spans[0]

    assert span.name == "my_special_function"


@pytest.mark.asyncio
async def test_async_span_hierarchy(memory_exporter):
    """Test async functions produce correct span hierarchy."""

    @observe(name="async-child")
    async def async_child():
        return "child-result"

    @observe(name="async-parent")
    async def async_parent():
        return await async_child()

    result = await async_parent()

    assert result == "child-result"

    spans = memory_exporter.get_finished_spans()
    assert len(spans) == 2

    spans_by_name = get_spans_by_name(memory_exporter)
    assert spans_by_name["async-child"].parent.span_id == spans_by_name["async-parent"].context.span_id


def test_all_spans_share_trace_id(memory_exporter):
    """Test all nested spans share the same trace ID."""

    @observe(name="level-2")
    def level_2():
        return "done"

    @observe(name="level-1")
    def level_1():
        return level_2()

    @observe(name="root")
    def root():
        return level_1()

    root()

    spans = memory_exporter.get_finished_spans()
    trace_ids = {span.context.trace_id for span in spans}

    # All spans should have the same trace ID
    assert len(trace_ids) == 1


def test_using_attributes_sets_context(memory_exporter):
    """Test using_attributes sets session_id and user_id on spans."""
    from traceroot import using_attributes

    @observe(name="with-context")
    def func_with_context():
        return "done"

    with using_attributes(session_id="sess-123", user_id="user-456"):
        func_with_context()

    spans = memory_exporter.get_finished_spans()
    assert len(spans) == 1

    span = spans[0]
    assert span.attributes.get("session.id") == "sess-123"
    assert span.attributes.get("user.id") == "user-456"


def test_using_attributes_propagates_to_children(memory_exporter):
    """Test using_attributes inside a function propagates to child spans."""
    from traceroot import using_attributes

    @observe(name="child")
    def child_func():
        return "child"

    @observe(name="parent")
    def parent_func():
        with using_attributes(session_id="sess-456"):
            return child_func()

    parent_func()

    spans = {s.name: s for s in memory_exporter.get_finished_spans()}

    # Child inherits session_id (created inside using_attributes block)
    assert spans["child"].attributes.get("session.id") == "sess-456"

    # Parent does not have session_id (created before using_attributes)
    assert spans["parent"].attributes.get("session.id") is None


def test_auto_initialization_without_explicit_initialize(memory_exporter):
    """Test @observe works without explicit traceroot.initialize() call.

    This verifies lazy initialization - the decorator triggers get_client()
    which auto-initializes the TracerootClient from environment variables.
    """
    reset_traceroot()

    # Don't call traceroot.initialize() - just use @observe directly
    @observe(name="auto-init-test")
    def my_function():
        return "it works"

    result = my_function()

    assert result == "it works"

    # Verify client was auto-initialized
    assert traceroot.get_client() is not None

    spans = memory_exporter.get_finished_spans()
    assert len(spans) == 1
    assert spans[0].name == "auto-init-test"
