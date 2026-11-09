"""Import LangSmith traces into TraceRoot.

Reads LangSmith runs (bulk-export Parquet, saved JSONL, or the LangSmith API),
converts each run to an OpenInference-shaped OTLP span, and sends the spans to
TraceRoot's ingest endpoint. See README.md for usage.
"""
