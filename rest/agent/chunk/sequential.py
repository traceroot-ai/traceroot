from typing import Any, Dict, List, Iterator

CHUNK_SIZE = 2000  # maximum chunk length in characters (or tokens if adapted)
OVERLAP_SIZE = 200  # number of characters to overlap between consecutive chunks

def tree_chunker(
    node: Any,
    chunk_size: int = CHUNK_SIZE,
    overlap_size: int = OVERLAP_SIZE
) -> Iterator[str]:
    """
    Chunk a parsed tree (dict/list) into semantic chunks.
    - `node`: A Python dict or list representing a parsed "tree" (e.g., AST, JSON, nested logs).
    - Preserves logical node boundaries (so a function/class won't be split mid-way).
    """

    def flatten_tree(n: Any) -> List[str]:
        """
        Recursively flatten the tree into a list of text blocks.
        - If `n` is a dict: add the keys, then recursively flatten values.
        - If `n` is a list: flatten each element.
        - If `n` is a leaf (string, int, etc.): convert to string and store.
        """
        blocks = []
        if isinstance(n, dict):
            for key, value in n.items():
                blocks.append(str(key))  # keep the key name in output
                blocks.extend(flatten_tree(value))  # flatten its value
        elif isinstance(n, list):
            for item in n:
                blocks.extend(flatten_tree(item))
        else:
            blocks.append(str(n))  # store leaf node
        return blocks

    # Step 1: Flatten the entire tree into a sequence of text blocks
    flat_blocks = flatten_tree(node)

    # Step 2: Sequentially group blocks into chunks with overlap
    current_chunk = []
    current_size = 0

    for block in flat_blocks:
        block_len = len(block)  # how many characters in this block

        # If adding this block would exceed chunk size:
        if current_size + block_len > chunk_size:
            yield "".join(current_chunk)  # output current chunk

            # Step 3: Create overlap for context
            overlap_text = "".join(current_chunk)[-overlap_size:]  
            current_chunk = [overlap_text, block]  # start new chunk with overlap + new block
            current_size = len(overlap_text) + block_len
        else:
            # Add block to current chunk
            current_chunk.append(block)
            current_size += block_len

    # Step 4: Yield the last chunk if not empty
    if current_chunk:
        yield "".join(current_chunk)
