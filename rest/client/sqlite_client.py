import json
import os
from datetime import datetime
from typing import Any

import aiosqlite

from rest.config import ChatMetadata, ChatMetadataHistory, WorkflowCheckbox
from rest.config.workflow import (Pattern, WorkflowItemRequest,
                                  WorkflowTableData)

DB_PATH = os.getenv("SQLITE_DB_PATH", "traceroot.db")


class TraceRootSQLiteClient:

    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path

    async def _init_db(self):
        """Initialize the database tables if they don't exist"""
        async with aiosqlite.connect(self.db_path) as db:
            # Run migrations first
            await self._run_migrations(db)
            # Chat records table
            await db.execute("""
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
                    reference TEXT
                )
            """)

            # Chat metadata table
            await db.execute("""
                CREATE TABLE IF NOT EXISTS chat_metadata (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id TEXT NOT NULL UNIQUE,
                    timestamp TEXT NOT NULL,
                    chat_title TEXT NOT NULL,
                    trace_id TEXT NOT NULL
                )
            """)

            # Connection tokens table
            await db.execute("""
                CREATE TABLE IF NOT EXISTS connection_tokens (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_email TEXT NOT NULL,
                    token_type TEXT NOT NULL,
                    token TEXT NOT NULL,
                    UNIQUE(user_email, token_type)
                )
            """)

            # Create indexes for better performance
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_chat_records_chat_id "
                "ON chat_records(chat_id)")
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_chat_records_timestamp "
                "ON chat_records(timestamp)")
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_chat_metadata_trace_id "
                "ON chat_metadata(trace_id)")
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_connection_tokens_user_email "
                "ON connection_tokens(user_email)")

            # Workflow configuration table
            await db.execute("""
                CREATE TABLE IF NOT EXISTS workflow_config (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_email TEXT NOT NULL UNIQUE,
                    summarization BOOLEAN DEFAULT FALSE,
                    issue_creation BOOLEAN DEFAULT FALSE,
                    pr_creation BOOLEAN DEFAULT FALSE,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                )
            """)
            await db.execute("CREATE INDEX IF NOT EXISTS "
                             "idx_workflow_config_user_email "
                             "ON workflow_config(user_email)")

            # Workflow items table
            await db.execute("""
                CREATE TABLE IF NOT EXISTS workflow_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_email TEXT NOT NULL,
                    trace_id TEXT NOT NULL,
                    service_name TEXT NOT NULL,
                    error_count INTEGER DEFAULT 0,
                    summarization TEXT DEFAULT '-',
                    created_issue TEXT DEFAULT '-',
                    created_pr TEXT DEFAULT '-',
                    summarization_chat_id TEXT,
                    created_issue_chat_id TEXT,
                    created_pr_chat_id TEXT,
                    pattern_id TEXT NOT NULL,
                    pattern_description TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(user_email, trace_id)
                )
            """)
            await db.execute("CREATE INDEX IF NOT EXISTS "
                             "idx_workflow_items_user_email "
                             "ON workflow_items(user_email)")
            await db.execute("CREATE INDEX IF NOT EXISTS "
                             "idx_workflow_items_trace_id "
                             "ON workflow_items(trace_id)")
            await db.execute("CREATE INDEX IF NOT EXISTS "
                             "idx_workflow_items_timestamp "
                             "ON workflow_items(timestamp)")

            # Pattern table
            await db.execute("""
                CREATE TABLE IF NOT EXISTS patterns (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    pattern_id TEXT NOT NULL UNIQUE,
                    trace_id TEXT NOT NULL,
                    pattern_description TEXT NOT NULL,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(pattern_description)
                )
            """)
            await db.execute("CREATE INDEX IF NOT EXISTS "
                             "idx_patterns_pattern_id "
                             "ON patterns(pattern_id)")
            await db.execute("CREATE INDEX IF NOT EXISTS "
                             "idx_patterns_trace_id "
                             "ON patterns(trace_id)")
            await db.execute("CREATE INDEX IF NOT EXISTS "
                             "idx_patterns_description "
                             "ON patterns(pattern_description)")

    async def _run_migrations(self, db):
        """Run database migrations to add new columns to existing tables"""
        try:
            # Check if the new columns exist in workflow_items table
            cursor = await db.execute("PRAGMA table_info(workflow_items)")
            columns = await cursor.fetchall()
            column_names = [column[1] for column in columns]

            # Add new columns if they don't exist
            if 'summarization_chat_id' not in column_names:
                await db.execute("ALTER TABLE workflow_items ADD "
                                 "COLUMN summarization_chat_id TEXT")
            if 'created_issue_chat_id' not in column_names:
                await db.execute("ALTER TABLE workflow_items ADD "
                                 "COLUMN created_issue_chat_id TEXT")
            if 'created_pr_chat_id' not in column_names:
                await db.execute("ALTER TABLE workflow_items ADD "
                                 "COLUMN created_pr_chat_id TEXT")

            await db.commit()
        except Exception:
            # If the table doesn't exist yet, migrations
            # will be handled by table creation
            pass

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
                ("SELECT * FROM chat_records WHERE chat_id = ? "
                 "ORDER BY timestamp ASC"), (chat_id, ))
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
            timestamp = message.get("timestamp", datetime.now().isoformat())
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
                ("INSERT INTO chat_records (\n"
                 "    chat_id, timestamp, role, content, "
                 "user_content, trace_id, span_ids,\n"
                 "    start_time, end_time, model, mode, message_type,\n"
                 "    chunk_id, action_type, status, user_message,\n"
                 "    context, reference\n"
                 ") VALUES (\n"
                 "    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?\n"
                 ")"), (message["chat_id"], timestamp, message.get(
                     "role", ""), message.get("content", ""),
                        message.get("user_content"), message.get("trace_id"),
                        span_ids, start_time, end_time, message.get("model"),
                        message.get("mode"), message.get("message_type"),
                        message.get("chunk_id"), message.get("action_type"),
                        message.get("status"), message.get("user_message"),
                        message.get("context"), reference))
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
            timestamp = metadata.get("timestamp", datetime.now().isoformat())
            if isinstance(timestamp, datetime):
                timestamp = timestamp.isoformat()

            # Use INSERT OR REPLACE to handle duplicates
            await db.execute(
                """
                INSERT OR REPLACE INTO chat_metadata (
                    chat_id, timestamp, chat_title, trace_id
                ) VALUES (?, ?, ?, ?)
            """, (metadata["chat_id"], timestamp, metadata.get(
                    "chat_title", ""), metadata.get("trace_id", "")))
            await db.commit()

    async def get_chat_metadata_history(
        self,
        trace_id: str,
    ) -> ChatMetadataHistory:
        await self._init_db()

        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM chat_metadata WHERE trace_id = ?", (trace_id, ))
            rows = await cursor.fetchall()

            items = []
            for row in rows:
                item = dict(row)
                # Convert timestamp string back to datetime
                if item["timestamp"]:
                    item["timestamp"] = datetime.fromisoformat(
                        item["timestamp"])
                items.append(ChatMetadata(**item))

            return ChatMetadataHistory(history=items)

    async def get_chat_metadata(self, chat_id: str) -> ChatMetadata | None:
        await self._init_db()

        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM chat_metadata WHERE chat_id = ?", (chat_id, ))
            row = await cursor.fetchone()

            if row is None:
                return None

            item = dict(row)
            # Convert timestamp string back to datetime
            if item["timestamp"]:
                item["timestamp"] = datetime.fromisoformat(item["timestamp"])

            return ChatMetadata(**item)

    async def insert_traceroot_token(
        self,
        token: str,
        user_credentials: dict[str, Any],
        delete_existing: bool = False,
    ):
        """
        Args:
            token (str): The traceroot token
            user_credentials (dict[str, Any]): The user's AWS credentials
        """
        return

    async def insert_integration_token(self, user_email: str, token: str,
                                       token_type: str):
        """
        Args:
            user_email (str): The user's email address
            token (str): The connection token
            token_type (str): The type of token
                (e.g., "github", "notion", "slack")
        """
        await self._init_db()

        async with aiosqlite.connect(self.db_path) as db:
            # Use INSERT OR REPLACE to handle existing tokens
            await db.execute(
                ("INSERT OR REPLACE INTO connection_tokens (user_email, "
                 "token_type, token) VALUES (?, ?, ?)"),
                (user_email, token_type, token))
            await db.commit()

    async def delete_integration_token(
        self,
        user_email: str,
        token_type: str,
    ) -> bool:
        """
        Args:
            user_email (str): The user's email address
            token_type (str): The type of token to delete

        Returns:
            bool: True if token was deleted, False if not found
        """
        await self._init_db()

        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                ("DELETE FROM connection_tokens WHERE user_email "
                 "= ? AND token_type = ?"), (user_email, token_type))
            await db.commit()
            return cursor.rowcount > 0

    async def delete_traceroot_token(self, hashed_user_sub: str) -> bool:
        """
        Args:
            hashed_user_sub (str): The hashed user sub
        """

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
                ("SELECT token FROM connection_tokens WHERE "
                 "user_email = ? AND token_type = ?"),
                (user_email, token_type))
            row = await cursor.fetchone()
            return row[0] if row else None

    async def get_traceroot_token(self, hashed_user_sub: str) -> str | None:
        """
        Returns:
            str | None: The token if found, None otherwise
        """
        return

    async def get_traceroot_credentials_by_token(
            self, token: str) -> dict[str, Any] | None:
        """
        Query traceroot credentials by token.

        Args:
            token (str): The traceroot token to search for

        Returns:
            dict[str, Any] | None: The full
                credentials if found, None otherwise
        """
        return

    async def get_workflow(self, user_email: str) -> WorkflowCheckbox | None:
        """Get workflow configuration for a user.

        Args:
            user_email: The user email to look up

        Returns:
            WorkflowCheckbox object if found, None otherwise
        """
        await self._init_db()
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                ("SELECT summarization, issue_creation, pr_creation "
                 "FROM workflow_config WHERE user_email = ?"), (user_email, ))
            row = await cursor.fetchone()
            if row:
                return WorkflowCheckbox(summarization=bool(row[0]),
                                        issue_creation=bool(row[1]),
                                        pr_creation=bool(row[2]))
            return None

    async def insert_workflow(self, user_email: str,
                              checkbox_type: str) -> bool:
        """Insert or update workflow configuration for a user.

        Args:
            user_email: The user email
            checkbox_type: The checkbox type to enable

        Returns:
            True if successful, False otherwise
        """
        await self._init_db()
        try:
            async with aiosqlite.connect(self.db_path) as db:
                # First, get existing configuration
                cursor = await db.execute(
                    ("SELECT summarization, issue_creation, pr_creation "
                     "FROM workflow_config WHERE user_email = ?"),
                    (user_email, ))
                row = await cursor.fetchone()

                if row:
                    # Update existing record
                    summarization, issue_creation, pr_creation = row
                    if checkbox_type == 'summarization':
                        summarization = True
                    elif checkbox_type == 'issue_creation':
                        issue_creation = True
                    elif checkbox_type == 'pr_creation':
                        pr_creation = True

                    await db.execute(
                        ("UPDATE workflow_config SET summarization = ?, "
                         "issue_creation = ?, pr_creation = ? WHERE "
                         "user_email = ?"), (summarization, issue_creation,
                                             pr_creation, user_email))
                else:
                    # Insert new record
                    summarization = checkbox_type == 'summarization'
                    issue_creation = checkbox_type == 'issue_creation'
                    pr_creation = checkbox_type == 'pr_creation'

                    await db.execute(
                        ("INSERT INTO workflow_config (user_email, "
                         "summarization, issue_creation, pr_creation) "
                         "VALUES (?, ?, ?, ?)"), (user_email, summarization,
                                                  issue_creation, pr_creation))

                await db.commit()
                return True
        except Exception:
            return False

    async def delete_workflow(self, user_email: str,
                              checkbox_type: str) -> bool:
        """Delete workflow configuration for a user.

        Args:
            user_email: The user email
            checkbox_type: The checkbox type to disable

        Returns:
            True if successful, False otherwise
        """
        await self._init_db()
        try:
            async with aiosqlite.connect(self.db_path) as db:
                # Get existing configuration
                cursor = await db.execute(
                    ("SELECT summarization, issue_creation, "
                     "pr_creation FROM workflow_config WHERE "
                     "user_email = ?"), (user_email, ))
                row = await cursor.fetchone()

                if row:
                    # Update existing record by disabling the specified
                    # checkbox
                    summarization, issue_creation, pr_creation = row
                    if checkbox_type == 'summarization':
                        summarization = False
                    elif checkbox_type == 'issue_creation':
                        issue_creation = False
                    elif checkbox_type == 'pr_creation':
                        pr_creation = False

                    await db.execute(
                        ("UPDATE workflow_config SET summarization = ?, "
                         "issue_creation = ?, pr_creation = ? WHERE "
                         "user_email = ?"), (summarization, issue_creation,
                                             pr_creation, user_email))
                    await db.commit()
                    return True
                else:
                    # No existing configuration, nothing to delete
                    return True
        except Exception:
            return False

    async def get_workflow_items(
            self, user_email: str) -> list[WorkflowTableData] | None:
        """Get all workflow items for a user.

        Args:
            user_email: The user email

        Returns:
            List of WorkflowTableData objects if found,
                empty list if none found, None on error
        """
        await self._init_db()
        try:
            async with aiosqlite.connect(self.db_path) as db:
                cursor = await db.execute(
                    ("SELECT trace_id, service_name, error_count, "
                     "summarization, created_issue, created_pr, "
                     "summarization_chat_id, created_issue_chat_id, "
                     "created_pr_chat_id, "
                     "pattern_id, pattern_description, timestamp FROM "
                     "workflow_items WHERE "
                     "user_email = ? ORDER BY timestamp DESC"), (user_email, ))
                rows = await cursor.fetchall()

                if rows:
                    workflow_items = []
                    for row in rows:
                        pattern = Pattern(pattern_id=row[9],
                                          pattern_description=row[10])
                        workflow_item = WorkflowTableData(
                            trace_id=row[0],
                            service_name=row[1],
                            error_count=row[2],
                            summarization=row[3],
                            created_issue=row[4],
                            created_pr=row[5],
                            summarization_chat_id=row[6],
                            created_issue_chat_id=row[7],
                            created_pr_chat_id=row[8],
                            pattern=pattern,
                            timestamp=row[11])
                        workflow_items.append(workflow_item)
                    return workflow_items
                return []
        except Exception:
            return None

    async def insert_workflow_item(self, user_email: str,
                                   workflow_item: WorkflowItemRequest) -> bool:
        """Insert or update a workflow item for a user.

        Args:
            user_email: The user email
            workflow_item: The workflow item data

        Returns:
            True if successful, False otherwise
        """
        await self._init_db()
        try:
            async with aiosqlite.connect(self.db_path) as db:
                # Use INSERT OR REPLACE to handle duplicates based on
                # unique constraint
                await db.execute(
                    ("INSERT OR REPLACE INTO workflow_items "
                     "(user_email, trace_id, service_name, error_count, "
                     "summarization, created_issue, created_pr, "
                     "summarization_chat_id, created_issue_chat_id, "
                     "created_pr_chat_id, "
                     "pattern_id, pattern_description, timestamp, updated_at) "
                     "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
                     "CURRENT_TIMESTAMP)"),
                    (user_email, workflow_item.trace_id,
                     workflow_item.service_name, workflow_item.error_count,
                     workflow_item.summarization, workflow_item.created_issue,
                     workflow_item.created_pr,
                     workflow_item.summarization_chat_id,
                     workflow_item.created_issue_chat_id,
                     workflow_item.created_pr_chat_id,
                     workflow_item.pattern.pattern_id,
                     workflow_item.pattern.pattern_description,
                     workflow_item.timestamp))
                await db.commit()
                return True
        except Exception:
            return False

    async def delete_workflow_item(self, user_email: str,
                                   trace_id: str) -> bool:
        """Delete a workflow item for a user by trace_id.

        Args:
            user_email: The user email
            trace_id: The trace ID to delete

        Returns:
            True if successful, False otherwise
        """
        await self._init_db()
        try:
            async with aiosqlite.connect(self.db_path) as db:
                await db.execute(
                    ("DELETE FROM workflow_items WHERE user_email = ? "
                     "AND trace_id = ?"), (user_email, trace_id))
                await db.commit()
                return True
        except Exception:
            return False

    async def check_pattern_exists(
        self,
        pattern_description: str,
    ) -> str | None:
        """Check if a pattern already exists based on description.

        Args:
            pattern_description: The pattern description to check

        Returns:
            The pattern_id if found, None otherwise
        """
        await self._init_db()
        try:
            async with aiosqlite.connect(self.db_path) as db:
                cursor = await db.execute(
                    ("SELECT pattern_id FROM patterns WHERE "
                     "pattern_description = ?"), (pattern_description, ))
                row = await cursor.fetchone()
                return row[0] if row else None
        except Exception:
            return None

    async def insert_pattern(self, pattern_id: str, trace_id: str,
                             pattern_description: str) -> bool:
        """Insert a new pattern.

        Args:
            pattern_id: The UUID for the pattern
            trace_id: The trace ID associated with the pattern
            pattern_description: The pattern description

        Returns:
            True if successful, False otherwise
        """
        await self._init_db()
        try:
            async with aiosqlite.connect(self.db_path) as db:
                await db.execute(
                    ("INSERT OR IGNORE INTO patterns "
                     "(pattern_id, trace_id, pattern_description) "
                     "VALUES (?, ?, ?)"),
                    (pattern_id, trace_id, pattern_description))
                await db.commit()
                return True
        except Exception:
            return False
