from typing import Iterator, Dict, Any
import json

CHUNK_SIZE = 200_000

def semantic_chunk(
    text: str,
    chunk_size: int = CHUNK_SIZE
) -> Iterator[str]:
    """Hierarchical span-aware chunking that preserves structure.
    
    Strategy:
    1. Keep entire tree intact if it fits
    2. If too large, separate child spans while maintaining hierarchy
    3. Include parent context when splitting
    4. Only flatten as last resort for huge individual spans
    
    Args:
        text: JSON string (single span or span tree)
        chunk_size: Target max size per chunk
    
    Yields:
        JSON strings with preserved hierarchical structure
    """
    data = json.loads(text)
    full_size = len(text)
    
    # Case 1: Perfect - everything fits
    if full_size <= chunk_size:
        yield text
        return
    
    # Case 2: Need to split - use hierarchical splitting
    if isinstance(data, dict) and "span_id" in data:
        yield from _hierarchical_split(data, chunk_size)
    elif isinstance(data, list):
        # Array of spans - batch them intelligently
        yield from _batch_spans_list(data, chunk_size)
    else:
        # Unknown structure, yield as-is
        yield text


def _hierarchical_split(
    span: Dict[str, Any], 
    chunk_size: int
) -> Iterator[str]:
    """Split span hierarchically, preserving parent-child relationships.
    
    Args:
        span: The span dict to split
        chunk_size: Maximum chunk size
    """
    # Separate parent data from children
    parent_data = {}
    children = []
    
    for key, value in span.items():
        if isinstance(value, dict) and "span_id" in value:
            children.append((key, value))
        else:
            parent_data[key] = value
    
    parent_size = len(json.dumps(parent_data, indent=2))
    
    # Case A: Parent alone is too big - split its logs
    if parent_size > chunk_size:
        yield from _split_large_span_logs(parent_data, chunk_size)
        
        # Yield children separately with parent context
        for child_key, child_data in children:
            child_with_context = _add_parent_context(child_data, parent_data)
            yield from _hierarchical_split(
                child_with_context, 
                chunk_size
            )
        return
    
    # Case B: Parent fits, try grouping with children (preserving order)
    current_chunk = parent_data.copy()
    
    for child_key, child_data in children:
        # Calculate size if we add this child
        test_chunk = current_chunk.copy()
        test_chunk[child_key] = child_data
        test_size = len(json.dumps(test_chunk, indent=2))
        
        # Check if child fits in current chunk
        if test_size <= chunk_size:
            current_chunk[child_key] = child_data
        else:
            # Child doesn't fit - yield current chunk first to preserve order
            if len(current_chunk) > len(parent_data):
                # We have some children, yield them
                yield json.dumps(current_chunk, indent=2)
                current_chunk = parent_data.copy()
            
            # Now handle the child that didn't fit
            child_size = len(json.dumps(child_data, indent=2))
            
            if child_size > chunk_size:
                # Child is too big - recursively split it
                child_with_context = _add_parent_context(child_data, parent_data)
                yield from _hierarchical_split(
                    child_with_context,
                    chunk_size
                )
            else:
                # Child fits alone, yield it with parent context
                chunk_with_context = {
                    "_parent_context": {
                        "span_id": parent_data.get("span_id"),
                        "func_full_name": parent_data.get("func_full_name")
                    },
                    child_key: child_data
                }
                yield json.dumps(chunk_with_context, indent=2)
    
    # Yield final chunk if it has content
    if len(current_chunk) > len(parent_data) or not children:
        # Has children or parent-only (no children at all)
        yield json.dumps(current_chunk, indent=2)


def _add_parent_context(child: Dict[str, Any], parent: Dict[str, Any]) -> Dict[str, Any]:
    """Add parent context metadata to a child span."""
    context = {
        "_parent_span_id": parent.get("span_id"),
        "_parent_function": parent.get("func_full_name")
    }
    return {**context, **child}


def _split_large_span_logs(span: Dict[str, Any], chunk_size: int) -> Iterator[str]:
    """Split a span with too many logs into multiple chunks.
    
    Keeps metadata in each chunk, splits logs into groups.
    """
    # Separate metadata from logs
    metadata = {}
    logs = {}
    
    for key, value in span.items():
        if key.startswith("log_"):
            logs[key] = value
        else:
            metadata[key] = value
    
    # If no logs, yield metadata as-is
    if not logs:
        yield json.dumps(span, indent=2)
        return
    
    # Split logs into batches
    log_items = sorted(logs.items(), key=lambda x: int(x[0].split('_')[1]))
    
    current_log_batch = {}
    for log_key, log_value in log_items:
        current_log_batch[log_key] = log_value
        
        # Check size with metadata
        chunk_data = {**metadata, **current_log_batch}
        chunk_str = json.dumps(chunk_data, indent=2)
        
        if len(chunk_str) > chunk_size and len(current_log_batch) > 1:
            # Yield without this log
            current_log_batch.pop(log_key)
            yield json.dumps({**metadata, **current_log_batch}, indent=2)
            
            # Start new batch with just this log
            current_log_batch = {log_key: log_value}
    
    # Yield final batch *(incase len(chunk_str) > chunk_size is false for them)
    if current_log_batch:
        yield json.dumps({**metadata, **current_log_batch}, indent=2)


def _batch_spans_list(
    spans: list,
    chunk_size: int
) -> Iterator[str]:
    """Batch a list of spans into chunks."""
    current_batch = []
    current_size = 0
    
    for span in spans:
        span_str = json.dumps(span, indent=2)
        span_size = len(span_str)
        
        # If single span is too big, split it
        if span_size > chunk_size:
            # Yield current batch first
            if current_batch:
                yield json.dumps(current_batch, indent=2)
                current_batch = []
                current_size = 0
            
            # Split the large span
            if isinstance(span, dict) and "span_id" in span:
                yield from _hierarchical_split(span, chunk_size)
            else:
                yield span_str
            continue
        
        # Check if adding this span exceeds limit
        if current_batch and current_size + span_size > chunk_size:
            # Yield current batch
            yield json.dumps(current_batch, indent=2)
            current_batch = []
            current_size = 0
        
        # Add span to current batch
        current_batch.append(span)
        current_size += span_size
    
    # Yield final batch
    if current_batch:
        yield json.dumps(current_batch, indent=2)