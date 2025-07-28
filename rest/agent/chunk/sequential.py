from typing import Iterator

# Approximate the chunk size for number of tokens
CHUNK_SIZE = 200_000
OVERLAP_SIZE = 5_000


def sequential_chunk(
    text: str,
    chunk_size: int = CHUNK_SIZE,
    overlap_size: int = OVERLAP_SIZE,
) -> Iterator[str]:
    r"""Chunk the text sequentially with a defined overlap.

    Args:
        text (str): The text to chunk.
        chunk_size (int): The size of each chunk.
        overlap_size (int): The size of the character overlap
            between consecutive chunks.

    Returns:
        An iterator that yields string chunks.
    """
    if overlap_size >= chunk_size:
        raise ValueError("overlap_size must be smaller than chunk_size.")

    step_size = chunk_size - overlap_size
    for i in range(0, len(text), step_size):
        yield text[i:i + chunk_size]
