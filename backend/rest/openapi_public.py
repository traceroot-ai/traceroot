"""Build a deterministic, public-only OpenAPI schema for the CLI to codegen from.

The public API surface is defined by a single path prefix (`/api/v1/public/*`) —
everything the project-API-key contract exposes, including SDK ingestion. Internal
(`/api/v1/internal/*`), user-session, and project-scoped (`/api/v1/projects/*`)
routes plus `/health` are excluded. Output is rendered with sorted keys so the
committed artifact diffs cleanly and a drift check is meaningful.
"""

import copy
import json
from typing import Any

from rest.services.filters.columns import FILTER_COLUMNS, FilterType
from rest.services.filters.translate import (
    MAX_FILTERS,
    MAX_KEY_LENGTH,
    MAX_VALUE_LENGTH,
    NUMERIC_TYPE_MAX,
)
from rest.services.widget_registry import registry_schema

PUBLIC_PREFIX = "/api/v1/public/"
TITLE = "TraceRoot Public API"

_HTTP_METHODS = {"get", "post", "put", "patch", "delete"}
_BEARER_SCHEME = {"type": "http", "scheme": "bearer"}
#: The canonical envelope, by reference. Inline, these responses generated an
#: anonymous type per operation, so a client branching on an error saw one shape
#: for the statuses a route declares itself and another for the two added here.
#: ErrorResponse is the same object and also marks ``detail`` required.
_ERROR_SCHEMA = {"$ref": "#/components/schemas/ErrorResponse"}


def _error_response(description: str) -> dict[str, Any]:
    return {"description": description, "content": {"application/json": {"schema": _ERROR_SCHEMA}}}


def _apply_public_contract(schema: dict[str, Any]) -> None:
    """Document contract details FastAPI can't infer from the raw-Request /
    manual-HTTPException public routes: bearer auth (required), the protobuf
    ingestion body, and the real 401/404/500 error responses.
    """
    schema.setdefault("components", {}).setdefault("securitySchemes", {})["BearerAuth"] = (
        _BEARER_SCHEME
    )

    for item in schema["paths"].values():
        for method, op in item.items():
            if method not in _HTTP_METHODS:
                continue
            # Auth is required on every public endpoint: represent it once as a
            # bearer requirement and drop the misleading optional header param.
            op["security"] = [{"BearerAuth": []}]
            params = [
                p
                for p in op.get("parameters", [])
                if not (
                    p.get("in") == "header" and (p.get("name") or "").lower() == "authorization"
                )
            ]
            if params:
                op["parameters"] = params
            else:
                op.pop("parameters", None)
            # Every public op depends on the shared API-key auth dependency, which
            # raises 401 (bad/invalid key) and 503 (auth service unavailable).
            responses = op.setdefault("responses", {})
            responses.setdefault("401", _error_response("Authentication failed"))
            responses.setdefault("503", _error_response("Authentication service unavailable"))

    # Public ingestion accepts an OTLP protobuf body (read from the raw request)
    # and documents its runtime error contract: 400 (bad/empty/undecodable body),
    # 402 (plan limit), 415 (wrong Content-Type), 500 (S3 storage failure).
    ingest = schema["paths"].get("/api/v1/public/traces", {}).get("post")
    if ingest is not None:
        ingest["requestBody"] = {
            "required": True,
            "content": {
                "application/x-protobuf": {"schema": {"type": "string", "format": "binary"}}
            },
        }
        ingest_responses = ingest["responses"]
        ingest_responses.setdefault("400", _error_response("Invalid request body"))
        ingest_responses.setdefault("402", _error_response("Free plan limit exceeded"))
        ingest_responses.setdefault("415", _error_response("Unsupported media type"))
        ingest_responses.setdefault("500", _error_response("Storage error"))

    # Trace read/export error contract (matches the route code).
    list_op = schema["paths"].get("/api/v1/public/traces", {}).get("get")
    if list_op is not None:
        list_op["responses"].setdefault("400", _error_response("Invalid filters parameter"))
        list_op["responses"].setdefault("500", _error_response("Failed to list traces"))
    for path in ("/api/v1/public/traces/{trace_id}", "/api/v1/public/traces/{trace_id}/export"):
        op = schema["paths"].get(path, {}).get("get")
        if op is not None:
            op["responses"].setdefault("400", _error_response("Invalid fields parameter"))
            op["responses"].setdefault("404", _error_response("Trace not found"))
            op["responses"].setdefault("500", _error_response("Failed to get trace"))

    # Filter-values discovery error contract (matches the route code).
    filter_values_op = (
        schema["paths"].get("/api/v1/public/traces/filter-values/{field}", {}).get("get")
    )
    if filter_values_op is not None:
        filter_values_op["responses"].setdefault(
            "400", _error_response("Field is not filterable by distinct values")
        )
        filter_values_op["responses"].setdefault(
            "500", _error_response("Failed to list filter values")
        )

    # Detector catalog list error contract (matches the route code).
    detectors_list_op = schema["paths"].get("/api/v1/public/detectors", {}).get("get")
    if detectors_list_op is not None:
        detectors_list_op["responses"].setdefault(
            "500", _error_response("Failed to list detectors")
        )

    # Detector detail read error contract (matches the route code).
    detector_get_op = schema["paths"].get("/api/v1/public/detectors/{detector_id}", {}).get("get")
    if detector_get_op is not None:
        detector_get_op["responses"].setdefault("404", _error_response("Detector not found"))
        detector_get_op["responses"].setdefault("500", _error_response("Failed to read detector"))

    # Detector findings read error contract (matches the route code).
    findings_list_op = schema["paths"].get("/api/v1/public/detectors/findings", {}).get("get")
    if findings_list_op is not None:
        findings_list_op["responses"].setdefault("500", _error_response("Failed to list findings"))
    for path in (
        "/api/v1/public/detectors/findings/{finding_id}",
        "/api/v1/public/detectors/traces/{trace_id}/finding",
    ):
        op = schema["paths"].get(path, {}).get("get")
        if op is not None:
            op["responses"].setdefault("404", _error_response("Finding not found"))
            op["responses"].setdefault("500", _error_response("Failed to read finding"))

    # Dashboard read error contract (matches the route code): the proxy passes
    # the internal route's 404 through; ambiguity fails closed as the shared 503.
    dashboard_get_op = (
        schema["paths"].get("/api/v1/public/dashboards/{dashboard_id}", {}).get("get")
    )
    if dashboard_get_op is not None:
        dashboard_get_op["responses"].setdefault("404", _error_response("Dashboard not found"))
    dashboard_data_op = (
        schema["paths"].get("/api/v1/public/dashboards/{dashboard_id}/data", {}).get("get")
    )
    if dashboard_data_op is not None:
        dashboard_data_op["responses"].setdefault("404", _error_response("Dashboard not found"))

    # Widget read error contract (matches the route code): the widget is
    # resolved through the caller's project, so a foreign id is the same 404
    # as an unknown one; ambiguity fails closed as the shared 503.
    for path in (
        "/api/v1/public/widgets/{widget_id}",
        "/api/v1/public/widgets/{widget_id}/data",
    ):
        op = schema["paths"].get(path, {}).get("get")
        if op is not None:
            op["responses"].setdefault("404", _error_response("Widget not found"))

    # Alert read error contract (matches the route code): the proxy passes the
    # internal route's 404 through; ambiguity fails closed as the shared 503.
    alert_get_op = schema["paths"].get("/api/v1/public/alerts/{alert_id}", {}).get("get")
    if alert_get_op is not None:
        alert_get_op["responses"].setdefault("404", _error_response("Alert not found"))

    # Session read error contract (matches the route code).
    sessions_list_op = schema["paths"].get("/api/v1/public/sessions", {}).get("get")
    if sessions_list_op is not None:
        sessions_list_op["responses"].setdefault("500", _error_response("Failed to list sessions"))
    session_get_op = schema["paths"].get("/api/v1/public/sessions/{session_id}", {}).get("get")
    if session_get_op is not None:
        session_get_op["responses"].setdefault("404", _error_response("Session not found"))
        session_get_op["responses"].setdefault("500", _error_response("Failed to get session"))


