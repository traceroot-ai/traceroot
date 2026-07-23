"""Detector-only multi-project wrapper around the shared OTLP transform.

The detector worker serves every project off one queue, so one exported OTLP
batch can carry self-traces for several projects. Following the standard
OpenTelemetry multi-tenancy pattern, the worker stamps each span with a
per-span ``traceroot.project_id`` attribute and this wrapper routes on it:
spans are grouped by project and the shared single-project transform runs
once per group, with ``trust_source=True`` (the only caller is the
secret-gated internal ingest route).

Only the internal route imports this module. The public ingest path cannot
honor a payload project id because this code simply is not in its chain —
the security boundary is structural, not a flag.
"""

from worker.otel_transform import attributes_to_dict, transform_otel_to_clickhouse

_PROJECT_ID_ATTR = "traceroot.project_id"


class UnattributableSpanError(ValueError):
    """A span carries no usable ``traceroot.project_id`` and no fallback was given."""


def transform_detector_traces(
    otel_data: dict,
    fallback_project_id: str | None = None,
) -> tuple[list[dict], list[dict]]:
    """Route each span to its project and transform once per project group.

    Spans are grouped by their per-span ``traceroot.project_id`` attribute
    (spans without it fall to ``fallback_project_id``), each group is run
    through the shared transform exactly as it stands — one project per call,
    ``trust_source=True`` — and the per-group results are concatenated. A
    trace is always one project, so a trace's spans stay whole in one call.
    An unattributable span rejects the whole batch: a project is never
    guessed and a span is never fanned out to more than one project.

    Args:
        otel_data (dict): Parsed OTLP JSON (camelCase ``resourceSpans`` format).
        fallback_project_id (str | None): Project for spans that carry no
            per-span attribute, or None to require the attribute on every span.

    Returns:
        tuple[list[dict], list[dict]]: Concatenated (traces, spans) records
            ready for ClickHouse insertion, each stamped with its own project.

    Raises:
        UnattributableSpanError: A span has no ``traceroot.project_id``
            attribute and no fallback project id was provided, or the
            attribute value is not a non-empty string.
    """
    grouped: dict[str, dict] = {}

    for resource_span in otel_data.get("resourceSpans", []):
        for scope_span in resource_span.get("scopeSpans", []):
            per_project: dict[str, list[dict]] = {}
            for span in scope_span.get("spans", []):
                attrs = attributes_to_dict(span.get("attributes", []))
                project_id = attrs.get(_PROJECT_ID_ATTR)
                if project_id is None:
                    project_id = fallback_project_id
                # A malformed value (array/map/number attr) must reject the
                # batch like an absent one, not crash grouping or fall through
                # to the fallback — a project is never guessed.
                if not isinstance(project_id, str) or not project_id:
                    raise UnattributableSpanError(
                        "span carries no usable traceroot.project_id attribute and "
                        "no fallback project id was provided; refusing to guess"
                    )
                # The attribute is routing input consumed here; strip it so it
                # does not leak into the stored span metadata.
                routed_span = {
                    **span,
                    "attributes": [
                        a for a in span.get("attributes", []) if a.get("key") != _PROJECT_ID_ATTR
                    ],
                }
                per_project.setdefault(project_id, []).append(routed_span)

            for project_id, spans in per_project.items():
                group = grouped.setdefault(project_id, {"resourceSpans": []})
                group["resourceSpans"].append(
                    {
                        **{k: v for k, v in resource_span.items() if k != "scopeSpans"},
                        "scopeSpans": [
                            {
                                **{k: v for k, v in scope_span.items() if k != "spans"},
                                "spans": spans,
                            }
                        ],
                    }
                )

    all_traces: list[dict] = []
    all_spans: list[dict] = []
    for project_id, group in grouped.items():
        traces, spans = transform_otel_to_clickhouse(group, project_id, trust_source=True)
        all_traces.extend(traces)
        all_spans.extend(spans)
    return all_traces, all_spans
