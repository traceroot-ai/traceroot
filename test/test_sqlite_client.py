import os
import tempfile
from datetime import datetime

import pytest

from rest.client.sqlite_client import TraceRootSQLiteClient


@pytest.mark.asyncio
async def test_sqlite_client():
    """Test the SQLite client functionality"""

    # Create a temporary database file for testing
    with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as tmp:
        test_db_path = tmp.name

    # Set environment variable for test database
    os.environ['SQLITE_DB_PATH'] = test_db_path

    try:
        # Initialize client
        client = TraceRootSQLiteClient(db_path=test_db_path)
        # Test 1: Insert and retrieve chat records
        chat_record_1 = {
            "chat_id": "test_chat_123",
            "timestamp": datetime.now(),
            "role": "user",
            "content": "Hello, how are you?",
            "user_content": "Hello, how are you?",
            "trace_id": "trace_456",
            "span_ids": ["span_1", "span_2"],
            "start_time": datetime.now(),
            "end_time": datetime.now(),
            "model": "gpt-3.5-turbo",
            "mode": "chat",
            "message_type": "text"
        }

        await client.insert_chat_record(chat_record_1)

        # Add a second message
        chat_record_2 = {
            "chat_id": "test_chat_123",
            "timestamp": datetime.now(),
            "role": "assistant",
            "content": "I'm doing well, thank you!",
            "user_content": "I'm doing well, thank you!",
            "trace_id": "trace_456",
            "span_ids": ["span_3"],
            "start_time": datetime.now(),
            "end_time": datetime.now(),
            "model": "gpt-3.5-turbo",
            "mode": "chat",
            "message_type": "text"
        }

        await client.insert_chat_record(chat_record_2)

        # Retrieve chat history
        history = await client.get_chat_history("test_chat_123")
        assert history is not None
        assert len(history) == 2
        for record in history:
            assert record["role"] in ["user", "assistant"]
            assert record["content"] is not None
            assert record["trace_id"] == "trace_456"
            assert len(record["span_ids"]) > 0
            assert record["start_time"] is not None
            assert record["end_time"] is not None
            assert record["model"] == "gpt-3.5-turbo"
            assert record["user_content"] is not None

        # Test 2: Insert and retrieve chat metadata
        metadata = {
            "chat_id": "test_chat_123",
            "timestamp": datetime.now(),
            "chat_title": "Test Conversation",
            "trace_id": "trace_456"
        }

        await client.insert_chat_metadata(metadata)

        # Retrieve metadata
        retrieved_metadata = await client.get_chat_metadata("test_chat_123")
        assert retrieved_metadata is not None
        assert retrieved_metadata.chat_title == "Test Conversation"
        assert retrieved_metadata.trace_id == "trace_456"
        assert retrieved_metadata.chat_id == "test_chat_123"
        assert retrieved_metadata.timestamp is not None

        # Test metadata history
        metadata_history = await client.get_chat_metadata_history("trace_456")
        assert len(metadata_history.history) > 0

        # Test 3: Integration tokens
        await client.insert_integration_token("user@example.com",
                                              "github_token_123", "github")

        token = await client.get_integration_token("user@example.com",
                                                   "github")
        assert token is not None

        # Test token deletion
        deleted = await client.delete_integration_token(
            "user@example.com", "github")
        assert deleted

        # Verify deletion
        token = await client.get_integration_token("user@example.com",
                                                   "github")
        assert token is None

    finally:
        # Clean up test database
        if os.path.exists(test_db_path):
            os.remove(test_db_path)
