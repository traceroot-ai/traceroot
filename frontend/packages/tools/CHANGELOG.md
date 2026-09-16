# Changelog

All notable changes to `@traceroot-ai/tools`. This package is versioned independently of the
TraceRoot platform (`vX.Y.Z` releases); see [Releasing](./README.md#releasing).

## 0.2.0 (2026-09-14)

### New operations

- **Creates** (user credential only): `create_workspace`, `create_project`, `create_detector`,
  `create_dashboard`, `create_widget`. Idempotent on the resource's natural name where one exists;
  widgets are strict. Every entry carries policy metadata (approval class, minimum role, tenancy).
- **Dashboards**: `list_dashboards`, `get_dashboard`.
- **Alerts**: `list_alerts`, `get_alert`, `create_alert` (strict create; alerts share names).

### Generator

- Write operations require complete policy metadata; an unclassified write fails the build.
- Agent-hidden parameters stay out of the model-facing tool schema.
- Body schemas without top-level properties fail closed.
- `ParamSchema.type` accepts a list of types for union values.

### Not in this release

Widget query and whole-dashboard data (arrive with the agent stack in 0.3.0); updates, pause and
delete for any resource (the update phase).

## 0.1.0 (2026-08-19)

Initial release of the registry, generated from the public OpenAPI schema, with the generic
dispatcher, API client, and pi surface adapter.

- **Reads**: `whoami`, `list_traces`, `get_trace`, `export_trace`, `list_trace_filter_values`,
  `list_sessions`, `get_session`, `list_detectors`, `get_detector`, `list_findings`, `get_finding`,
  `get_finding_by_trace`.

Published manually, so this version has no npm provenance attestation.
