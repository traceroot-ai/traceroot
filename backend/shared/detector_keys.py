"""Redis key formats for detector state, shared by the worker and the REST API.

Both processes address the same records, so the formats live here: importing
across ``worker`` and ``rest`` would drag one's dependencies into the other.
"""


def detection_claim_key(project_id: str, trace_id: str) -> str:
    """Build the Redis key for a trace's detector-enqueue claim.

    The key — not its value — is the exactly-once guard: a single ``SET NX`` on it
    decides which ingest batch may enqueue detection for the trace. The value
    records the outcome (``deciding``, ``pending`` or ``sampled_out``), which the
    REST API reports so clients know whether results are coming.

    Args:
        project_id (str): Project that owns the trace.
        trace_id (str): Trace being claimed for enqueue.

    Returns:
        str: The namespaced Redis key for this ``(project, trace)`` claim.
    """
    return f"detector-enq:{project_id}:{trace_id}"