def _filter_predicate_variants() -> list[dict[str, Any]]:
    """One JSON-Schema variant per filterable field, generated from the registry.

    The field registry (``rest.services.filters.columns``) is the single source
    of truth; this builder mirrors each column's operator whitelist and value
    shape into the public contract, so adding a filter field remains one
    registry entry and a schema regeneration.

    Returns:
        list[dict[str, Any]]: ``anyOf`` variants for the ``filters`` parameter.
    """
    variants: list[dict[str, Any]] = []
    for col in FILTER_COLUMNS:
        if col.type == FilterType.CATEGORICAL:
            # Per-element length cap, mirroring the runtime validator; the list
            # itself is unbounded (each element binds into one Array parameter).
            value_schema: dict[str, Any] = {
                "type": "array",
                "items": {"type": "string", "maxLength": MAX_VALUE_LENGTH},
                "minItems": 1,
            }
        elif col.type == FilterType.NUMERIC:
            # Mirror the runtime validator: metrics are non-negative, integer
            # columns reject fractional values, and each column type has an
            # inclusive maximum (shared map with the validator).
            if col.is_integer:
                value_schema = {"type": "integer", "minimum": 0}
            else:
                value_schema = {"type": "number", "minimum": 0}
            max_val = NUMERIC_TYPE_MAX.get(col.ch_type)
            if max_val is not None:
                value_schema["maximum"] = max_val
        elif col.type == FilterType.TEXT:
            # The validator rejects empty strings and caps the length.
            value_schema = {"type": "string", "minLength": 1, "maxLength": MAX_VALUE_LENGTH}
        else:
            # A new FilterType member must get an explicit value schema here;
            # failing the build beats silently typing it as free text.
            raise ValueError(f"unhandled filter type for schema generation: {col.type!r}")
        # Explicit `type` alongside const/enum: the schema also feeds model tool
        # definitions, and some providers reject properties without one.
        properties: dict[str, Any] = {
            "field": {"type": "string", "const": col.name, "title": col.label},
            "op": {"type": "string", "enum": [str(o) for o in col.operators]},
            "value": value_schema,
        }
        required = ["field", "op", "value"]
        if col.requires_key:
            # Mirror the runtime validator: a keyed field (e.g. metadata) carries
            # which map key the value is compared against, as a bounded string.
            properties["key"] = {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_KEY_LENGTH,
                "description": f"Which {col.name} key the value is compared against",
            }
            required = ["field", "key", "op", "value"]
        variants.append(
            {
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": False,
            }
        )
    return variants


