from typing import Iterator;

# Approximate the chunk size for number of tokens
CHUNK_SIZE = 200_000
OVERLAP_SIZE = 5_000  # CHUNK_SIZE - WINDOW_SIZE


def sequential_chunk(
    text: str,
    chunk_size: int = CHUNK_SIZE,
    overlap_size: int = OVERLAP_SIZE,
) -> Iterator[str]:
    r"""Chunk the text sequentially.

    Args:
        text (str): The text to chunk.
        chunk_size (int): The size of each chunk.
        window_size (int): The size of the window to
            slide, which means there is CHUNK_SIZE - WINDOW_SIZE overlap
            size between chunks.

    Returns:
        A list of chunks.
    """
    if overlap_size >= chunk_size:
        raise ValueError("overlap_size must be smaller than chunk_size.")

    step_size = chunk_size - overlap_size
    for i in range(0, len(text), step_size):
        yield text[i:i + chunk_size]
