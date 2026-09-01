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

PUBLIC_PREFIX = "/api/v1/public/"
TITLE = "TraceRoot Public API"

_HTTP_METHODS = {"get", "post", "put", "patch", "delete"}
_BEARER_SCHEME = {"type": "http", "scheme": "bearer"}
_ERROR_SCHEMA = {"type": "object", "properties": {"detail": {"type": "string"}}}


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
    # Evaluation reporting endpoints are SDK-facing writes, not agent tools (like ingest_traces).
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
        "policy": {"approvalClass": "none", "minRole": "VIEWER", "tenancy": "account"},
    },
    "create_project": {
        "name": "create_project",
        "description": (
            "Create a project in a workspace the logged-in user can write to "
            "(idempotent on the project name within the workspace)."
        ),
        "enabled": True,
        "policy": {"approvalClass": "none", "minRole": "MEMBER", "tenancy": "workspace"},
        # API/CLI-visible but hidden from the agent: no UI form exposes the
        # field, so the model shouldn't interrogate users about it.
        "agentHiddenParams": ["trace_ttl_days"],
    },
    "create_detector": {
        "name": "create_detector",
        "description": (
            "Create a detector (name, template, prompt, optional sampling/RCA "
            "settings) in a project — idempotent on the detector name within "
            "the project."
        ),
        "enabled": True,
        "policy": {"approvalClass": "none", "minRole": "MEMBER", "tenancy": "project"},
    },
    "create_dashboard": {
        "name": "create_dashboard",
        "description": (
            "Create a dashboard in a project (idempotent on the dashboard name "
            "within the project); add charts to it with create_widget."
        ),
        "enabled": True,
        "policy": {"approvalClass": "none", "minRole": "MEMBER", "tenancy": "project"},
    },
    "create_widget": {
        "name": "create_widget",
        "description": (
            "Add a widget (title, type, spec) to an existing dashboard. Type "
            '"query" charts a metric (spec: view/filters/metric/breakdown/'
            'display); type "trace_feed" lists recent traces (spec: predicate '
            "filters + limit). Strict create: every call adds a new widget."
        ),
        "enabled": True,
        "policy": {"approvalClass": "none", "minRole": "MEMBER", "tenancy": "project"},
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
_POLICY_VALUES: dict[str, tuple[str, ...]] = {
    "approvalClass": ("none", "approval"),
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
    _apply_tool_curation(schema)
    return schema


def render(schema: dict[str, Any]) -> str:
    """Deterministic serialization (sorted keys) for stable diffs / drift checks."""
    return json.dumps(schema, indent=2, sort_keys=True) + "\n"