def _apply_filters_param_schema(schema: dict[str, Any]) -> None:
    """Replace the string-typed ``filters`` query param with its JSON-content form.

    FastAPI declares the route param as a plain string; the real contract is a
    JSON array of typed predicates. OpenAPI models JSON-in-query as a parameter
    with ``content`` instead of ``schema`` — downstream generators read
    ``content["application/json"].schema``.

    Args:
        schema (dict[str, Any]): The public-only OpenAPI document; mutated in
            place. No-op if the operation or parameter is absent.
    """
    op = schema["paths"].get("/api/v1/public/traces", {}).get("get")
    if op is None:
        return
    for param in op.get("parameters", []):
        if param.get("name") == "filters" and param.get("in") == "query":
            param.pop("schema", None)
            param["content"] = {
                "application/json": {
                    "schema": {
                        "type": "array",
                        "items": {"anyOf": _filter_predicate_variants()},
                        # Mirror the runtime cap: each span-level predicate costs
                        # its own scan in the page AND count queries.
                        "maxItems": MAX_FILTERS,
                    }
                }
            }


def _inline_component_refs(node: Any, schemas: dict[str, Any]) -> Any:
    """Deep-copy ``node`` with every ``#/components/schemas/`` ``$ref`` replaced
    by its (recursively inlined) target, so a copy can be specialized without
    mutating the shared component. Sibling keys beside a ``$ref`` override the
    target's, matching the tools generator's resolution rule.

    Args:
        node (Any): Schema fragment to copy; dicts/lists are walked, scalars
            returned as-is.
        schemas (dict[str, Any]): ``components.schemas`` to resolve refs against.

    Returns:
        Any: A fully inlined deep copy of ``node``.
    """
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
            target = schemas[ref.rsplit("/", 1)[1]]
            merged = {**target, **{k: v for k, v in node.items() if k != "$ref"}}
            return _inline_component_refs(merged, schemas)
        return {key: _inline_component_refs(value, schemas) for key, value in node.items()}
    if isinstance(node, list):
        return [_inline_component_refs(value, schemas) for value in node]
    return node


def _widget_query_spec_variants(schemas: dict[str, Any]) -> list[dict[str, Any]]:
    """One inline query-spec variant per widget registry view.

    Each variant is the ``WidgetSpec`` component (refs inlined) specialized to
    one view: ``view`` pinned to a const, and the measure, breakdown, and
    filter-field vocabularies enumerated from the widget field registry — the
    same source the write service validates against — so generated tool schemas
    and API docs show exactly the fields create accepts, never hand-listed.

    Args:
        schemas (dict[str, Any]): ``components.schemas`` of the public document.

    Returns:
        list[dict[str, Any]]: The per-view ``anyOf`` variants, in registry order.
    """
    variants: list[dict[str, Any]] = []
    for view_name, view in registry_schema().items():
        fields = view["fields"]
        measures = [name for name, f in fields.items() if f["aggs"]]
        groupables = [name for name, f in fields.items() if f["groupable"]]
        filterables = [name for name, f in fields.items() if f["filterOps"]]
        variant = _inline_component_refs(schemas["WidgetSpec"], schemas)
        variant["title"] = f"WidgetSpec ({view_name})"
        variant["description"] = (
            f'Chart spec over the "{view_name}" view; the enums below are the '
            "complete field vocabulary for this view."
        )
        properties = variant["properties"]
        # Explicit `type` alongside const/enum throughout: these variants feed
        # model tool definitions, and some providers reject untyped properties.
        properties["view"] = {"const": view_name, "title": "View", "type": "string"}
        properties["metric"]["properties"]["measure"] = {
            "enum": measures,
            "title": "Measure",
            "type": "string",
        }
        properties["breakdown"] = {
            "enum": [*groupables, None],
            "title": "Breakdown",
            "type": ["string", "null"],
        }
        properties["filters"]["items"]["properties"]["field"] = {
            "enum": filterables,
            "title": "Field",
            "type": "string",
        }
        variants.append(variant)
    return variants


def _apply_widget_spec_vocabulary(schema: dict[str, Any]) -> None:
    """Replace the widget create and update bodies' ``spec`` ``WidgetSpec``
    branch with the per-view variants from :func:`_widget_query_spec_variants`;
    the trace_feed branch keeps its ``$ref``. The ``WidgetSpec`` component
    itself stays in the document even though the unions no longer reference
    it: the frontend widget-spec-parity test anchors on it to guard the
    pydantic/zod mirror.

    Args:
        schema (dict[str, Any]): The public-only OpenAPI document; mutated in
            place. A request schema that is absent is skipped.
    """
    schemas = (schema.get("components") or {}).get("schemas", {})
    for name in ("CreateWidgetRequest", "UpdateWidgetRequest"):
        request = schemas.get(name)
        if request is None:
            continue
        request["properties"]["spec"]["anyOf"] = [
            *_widget_query_spec_variants(schemas),
            {"$ref": "#/components/schemas/TraceFeedSpec"},
        ]


