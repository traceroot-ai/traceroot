import re
from typing import Iterator, List

CHUNK_SIZE = 200_000
OVERLAP_SIZE = 5_000


def structure_aware_chunk(
    text: str,
    chunk_size: int = CHUNK_SIZE,
    overlap_size: int = OVERLAP_SIZE,
) -> Iterator[str]:
    r"""Chunk text by respecting paragraph and sentence boundaries.

    Args:
        text (str): The text to chunk.
        chunk_size (int): Max size of each chunk (in characters).
        overlap_size (int): Approx overlap between consecutive chunks.

    Yields:
        str: A chunk of text.
    """
    if overlap_size >= chunk_size:
        raise ValueError("overlap_size must be smaller than chunk_size.")

    # Split by double newlines into paragraphs
    paragraphs = text.split("\n\n")

    current_chunk: List[str] = []
    current_length = 0

    def flush_chunk():
        """Helper to yield current chunk with overlap handling."""
        nonlocal current_chunk, current_length
        if current_chunk:
            chunk_text = " ".join(current_chunk).strip()
            if chunk_text:
                yield chunk_text
            # Reset
            current_chunk = []
            current_length = 0

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue

        # If paragraph fits, add directly
        if len(para) + current_length <= chunk_size:
            current_chunk.append(para)
            current_length += len(para) + 1
        else:
            # Split paragraph into sentences
            sentences = re.split(r'(?<=[.!?])\s+', para)
            for sent in sentences:
                if len(sent) + current_length <= chunk_size:
                    current_chunk.append(sent)
                    current_length += len(sent) + 1
                else:
                    # Yield current chunk
                    yield from flush_chunk()
                    # Add sentence to new chunk
                    current_chunk.append(sent)
                    current_length = len(sent) + 1

    # Flush remaining chunk
    if current_chunk:
        yield " ".join(current_chunk).strip()
