"""Structural budgets for a staged OTLP batch, checked on the wire before decoding.

The ingest byte caps bound how large a batch is, not how many objects decoding
builds from it. 32 MiB of two-byte empty messages parses into 16 million
protobuf messages, and ``MessageToDict`` then builds as many dicts: gigabytes
for one batch. ``check_batch_budget`` walks the encoded
``ExportTraceServiceRequest`` without building anything, counts the repeated
entries decoding would create, and stops at the first count over its budget.

Every repeated field in the trace schema is counted, read from the generated
descriptors so a field added by a newer ``opentelemetry-proto`` is counted too:
spans, events, links, attributes at every level (resource, scope, span, event,
link, and nested key-value lists), array values, resource and scope groups, and
entity references. Fields the schema doesn't know are skipped, as decoding keeps
them only as raw bytes.
"""

from google.protobuf.descriptor import Descriptor, FieldDescriptor
from google.protobuf.message import DecodeError
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)

# Matches protobuf's own default recursion limit, which rejects deeper messages.
MAX_DEPTH = 100

_KINDS = {
    "opentelemetry.proto.trace.v1.Span": "spans",
    "opentelemetry.proto.trace.v1.Span.Event": "events",
    "opentelemetry.proto.trace.v1.Span.Link": "links",
    "opentelemetry.proto.common.v1.KeyValue": "attributes",
    "opentelemetry.proto.common.v1.AnyValue": "attributes",
}
_COUNTED = ("spans", "events", "links", "attributes", "other")


class BudgetExceededError(ValueError):
    """The batch would decode into more spans or objects than its budget allows."""


def _build_tables(root: Descriptor) -> dict[str, dict[int, tuple[str | None, int | None]]]:
    """Map each message type to ``{field number: (child type, counted kind index)}``.

    Only fields that need an action are listed: message fields, which are walked
    into, and repeated fields, whose every entry is counted.
    """
    tables: dict[str, dict[int, tuple[str | None, int | None]]] = {}
    pending = [root]
    while pending:
        message = pending.pop()
        if message.full_name in tables:
            continue
        fields: dict[int, tuple[str | None, int | None]] = {}
        for field in message.fields:
            child = field.message_type
            repeated = field.is_repeated
            if (
                repeated
                and child is None
                and field.type
                not in (
                    FieldDescriptor.TYPE_STRING,
                    FieldDescriptor.TYPE_BYTES,
                )
            ):
                # A packed numeric field holds many entries in one length-delimited
                # value; nothing in the trace schema has one, so it isn't counted.
                raise TypeError(f"Unexpected repeated numeric field {field.full_name}")
            if child is None and not repeated:
                continue
            kind = _KINDS.get(child.full_name, "other") if child is not None else "other"
            fields[field.number] = (
                child.full_name if child is not None else None,
                _COUNTED.index(kind) if repeated else None,
            )
            if child is not None:
                pending.append(child)
        tables[message.full_name] = fields
    return tables


_TABLES = _build_tables(ExportTraceServiceRequest.DESCRIPTOR)
_ROOT = ExportTraceServiceRequest.DESCRIPTOR.full_name


def _varint(buf: bytes, pos: int, end: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        if pos >= end:
            raise DecodeError("Truncated varint")
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if byte < 0x80:
            return result, pos
        shift += 7
        if shift > 63:
            raise DecodeError("Varint is too long")


def check_batch_budget(body: bytes, max_spans: int, max_objects: int) -> dict[str, int]:
    """Count what decoding ``body`` would build, refusing it past either budget.

    Args:
        body (bytes): An encoded ``ExportTraceServiceRequest``, already unzipped.
        max_spans (int): The most spans the batch may hold.
        max_objects (int): The most repeated entries of any kind it may hold.

    Returns:
        dict[str, int]: Entries counted by kind, and their ``total``.

    Raises:
        BudgetExceededError: At the first span or entry over its budget.
        DecodeError: If the encoding is malformed or nested past ``MAX_DEPTH``.
    """
    counts = [0] * len(_COUNTED)
    total = 0

    def over(kind: str, budget: int, name: str) -> BudgetExceededError:
        tally = ", ".join(f"{n} {k}" for k, n in zip(_COUNTED, counts, strict=True))
        return BudgetExceededError(f"more than {budget} {kind} ({name}); counted so far: {tally}")

    def walk(pos: int, end: int, fields: dict, depth: int) -> None:
        nonlocal total
        if depth > MAX_DEPTH:
            raise DecodeError(f"Message nested deeper than {MAX_DEPTH}")
        while pos < end:
            tag, pos = _varint(body, pos, end)
            wire_type = tag & 7
            if wire_type == 2:
                length, pos = _varint(body, pos, end)
                stop = pos + length
                if stop > end:
                    raise DecodeError("Truncated length-delimited field")
                action = fields.get(tag >> 3)
                if action is not None:
                    child, kind = action
                    if kind is not None:
                        counts[kind] += 1
                        total += 1
                        if total > max_objects:
                            raise over("objects", max_objects, "INGEST_MAX_OBJECTS")
                        if kind == 0 and counts[0] > max_spans:
                            raise over("spans", max_spans, "INGEST_MAX_SPANS")
                    if child is not None:
                        walk(pos, stop, _TABLES[child], depth + 1)
                pos = stop
            elif wire_type == 0:
                _, pos = _varint(body, pos, end)
            elif wire_type == 1:
                pos += 8
            elif wire_type == 5:
                pos += 4
            else:
                raise DecodeError(f"Unsupported wire type {wire_type}")
        if pos != end:
            raise DecodeError("Truncated fixed-width field")

    walk(0, len(body), _TABLES[_ROOT], 1)
    return {**dict(zip(_COUNTED, counts, strict=True)), "total": total}