# Agent/CLI-facing tool curation, keyed by operationId. Reviewed in the same PR
# as any endpoint change so tool naming can't drift from the API. Every public
# operation MUST have an entry: enabled tools carry the agent-facing
# description; disabled ones are excluded from generated tool registries.
# `name` equals the operationId today but stays an explicit field so a tool
# could be renamed without an API change.
_TOOL_CURATION: dict[str, dict[str, Any]] = {
    "whoami": {
        "name": "whoami",
        "description": "Identify the project and workspace the current credential belongs to.",
        "enabled": True,
    },
    "ingest_traces": {"enabled": False},
    "run_sql": {
        "name": "run_sql",
        "description": (
            "Run one read-only SQL query over the project's own spans and traces "
            "and return the rows. Use get_sql_schema first to see the columns "
            "available; the query may only read the curated spans and traces "
            "tables, and results are capped and may be truncated."
        ),
        "enabled": True,
        # A read that happens to arrive by POST, because the query travels in the
        # body. VIEWER and no approval match the other read operations; the
        # method is what forces a policy entry here at all.
        "policy": {"approvalClass": "none", "minRole": "VIEWER", "tenancy": "project"},
    },
    "get_sql_schema": {
        "name": "get_sql_schema",
        "description": (
            "List the tables and columns available to run_sql, with their types. "
            "Read this before writing a query: it is the whole surface a query "
            "may reference."
        ),
        "enabled": True,
    },
    "list_traces": {
        "name": "list_traces",
        "description": (
            "List recent traces for the project (newest first). Filter by time range, "
            "trace name, user id, or a free-text search across trace/session/user ids "
            "and names. Use this for discovery before fetching a specific trace. "
            "Structured filters (model, environment, cost, tokens, latency, error "
            "count, keyed metadata) are available via the typed filters parameter."
        ),
        "enabled": True,
    },
    "list_trace_filter_values": {
        "name": "list_trace_filter_values",
        "description": (
            "Discover the current values of a categorical trace filter field "
            "(e.g. model_name, environment) for the project — use before "
            "filtering the trace list by that field."
        ),
        "enabled": True,
    },
    "get_trace": {
        "name": "get_trace",
        "description": (
            "Fetch one trace with its span tree. Defaults to the lightweight skeleton "
            "projection; pass fields=full for per-span input/output/metadata."
        ),
        "enabled": True,
    },
    "export_trace": {
        "name": "export_trace",
        "description": (
            "Export the complete bundle (trace, spans, git context, manifest) for one trace."
        ),
        "enabled": True,
    },
    "list_sessions": {
        "name": "list_sessions",
        "description": (
            "List recent sessions (groups of traces sharing a session id) for the "
            "project, with trace counts and durations. Search by session id substring."
        ),
        "enabled": True,
    },
    "get_session": {
        "name": "get_session",
        "description": (
            "Fetch one session with all its traces (ids, names, status, I/O summaries). "
            "Use before deep-diving individual traces of a conversation."
        ),
        "enabled": True,
    },
    "list_detectors": {
        "name": "list_detectors",
        "description": (
            "List the project's detectors (id, name, template, enabled flag, creation time)."
        ),
        "enabled": True,
    },
    "list_findings": {
        "name": "list_findings",
        "description": (
            "List detector findings for the project, optionally filtered by detector "
            "(id, name, or template), trace id, or time range."
        ),
        "enabled": True,
    },
    "get_finding": {
        "name": "get_finding",
        "description": "Fetch one detector finding by id, with its full analysis detail.",
        "enabled": True,
    },
    "get_finding_by_trace": {
        "name": "get_finding_by_trace",
        "description": "Fetch the detector finding attached to a specific trace, if any.",
        "enabled": True,
    },
    "get_detector": {
        "name": "get_detector",
        "description": (
            "Fetch one detector's full configuration by id: prompt, output schema, "
            "sample rate, RCA and detection settings, and trigger conditions."
        ),
        "enabled": True,
    },
    "list_dashboards": {
        "name": "list_dashboards",
        "description": (
            "List the project's dashboards (id, name, description, default "
            "flag, creator, widget count, timestamps). To resolve a dashboard "
            "by name, list here and match its name — never guess a dashboard id."
        ),
        "enabled": True,
    },
    "get_dashboard": {
        "name": "get_dashboard",
        "description": (
            "Fetch one dashboard with its widgets (id, title, type, query "
            "spec, creation time). Resolve the dashboard id by listing the "
            "project's dashboards and matching the name — never guess an id."
        ),
        "enabled": True,
    },
    "run_widget_query": {
        "name": "run_widget_query",
        "description": (
            "Run a widget query and return its rows — the way to answer a "
            "metric question (error counts, p95 latency, cost by model) without "
            "a dashboard existing. Takes the same spec shape as create_widget "
            "(view, metric, breakdown, display, filters) plus a window: a "
            "range preset by the site picker's id (1h, 1d, 7d, 30d, …) or "
            "explicit start_time/end_time; neither means the site's default "
            "24-hour window. The response echoes the window it was answered "
            "for and says when retention clamped it. A read that happens to "
            "be a POST: nothing is written."
        ),
        "enabled": True,
        "policy": {"approvalClass": "none", "minRole": "VIEWER", "tenancy": "project"},
    },
    "get_dashboard_data": {
        "name": "get_dashboard_data",
        "description": (
            "Answer a dashboard's query widgets (up to 24) for one window — the way "
            "to say what a dashboard shows, not just what it contains. Resolve "
            "the dashboard id with list_dashboards and match its name; never "
            "guess an id. Takes a window like run_widget_query (range preset "
            "or explicit bounds; neither means the site's default). Widgets come "
            "back in the dashboard's order with a status each: ok with rows "
            "(a series carries every bucket; any other display is capped at 25 "
            "rows, with truncated set), "
            "skipped for a trace feed (read those with list_traces and the "
            "feed's filters), or error with a reason. Every figure you report "
            "must come from these rows, and name the window it was answered for."
        ),
        "enabled": True,
    },
    "get_widget": {
        "name": "get_widget",
        "description": (
            "Fetch one saved widget's definition by id: its title, type, the "
            "query spec exactly as stored (what get_widget_data runs), display "
            "config, timestamps, and the id and name of the dashboard it sits "
            "on. Resolve a widget id from get_dashboard (which lists a "
            "dashboard's widgets) — never guess an id. For what the widget "
            "shows, use get_widget_data."
        ),
        "enabled": True,
    },
    "get_widget_data": {
        "name": "get_widget_data",
        "description": (
            "Answer one saved widget for a window — the way to say what a "
            "widget shows without re-sending its spec. Prefer this over "
            "run_widget_query whenever the widget already exists on a "
            "dashboard; run_widget_query is for a spec that is saved nowhere. "
            "Takes a widget id plus a window like run_widget_query (range "
            "preset or explicit start_time/end_time; neither means the site's "
            "default). The answer carries a status: ok with every row the "
            "engine returns (a series comes back whole; no row cap), skipped "
            "for a trace feed or legacy detector widget (read those with "
            "list_traces and the feed's filters), or error with a reason when "
            "the stored spec no longer runs. Every figure you report must come "
            "from these rows, and name the window it was answered for — the "
            "response echoes it and says when retention clamped it."
        ),
        "enabled": True,
    },
    "list_alerts": {
        "name": "list_alerts",
        "description": (
            "List the project's threshold alerts (id, name, rule summary, status, "
            "current severity, last evaluation and notification state, creator) "
            "with the project's alert capacity. Paginated; search_query matches "
            "the alert name. To resolve an alert by name, list here and match "
            "its name — never guess an alert id."
        ),
        "enabled": True,
    },
    "get_alert": {
        "name": "get_alert",
        "description": (
            "Fetch one alert's full rule by id: view, measure, aggregation, "
            "filters, window, threshold, renotify and no-data handling, plus its "
            "evaluation state. Resolve the alert id by listing the project's "
            "alerts and matching the name — never guess an id."
        ),
        "enabled": True,
    },
    # Evaluation reporting endpoints are SDK-facing writes, not agent tools (like ingest_traces).
    # Dataset reads are published so a generated client can bind them. Exposing them as
    # registry tools is a separate step; the dataset writes stay off the registry entirely.
    "list_datasets": {"enabled": False},
    "get_dataset": {"enabled": False},
    "list_dataset_versions": {"enabled": False},
    "get_dataset_version": {"enabled": False},
    "register_run": {"enabled": False},
    "upsert_result": {"enabled": False},
    "complete_run": {"enabled": False},
    # Account-tenancy ops have no membership to gate; minRole VIEWER is the no-role-floor convention.
    "create_workspace": {
        "name": "create_workspace",
        "description": (
            "Create a workspace administered by the logged-in user. Idempotent: "
            "re-creating a same-named workspace the caller already administers "
            "returns it instead of duplicating."
        ),
        "enabled": True,
        "policy": {"approvalClass": "confirm", "minRole": "VIEWER", "tenancy": "account"},
    },
    "create_project": {
        "name": "create_project",
        "description": (
            "Create a project in a workspace the logged-in user can write to "
            "(idempotent on the project name within the workspace)."
        ),
        "enabled": True,
        "policy": {"approvalClass": "confirm", "minRole": "MEMBER", "tenancy": "workspace"},
        # API/CLI-visible but hidden from the agent: no UI form exposes the
        # field, so the model shouldn't interrogate users about it.
        "agentHiddenParams": ["trace_ttl_days"],
    },
    "create_detector": {
        "name": "create_detector",
        "description": (
            "Create a detector (name, template, prompt, optional sampling/RCA "
            "settings) in a project — idempotent on the detector name within "
            "the project. The standard detector types (failure, hallucination, "
            "logic, task, safety) have canonical default instructions: pass "
            "the matching template id and OMIT prompt to use them. Only supply "
            "prompt when the user provides genuinely custom instructions — a "
            "supplied prompt is stored verbatim and overrides the template "
            "default."
        ),
        "enabled": True,
        "policy": {"approvalClass": "confirm", "minRole": "MEMBER", "tenancy": "project"},
    },
    "create_dashboard": {
        "name": "create_dashboard",
        "description": (
            "Create a dashboard in a project (idempotent on the dashboard name "
            "within the project); add charts to it with create_widget."
        ),
        "enabled": True,
        "policy": {"approvalClass": "confirm", "minRole": "MEMBER", "tenancy": "project"},
    },
    "create_widget": {
        "name": "create_widget",
        "description": (
            "Add a widget (title, type, spec) to an existing dashboard. Type "
            '"query" charts a metric (spec: view/filters/metric/breakdown/'
            'display); type "trace_feed" lists recent traces (spec: predicate '
            "filters + limit). Strict create: every call adds a new widget. "
            "The spec schema enumerates the only available views, metrics, "
            "filter operators, and display types — nothing outside it exists. "
            "If the user asks for a visualization or option that is not in "
            "the schema (for example a display type the enum lacks), say so "
            "explicitly and propose the closest available match instead of "
            "silently substituting. Pick the view first — spans and traces "
            "expose different fields, and the enums in this schema are the "
            "complete field vocabulary for each view. If the user asks for a "
            "dimension or metric that exists on neither view, say so and "
            'propose the closest available one (for example "traces by model" '
            "is built on the spans view via model_name)."
        ),
        "enabled": True,
        "policy": {"approvalClass": "confirm", "minRole": "MEMBER", "tenancy": "project"},
    },
    "create_alert": {
        "name": "create_alert",
        "description": (
            "Create a threshold alert in a project: a measure of the spans view, "
            "aggregated over a window and compared to a threshold, with optional "
            "row filters and renotify/no-data settings. Strict create, never "
            "idempotent: alerts share names freely, so to avoid a duplicate list "
            "the project's alerts first and match the name."
        ),
        "enabled": True,
        "policy": {"approvalClass": "confirm", "minRole": "MEMBER", "tenancy": "project"},
    },
    # Edits are PATCH: a field left out is untouched, an explicit null clears a
    # nullable field. Updates take the creates' confirm class; deletes take
    # approval, which parks on a destructive card attended and is blocked
    # unattended. Role floors follow the cookie routes: renaming a workspace
    # or changing a project's retention is administrative (ADMIN), the four
    # project resources take MEMBER.
    "update_workspace": {
        "name": "update_workspace",
        "description": (
            "Rename a workspace the logged-in user administers. Fields left out "
            "are untouched. The response lists the fields that actually changed; "
            "a name the caller already uses for another workspace is a conflict."
        ),
        "enabled": True,
        "policy": {"approvalClass": "confirm", "minRole": "ADMIN", "tenancy": "account"},
    },
    "update_project": {
        "name": "update_project",
        "description": (
            "Edit a project's name (or, via the API, its trace retention). "
            "Fields left out are untouched; a null trace_ttl_days returns "
            "retention to the plan default. Requires ADMIN in the workspace. "
            "The response lists the fields that actually changed."
        ),
        "enabled": True,
        "policy": {"approvalClass": "confirm", "minRole": "ADMIN", "tenancy": "workspace"},
        # API/CLI-visible but hidden from the agent, as on create: no UI form
        # exposes the field, so the model shouldn't interrogate users about it.
        "agentHiddenParams": ["trace_ttl_days"],
    },
    "update_detector": {
        "name": "update_detector",
        "description": (
            "Edit a detector: name, prompt, enabled (the pause switch), "
            "sample_rate, enable_rca, output_schema, trigger_conditions, or the "
            "detection model settings. Send only the fields the user asked to "
            "change — fields left out are untouched, and a null detection_model/"
            "detection_provider/detection_source clears it. output_schema and "
            "trigger_conditions replace the whole array; [] removes the trigger. "
            "The template cannot change. Read the detector first so the "
            "proposal names its current values; the response lists the fields "
            "that actually changed."
        ),
        "enabled": True,
        "policy": {"approvalClass": "confirm", "minRole": "MEMBER", "tenancy": "project"},
    },
    "update_dashboard": {
        "name": "update_dashboard",
        "description": (
            "Rename a dashboard or change its description. Fields left out are "
            "untouched; a null description clears it. Tile layout is not "
            "editable here. The response lists the fields that actually changed."
        ),
        "enabled": True,
        "policy": {"approvalClass": "confirm", "minRole": "MEMBER", "tenancy": "project"},
    },
    "update_widget": {
        "name": "update_widget",
        "description": (
            "Edit a widget's title, spec, or display_config. Fields left out are "
            "untouched; a sent spec replaces the whole spec and must be in the "
            "dialect of the widget's existing type (query: view/filters/metric/"
            "breakdown/display; trace_feed: predicate filters + limit) — the "
            "type itself cannot change. A null display_config resets it. Read "
            "the widget's dashboard first so the new spec starts from the "
            "current one; the spec schema enumerates the only available views, "
            "metrics, filter operators, and display types. The response lists "
            "the fields that actually changed."
        ),
        "enabled": True,
        "policy": {"approvalClass": "confirm", "minRole": "MEMBER", "tenancy": "project"},
    },
    "update_alert": {
        "name": "update_alert",
        "description": (
            "Edit an alert's rule: name, view, measure, aggregation, filters, "
            "window, threshold_operator, threshold, renotify, no_data_mode. "
            "Fields left out are untouched; the patch is validated against the "
            "stored rule, so an aggregation edit must fit the stored measure. "
            "Any edit to an evaluated field (everything but name) resets the "
            "alert's evaluation state and clears any open page — the response "
            "reports state_reset and page_cleared, and lists the fields that "
            "actually changed. To pause or resume, use set_alert_status instead."
        ),
        "enabled": True,
        "policy": {"approvalClass": "confirm", "minRole": "MEMBER", "tenancy": "project"},
    },
    "set_alert_status": {
        "name": "set_alert_status",
        "description": (
            "Pause (PAUSED) or resume (ACTIVE) an alert without touching its "
            "rule — prefer this over update_alert for pause and resume. Pausing "
            "keeps the severity the alert stopped at; resuming is a cold start "
            "(evaluation state reset, due now). PARKED is the evaluator's "
            "verdict and cannot be requested; pausing a parked alert is a "
            "conflict, resume it to run it again. Setting the status the alert "
            "already has changes nothing."
        ),
        "enabled": True,
        "policy": {"approvalClass": "confirm", "minRole": "MEMBER", "tenancy": "project"},
    },
    "delete_workspace": {
        "name": "delete_workspace",
        "description": (
            "Permanently delete a workspace and everything in it: every "
            "project, its access keys, memberships and invites. Requires ADMIN, "
            "the workspace's current name typed as confirmation, and a reason "
            "(3-500 characters) that is recorded on the audit row. The caller's "
            "only workspace cannot be deleted. Not reversible."
        ),
        "enabled": True,
        "policy": {"approvalClass": "approval", "minRole": "ADMIN", "tenancy": "account"},
    },
    "delete_project": {
        "name": "delete_project",
        "description": (
            "Delete a project: it drops out of every list and read and its API "
            "keys stop authenticating (its data stays for the retention window). "
            "Requires ADMIN in the workspace and a reason (3-500 characters) "
            "that is recorded on the audit row."
        ),
        "enabled": True,
        "policy": {"approvalClass": "approval", "minRole": "ADMIN", "tenancy": "workspace"},
    },
    "delete_detector": {
        "name": "delete_detector",
        "description": (
            "Permanently delete a detector; its existing findings stay readable. "
            "Requires a reason (3-500 characters) stating why — the user's "
            "actual instruction, recorded on the audit row. Resolve the id by "
            "listing the project's detectors and matching the name; never delete "
            "more than the user named."
        ),
        "enabled": True,
        "policy": {"approvalClass": "approval", "minRole": "MEMBER", "tenancy": "project"},
    },
    "delete_dashboard": {
        "name": "delete_dashboard",
        "description": (
            "Permanently delete a dashboard together with its widgets. A "
            "project's last dashboard cannot be deleted. Requires a reason "
            "(3-500 characters) stating why — the user's actual instruction, "
            "recorded on the audit row. Resolve the id by listing the project's "
            "dashboards and matching the name; never delete more than the user "
            "named."
        ),
        "enabled": True,
        "policy": {"approvalClass": "approval", "minRole": "MEMBER", "tenancy": "project"},
    },
    "delete_widget": {
        "name": "delete_widget",
        "description": (
            "Permanently delete one widget from its dashboard (its layout slot "
            "is removed with it). Requires a reason (3-500 characters) stating "
            "why — the user's actual instruction, recorded on the audit row. "
            "Resolve the id from the dashboard's detail; never delete more than "
            "the user named."
        ),
        "enabled": True,
        "policy": {"approvalClass": "approval", "minRole": "MEMBER", "tenancy": "project"},
    },
    "delete_alert": {
        "name": "delete_alert",
        "description": (
            "Permanently delete an alert. An open page is discarded, not "
            "resolved (the response says when one was). Requires a reason "
            "(3-500 characters) stating why — the user's actual instruction, "
            "recorded on the audit row. Resolve the id by listing the project's "
            "alerts and matching the name; never delete more than the user named."
        ),
        "enabled": True,
        "policy": {"approvalClass": "approval", "minRole": "MEMBER", "tenancy": "project"},
    },
    "list_workspaces": {
        "name": "list_workspaces",
        "description": (
            "List the workspaces the logged-in user belongs to (id, name, role). "
            "User-credential-only account discovery: it needs no project_id and "
            "is not available to project-scoped API keys."
        ),
        "enabled": True,
    },
    "list_projects": {
        "name": "list_projects",
        "description": (
            "List the projects the logged-in user can access, across workspaces "
            "(id, name, workspace). User-credential-only account discovery: use it "
            "to resolve the project_id a project-scoped request needs. Optionally "
            "filter by workspace_id."
        ),
        "enabled": True,
    },
}


