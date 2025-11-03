from rest.agent.chunk.sequential import sequential_chunk


def get_trace_context_messages(context: str) -> list[str]:
    """
    Convert trace context into formatted message chunks.

    Chunks large trace contexts and formats them with appropriate headers.
    Used by agents that work with trace data (SingleRCAAgent, CodeAgent).

    Args:
        context (str): The trace context to be chunked (usually JSON string)

    Returns:
        list[str]: List of context message chunks with formatting
    """
    context_chunks = list(sequential_chunk(context))

    if len(context_chunks) == 1:
        messages = [
            (
                f"\n\nHere is the structure of the tree with related "
                "information:\n\n"
                f"{context_chunks[0]}"
            )
        ]
        print(f"trace_context_messages: {messages}")
        return messages

    messages: list[str] = []
    for i, chunk in enumerate(context_chunks):
        messages.append(
            f"\n\nHere is the structure of the tree "
            f"with related information of the "
            f"{i + 1}th chunk of the tree:\n\n"
            f"{chunk}"
        )
    return messages
