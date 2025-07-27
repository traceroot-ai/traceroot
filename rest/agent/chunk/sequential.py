# Approximate the chunk size for number of tokens
CHUNK_SIZE = 200_000
OVERLAP_SIZE = 5_000 # CHUNK_SIZE - WINDOW_SIZE


def create_overlapping_chunks(
    text: str,
    chunk_size: int = CHUNK_SIZE,
    overlap_size: int = OVERLAP_SIZE,
) -> list[str]:
    r"""Chunks a text into overlapping segments.

    This version is a generator, making it more memory-efficient for large texts.

    Args:
        text (str): The text to chunk.
        chunk_size (int): The maximum size of each chunk.
        overlap_size (int): The number of characters to overlap between chunks.

    Yields:
        str: The next chunk of text.
    """
    if overlap_size >= chunk_size:
        raise ValueError("overlap_size must be smaller than chunk_size.")

    step_size = chunk_size - overlap_size
    for i in range(0, len(text), step_size):
        yield text[i:i + chunk_size]