# Legal values for each required write-tool policy key. Mirrors the registry
# generator's validation exactly, so a policy mistake fails the schema build
# here before the generated artifact can even drift.
#
# approvalClass semantics:
#   "none"     — execute immediately.
#   "confirm"  — an attended surface shows the proposal and waits for the
#                user's yes; an unattended surface executes as if "none".
#                A taste gate, not a security control.
#   "approval" — destructive ops (deletes). Each surface decides how to
#                honor it; a surface that has not implemented it fails closed.
_POLICY_VALUES: dict[str, tuple[str, ...]] = {
    "approvalClass": ("none", "confirm", "approval"),
    "minRole": ("VIEWER", "MEMBER", "ADMIN"),
    "tenancy": ("account", "workspace", "project"),
}


def _validate_curation_policy(
    entry: dict[str, Any], method: str, path: str, op_id: str | None
) -> None:
    """Enforce the write-only policy contract on one curation entry.

    Args:
        entry (dict[str, Any]): The ``_TOOL_CURATION`` entry for the operation.
        method (str): Lowercase HTTP method of the operation.
        path (str): Public path the operation lives on (for error messages).
        op_id (str | None): The operation's ``operationId`` (for error messages).

    Raises:
        ValueError: If a GET entry carries a ``policy`` key (the vocabulary is
            write-only), or if an enabled non-GET entry's ``policy`` is not a
            dict with exactly the keys ``{approvalClass, minRole, tenancy}``
            and legal values.
    """
    if method == "get":
        if "policy" in entry:
            raise ValueError(
                f"read tool GET {path} ({op_id}): x-tool entries on GET "
                "operations must not carry a policy — the vocabulary is write-only"
            )
        return
    if not entry.get("enabled"):
        return
    policy = entry.get("policy")
    valid = (
        isinstance(policy, dict)
        and set(policy) == set(_POLICY_VALUES)
        and all(policy[key] in values for key, values in _POLICY_VALUES.items())
    )
    if not valid:
        raise ValueError(
            f"enabled write tool {method.upper()} {path} ({op_id}): x-tool policy "
            "must be a dict with exactly the keys {approvalClass, minRole, tenancy} "
            "and legal values"
        )


