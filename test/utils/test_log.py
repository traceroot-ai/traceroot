import json

from rest.utils.constants import SKIP_LOG_FIELDS
from rest.utils.log import _load_json


def test_load_json_with_skip_fields():
    """Test that _load_json creates a filtered JSON message with non-skipped fields"""

    # Create test data with both skipped and non-skipped fields
    test_data = {
        "message": "Test log message",
        "level": "info",
        "timestamp": "2025-08-21 02:14:39,175",
        "service_name": "test-service",
        "github_commit_hash": "abc123",
        "github_owner": "test-owner",
        "github_repo_name": "test-repo",
        "environment": "development",
        "userId": "user123",
        "requestId": "req456",
        "trace_id": "1-998fb9ed-9c366715fad58dfe34c822a4",
        "span_id": "e046c62b8f0667e7",
        "ingestionTime": 1755767680543,
        "eventId": "39154927641119437560701839122329487456907060165707235328",
        "stack_trace": "examples/simple-example.ts:makeRequest:8"
    }

    message_json = json.dumps(test_data)

    # Call the function
    log_entry, span_id = _load_json(message_json)

    # Verify that the function returned successfully
    assert log_entry is not None
    assert span_id is not None
    assert span_id == "e046c62b8f0667e7"

    # Parse the returned message to verify it's valid JSON
    parsed_message = json.loads(log_entry.message)

    # Verify the original message is preserved
    assert parsed_message["message"] == "Test log message"

    # Verify non-skipped fields are included
    assert parsed_message["userId"] == "user123"
    assert parsed_message["requestId"] == "req456"

    # Verify skipped fields are NOT included
    for field in SKIP_LOG_FIELDS:
        not_in_message = field not in parsed_message
        if field in test_data:  # Only check fields that were in the original data
            assert not_in_message, f"Skipped field '{field}' should not be in"

    # Verify the message is valid JSON
    assert isinstance(parsed_message, dict)


def test_load_json_without_extra_fields():
    """Test that _load_json returns plain message when all
    fields are skipped except message
    """

    # Create minimal test data
    test_data = {
        "message": "Simple message",
        "level": "info",
        "timestamp": "2025-08-21 02:14:39,175",
        "github_owner": "test-owner",
        "github_repo_name": "test-repo",
        "github_commit_hash": "abc123",
        "span_id": "span123",
        "stack_trace": "examples/simple-example.ts:makeRequest:8"
    }

    message_json = json.dumps(test_data)

    # Call the function
    log_entry, span_id = _load_json(message_json)

    # Verify that the function returned successfully
    assert log_entry is not None
    assert span_id == "span123"

    # When only message field remains after filtering (len(filtered_data) == 1),
    # the function returns the plain message string, not JSON
    assert log_entry.message == "Simple message"


def test_load_json_with_mixed_fields():
    """Test that _load_json correctly filters mixed skipped and non-skipped fields"""

    test_data = {
        "message": "Mixed fields message",
        "level": "error",
        "timestamp": "2025-08-21 02:14:39,175",
        "service_name": "should-be-skipped",  # skipped
        "customField": "should-be-included",  # not skipped
        "github_owner": "test-owner",  # skipped but needed for processing
        "github_repo_name": "test-repo",  # skipped but needed
        "github_commit_hash": "abc123",  # skipped but needed
        "span_id": "span456",  # skipped but needed
        "requestId": "req789",  # not skipped
        "stack_trace": "examples/simple-example.ts:makeRequest:8"
    }

    message_json = json.dumps(test_data)

    # Call the function
    log_entry, span_id = _load_json(message_json)

    # Verify that the function returned successfully
    assert log_entry is not None
    assert span_id == "span456"

    # Parse the returned message
    parsed_message = json.loads(log_entry.message)

    # Verify correct filtering
    assert parsed_message["message"] == "Mixed fields message"
    assert parsed_message["customField"] == "should-be-included"
    assert parsed_message["requestId"] == "req789"

    # Verify skipped fields are not included
    assert "service_name" not in parsed_message
    assert "level" not in parsed_message
    assert "timestamp" not in parsed_message
    assert "github_owner" not in parsed_message
    assert "span_id" not in parsed_message


def test_load_json_returns_plain_message_when_only_message_field():
    """Test that _load_json returns plain message string when
    filtered_data has only message field.
    """

    # Create test data where all fields except message are in SKIP_LOG_FIELDS
    test_data = {
        "message": "Only message should remain",
        "level": "info",  # skipped
        "timestamp": "2025-08-21 02:14:39,175",  # skipped
        "service_name": "test-service",  # skipped
        "github_owner": "test-owner",  # skipped
        "github_repo_name": "test-repo",  # skipped
        "github_commit_hash": "abc123",  # skipped
        "span_id": "span123",  # skipped
        "stack_trace": "examples/simple-example.ts:makeRequest:8"
    }

    message_json = json.dumps(test_data)

    # Call the function
    log_entry, span_id = _load_json(message_json)

    # Verify that the function returned successfully
    assert log_entry is not None
    assert span_id == "span123"

    # The key test: when len(filtered_data) == 1, message should be plain string, not JSON
    assert log_entry.message == "Only message should remain"

    # Verify it's NOT a JSON string (should not be parseable as JSON)
    try:
        parsed = json.loads(log_entry.message)
        # If we can parse it as JSON, it should only be a simple string, not a dict
        assert isinstance(parsed, str)
    except json.JSONDecodeError:
        # This is expected - the message should be a plain string, not JSON
        pass
