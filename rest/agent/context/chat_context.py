from rest.constants import MAX_PREV_RECORD


def build_chat_history_messages(
    chat_history: list[dict] | None,
    max_records: int = MAX_PREV_RECORD
) -> list[dict[str,
               str]]:
    """
    Process and format chat history for agent context.

    Filters out system messages (github, statistics) and extracts the
    appropriate content field (user_message for user role, content otherwise).
    Returns the last N records to maintain context window limits.

    Args:
        chat_history (list[dict] | None): Raw chat history from database
        max_records (int): Maximum number of history records to include

    Returns:
        list[dict[str, str]]: Formatted messages with 'role' and 'content' keys
    """
    if chat_history is None:
        return []

    # Filter out github and statistics messages
    filtered_history = [
        chat for chat in chat_history if chat["role"] not in ["github", "statistics"]
    ]

    # Take only the last N records
    recent_history = filtered_history[-max_records:]

    # Format messages with appropriate content extraction
    messages = []
    for record in recent_history:
        # For user messages, prefer user_message (without context) over content
        if "user_message" in record and record["user_message"] is not None:
            content = record["user_message"]
        else:
            content = record["content"]

        messages.append({
            "role": record["role"],
            "content": content,
        })

    print(f"context messages: {messages}")
    return messages