def _validate_agent_hidden_params(
    entry: dict[str, Any],
    op: dict[str, Any],
    schema: dict[str, Any],
    method: str,
    path: str,
    op_id: str | None,
) -> None:
    """Enforce the agent-hidden-params contract on one curation entry.

    ``agentHiddenParams`` marks request-body fields that stay in the public
    API/CLI contract but that the agent's tool factory must neither expose to
    the model nor accept from it.

    Args:
        entry (dict[str, Any]): The ``_TOOL_CURATION`` entry for the operation.
        op (dict[str, Any]): The OpenAPI operation (for its ``requestBody``).
        schema (dict[str, Any]): The public-only document, used to resolve a
            request-body ``$ref`` against ``components.schemas``.
        method (str): Lowercase HTTP method of the operation.
        path (str): Public path the operation lives on (for error messages).
        op_id (str | None): The operation's ``operationId`` (for error messages).

    Raises:
        ValueError: If ``agentHiddenParams`` appears on a GET or disabled
            entry, is not a non-empty list of strings, or names a field that
            does not exist in the operation's JSON request-body properties
            (stale after a field rename or removal).
    """
    hidden = entry.get("agentHiddenParams")
    if hidden is None:
        return
    if method == "get" or not entry.get("enabled"):
        raise ValueError(
            f"tool {method.upper()} {path} ({op_id}): agentHiddenParams is only "
            "legal on an enabled non-GET entry"
        )
    if not (isinstance(hidden, list) and hidden and all(isinstance(n, str) for n in hidden)):
        raise ValueError(
            f"enabled write tool {method.upper()} {path} ({op_id}): "
            "agentHiddenParams must be a non-empty list of strings"
        )
    body_schema = (
        op.get("requestBody", {}).get("content", {}).get("application/json", {}).get("schema", {})
    )
    ref = body_schema.get("$ref")
    if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
        body_schema = (
            (schema.get("components") or {}).get("schemas", {}).get(ref.rsplit("/", 1)[1], {})
        )
    properties = body_schema.get("properties", {})
    for name in hidden:
        if name not in properties:
            raise ValueError(
                f"enabled write tool {method.upper()} {path} ({op_id}): "
                f"agentHiddenParams names unknown requestBody property {name!r}"
            )


