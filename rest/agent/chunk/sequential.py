"""
tree_chunker.py
Semantic-aware tree-based chunking for smarter text splitting.
"""

from typing import Any, List, Iterator

CHUNK_SIZE = 2000  # Default chunk size in characters
OVERLAP_SIZE = 200  # Overlap between chunks in characters

def tree_chunker(
    node: Any,
    chunk_size: int = CHUNK_SIZE,
    overlap_size: int = OVERLAP_SIZE
) -> Iterator[str]:
    """
    Chunk a parsed tree (dict/list) into semantic chunks.
    Preserves boundaries between nodes (e.g., functions, classes).

    Args:
        node: The tree to chunk (can be dict, list, or leaf value).
        chunk_size: Max size of each chunk in characters.
        overlap_size: Size of overlapping context between chunks.
    """
    def flatten_tree(n: Any) -> List[str]:
        """Recursively flatten the tree into text blocks."""
        blocks = []
        if isinstance(n, dict):
            for key, value in n.items():
                blocks.append(str(key))  # include key
                blocks.extend(flatten_tree(value))
        elif isinstance(n, list):
            for item in n:
                blocks.extend(flatten_tree(item))
        else:
            blocks.append(str(n))  # leaf node
        return blocks

    flat_blocks = flatten_tree(node)

    current_chunk = []
    current_size = 0

    for block in flat_blocks:
        block_len = len(block)
        if current_size + block_len > chunk_size:
            yield "".join(current_chunk)

            overlap_text = "".join(current_chunk)[-overlap_size:]
            current_chunk = [overlap_text, block]
            current_size = len(overlap_text) + block_len
        else:
            current_chunk.append(block)
            current_size += block_len

    if current_chunk:
        yield "".join(current_chunk)
