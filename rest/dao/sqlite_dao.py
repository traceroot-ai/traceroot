import json
import os
from datetime import datetime, timezone
from typing import Any

import aiosqlite

from rest.config import ChatMetadata, ChatMetadataHistory

DB_PATH = os.getenv("SQLITE_DB_PATH", "traceroot.db")


class TraceRootSQLiteClient:

    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path

    async def _init_db(self):
        """Initialize the database tables if they don't exist"""
        async with aiosqlite.connect(self.db_path) as db:
            # Chat records table
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS chat_records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    user_content TEXT,
                    trace_id TEXT,
                    span_ids TEXT,
                    start_time TEXT,
                    end_time TEXT,
                    model TEXT,
                    mode TEXT,
                    message_type TEXT,
                    chunk_id INTEGER,
                    action_type TEXT,
                    status TEXT,
                    user_message TEXT,
                    context TEXT,
                    reference TEXT,
                    is_streaming BOOLEAN,
                    stream_update BOOLEAN
                )
            """
            )

            # Chat metadata table
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS chat_metadata (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id TEXT NOT NULL UNIQUE,
                    timestamp TEXT NOT NULL,
                    chat_title TEXT NOT NULL,
                    trace_id TEXT NOT NULL
                )
            """
            )

            # Connection tokens table
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS connection_tokens (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_email TEXT NOT NULL,
                    token_type TEXT NOT NULL,
                    token TEXT NOT NULL,
                    UNIQUE(user_email, token_type)
                )
            """
            )

            # Reasoning records table (dedicated reasoning storage)
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS reasoning_records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id TEXT NOT NULL,
                    chunk_id INTEGER NOT NULL,
                    content TEXT NOT NULL,
                    status TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    trace_id TEXT,
                    updated_at TEXT
                )
            """
            )

            # Create indexes for better performance
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_chat_records_chat_id "
                "ON chat_records(chat_id)"
            )
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_chat_records_timestamp "
                "ON chat_records(timestamp)"
            )
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_chat_metadata_trace_id "
                "ON chat_metadata(trace_id)"
            )
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_connection_tokens_user_email "
                "ON connection_tokens(user_email)"
            )
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_reasoning_records_chat_id "
                "ON reasoning_records(chat_id)"
            )
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_reasoning_records_chunk_id "
                "ON reasoning_records(chat_id, chunk_id)"
            )

            await db.commit()

    async def get_chat_history(
        self,
        chat_id: str | None = None,
    ) -> list[dict] | None:
        if chat_id is None:
            return None

        await self._init_db()

        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                (
                    "SELECT * FROM chat_records WHERE chat_id = ? "
                    "AND (is_streaming IS NULL OR is_streaming = 0) "
                    "AND (stream_update IS NULL OR stream_update = 0) "
                    "ORDER BY timestamp ASC"
                ),
                (chat_id,
                 )
            )
            rows = await cursor.fetchall()

            items = []
            for row in rows:
                item = dict(row)
                # Parse JSON fields if they exist
                if item["span_ids"]:
                    item["span_ids"] = json.loads(item["span_ids"])
                if item["reference"]:
                    item["reference"] = json.loads(item["reference"])
                items.append(item)

            return items

    async def insert_chat_record(self, message: dict[str, Any]):
        """
        Args:
            message (dict[str, Any]): The message to insert, including
                chat_id, timestamp, role and content.
        """
        assert message["chat_id"] is not None

        await self._init_db()

        async with aiosqlite.connect(self.db_path) as db:
            # Convert datetime to string if needed
            timestamp = message.get(
                "timestamp",
                datetime.now().astimezone(timezone.utc).isoformat()
            )
            if isinstance(timestamp, datetime):
                timestamp = timestamp.isoformat()

            # Handle span_ids as JSON
            span_ids = message.get("span_ids")
            if isinstance(span_ids, (list, dict)):
                span_ids = json.dumps(span_ids)

            # Handle datetime fields
            start_time = message.get("start_time")
            if isinstance(start_time, datetime):
                start_time = start_time.isoformat()

            end_time = message.get("end_time")
            if isinstance(end_time, datetime):
                end_time = end_time.isoformat()

            # Handle reference field as JSON
            reference = message.get("reference")
            if isinstance(reference, (list, dict)):
                reference = json.dumps(reference)

            await db.execute(
                (
                    "INSERT INTO chat_records (\n"
                    "    chat_id, timestamp, role, content, "
                    "user_content, trace_id, span_ids,\n"
                    "    start_time, end_time, model, mode, message_type,\n"
                    "    chunk_id, action_type, status, user_message,\n"
                    "    context, reference, is_streaming, stream_update\n"
                    ") VALUES (\n"
                    "    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?\n"
                    ")"
                ),
                (
                    message["chat_id"],
                    timestamp,
                    message.get("role",
                                ""),
                    message.get("content",
                                ""),
                    message.get("user_content"),
                    message.get("trace_id"),
                    span_ids,
                    start_time,
                    end_time,
                    message.get("model"),
                    message.get("mode"),
                    message.get("message_type"),
                    message.get("chunk_id"),
                    message.get("action_type"),
                    message.get("status"),
                    message.get("user_message"),
                    message.get("context"),
                    reference,
                    message.get("is_streaming"),
                    message.get("stream_update")
                )
            )
            await db.commit()

    async def insert_chat_metadata(self, metadata: dict[str, Any]):
        """
        Args:
            metadata (dict[str, Any]): The metadata to insert, including
                chat_id, timestamp, and chat_title.
        """
        assert metadata["chat_id"] is not None

        await self._init_db()

        async with aiosqlite.connect(self.db_path) as db:
            # Convert datetime to string if needed
            timestamp = metadata.get(
                "timestamp",
                datetime.now().astimezone(timezone.utc).isoformat()
            )
            if isinstance(timestamp, datetime):
                timestamp = timestamp.isoformat()

            # Use INSERT OR REPLACE to handle duplicates
            await db.execute(
                """
                INSERT OR REPLACE INTO chat_metadata (
                    chat_id, timestamp, chat_title, trace_id
                ) VALUES (?, ?, ?, ?)
            """,
                (
                    metadata["chat_id"],
                    timestamp,
                    metadata.get("chat_title",
                                 ""),
                    metadata.get("trace_id",
                                 "")
                )
            )
            await db.commit()

    async def get_chat_metadata_history(
        self,
        trace_id: str,
    ) -> ChatMetadataHistory:
        await self._init_db()

        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM chat_metadata WHERE trace_id = ?",
                (trace_id,
                 )
            )
            rows = await cursor.fetchall()

            items = []
            for row in rows:
                item = dict(row)
                # Convert timestamp string back to datetime
                if item["timestamp"]:
                    item["timestamp"] = datetime.fromisoformat(item["timestamp"])
                items.append(ChatMetadata(**item))

            return ChatMetadataHistory(history=items)

    async def get_chat_metadata(self, chat_id: str) -> ChatMetadata | None:
        await self._init_db()

        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM chat_metadata WHERE chat_id = ?",
                (chat_id,
                 )
            )
            row = await cursor.fetchone()

            if row is None:
                return None

            item = dict(row)
            # Convert timestamp string back to datetime
            if item["timestamp"]:
                item["timestamp"] = datetime.fromisoformat(item["timestamp"])

            return ChatMetadata(**item)

    async def insert_reasoning_record(self, reasoning_data: dict[str, Any]):
        """Insert reasoning/thinking data into dedicated reasoning table."""
        await self._init_db()

        async with aiosqlite.connect(self.db_path) as db:
            # Convert datetime to string if needed - ensure UTC consistency
            timestamp = reasoning_data.get(
                "timestamp",
                datetime.now().astimezone(timezone.utc)
            )
            if isinstance(timestamp, datetime):
                timestamp = timestamp.isoformat()

            await db.execute(
                """
                INSERT INTO reasoning_records (
                    chat_id, chunk_id, content, status, timestamp, trace_id
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    reasoning_data["chat_id"],
                    reasoning_data["chunk_id"],
                    reasoning_data["content"],
                    reasoning_data["status"],
                    timestamp,
                    reasoning_data.get("trace_id")
                )
            )
            await db.commit()

    async def update_reasoning_status(self, chat_id: str, chunk_id: int, status: str):
        """Update the status of ALL reasoning records for a chat/chunk."""
        await self._init_db()

        async with aiosqlite.connect(self.db_path) as db:
            updated_at = datetime.now().astimezone(timezone.utc).isoformat()
            await db.execute(
                """
                UPDATE reasoning_records
                SET status = ?, updated_at = ?
                WHERE chat_id = ? AND chunk_id = ?
                """,
                (status,
                 updated_at,
                 chat_id,
                 chunk_id)
            )
            await db.commit()

    async def get_chat_reasoning(self, chat_id: str) -> list[dict]:
        """Get reasoning/thinking data for a specific chat from
        dedicated reasoning table.
        """
        await self._init_db()

        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                """
                SELECT chunk_id, content, status, timestamp, trace_id
                FROM reasoning_records
                WHERE chat_id = ?
                ORDER BY chunk_id ASC, timestamp ASC
                """,
                (chat_id,
                 )
            )
            rows = await cursor.fetchall()

            reasoning_data = []
            for row in rows:
                item = dict(row)
                reasoning_data.append(
                    {
                        "chunk_id": item["chunk_id"] or 0,
                        "content": item["content"] or "",
                        "status": item["status"] or "pending",
                        "timestamp": item["timestamp"],
                        "trace_id": item["trace_id"]
                    }
                )

            return reasoning_data

    async def insert_traceroot_token(
        self,
        token: str,
        user_credentials: dict[str,
                               Any],
        delete_existing: bool = False,
    ):
        """
        Args:
            token (str): The traceroot token
            user_credentials (dict[str, Any]): The user's AWS credentials
        """
        return

    async def get_integration_token(
        self,
        user_email: str,
        token_type: str,
    ) -> str | None:
        """
        Args:
            user_email (str): The user's email address
            token_type (str): The type of token to retrieve

        Returns:
            str | None: The token if found, None otherwise
        """
        await self._init_db()

        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                (
                    "SELECT token FROM connection_tokens WHERE "
                    "user_email = ? AND token_type = ?"
                ),
                (user_email,
                 token_type)
            )
            row = await cursor.fetchone()
            return row[0] if row else None

    async def get_traceroot_credentials_by_token(self,
                                                 token: str) -> dict[str,
                                                                     Any] | None:
        """
        Query traceroot credentials by token.

        Args:
            token (str): The traceroot token to search for

        Returns:
            dict[str, Any] | None: The full
                credentials if found, None otherwise
        """
        return