def _apply_tool_curation(schema: dict[str, Any]) -> None:
    """Stamp the per-operation ``x-tool`` block from ``_TOOL_CURATION``.

    Args:
        schema (dict[str, Any]): The public-only OpenAPI document; mutated in
            place.

    Raises:
        ValueError: If a public operation has no curation entry — forces every
            new endpoint to make an explicit tool decision in the same PR — if
            a curation entry matches no public operation (stale after a rename
            or removal), if an entry violates the write-tool policy contract
            (see :func:`_validate_curation_policy`), or if an entry violates
            the agent-hidden-params contract (see
            :func:`_validate_agent_hidden_params`).
    """
    consumed: set[str] = set()
    for path, item in schema["paths"].items():
        for method, op in item.items():
            if method not in _HTTP_METHODS:
                continue
            op_id = op.get("operationId")
            entry = _TOOL_CURATION.get(op_id or "")
            if entry is None:
                raise ValueError(
                    f"public operation {method.upper()} {path} ({op_id}) has no "
                    "_TOOL_CURATION entry — add one (enabled or disabled)"
                )
            _validate_curation_policy(entry, method, path, op_id)
            _validate_agent_hidden_params(entry, op, schema, method, path, op_id)
            consumed.add(op_id)
            op["x-tool"] = copy.deepcopy(entry)
    stale = set(_TOOL_CURATION) - consumed
    if stale:
        raise ValueError(
            "stale _TOOL_CURATION entries with no matching public operation: "
            + ", ".join(sorted(stale))
        )


def _collect_refs(node: Any, acc: set[str]) -> None:
    """Collect component schema names referenced by `$ref` anywhere under `node`."""
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
            acc.add(ref.rsplit("/", 1)[1])
        for value in node.values():
            _collect_refs(value, acc)
    elif isinstance(node, list):
        for value in node:
            _collect_refs(value, acc)


def build_public_schema(app: Any) -> dict[str, Any]:
    """Return the public-only OpenAPI document for `app`.

    Keeps only `/api/v1/public/*` paths and the component schemas transitively
    referenced by them, so unrelated (internal/session) model changes don't churn
    the public artifact.
    """
    full = app.openapi()
    # app.openapi() returns FastAPI's *cached* document; its path-item and
    # component-schema dicts are shared with it. _apply_public_contract mutates
    # path operations in place, so deep-copy everything that enters (and may be
    # mutated in) the public document to avoid corrupting the cached full schema.
    paths = {
        p: copy.deepcopy(item) for p, item in full["paths"].items() if p.startswith(PUBLIC_PREFIX)
    }

    all_schemas = (full.get("components") or {}).get("schemas", {})
    referenced: set[str] = set()
    _collect_refs(paths, referenced)
    # Transitively pull in nested schema references to a fixpoint.
    changed = True
    while changed:
        changed = False
        for name in list(referenced):
            schema = all_schemas.get(name)
            if schema is None:
                continue
            before = len(referenced)
            _collect_refs(schema, referenced)
            changed = changed or len(referenced) != before

    components: dict[str, Any] = {}
    if referenced:
        components["schemas"] = {
            n: copy.deepcopy(all_schemas[n]) for n in referenced if n in all_schemas
        }

    schema = {
        "openapi": full["openapi"],
        "info": {"title": TITLE, "version": full["info"]["version"]},
        "paths": paths,
        "components": components,
    }
    _apply_public_contract(schema)
    _apply_filters_param_schema(schema)
    _apply_widget_spec_vocabulary(schema)
    _apply_tool_curation(schema)
    return schema


def render(schema: dict[str, Any]) -> str:
    """Deterministic serialization (sorted keys) for stable diffs / drift checks."""
    return json.dumps(schema, indent=2, sort_keys=True) + "\n"
