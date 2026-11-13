# CLI public API handoff

This is the backend contract for engineers working on the standalone
[`traceroot-cli`](https://github.com/traceroot-ai/traceroot-cli) repo. It says where the public
API schema lives, how it changes, and the parts of the contract the schema alone does not
explain. Request and response shapes are not repeated here; they come from the schema.

## Base path and versioning

The CLI reads and writes project data only through `/api/v1/public/*`. That prefix is the
versioned contract (#1036). Browser login and the token exchange live in the web app (see
[Authentication](../api-reference/authentication.mdx)) and are not in this schema.
`/api/v1/projects/*` and internal routes are not part of the contract either, even when they
return similar data.

Within `v1`, changes are additive: a new endpoint, a new optional query parameter, or a new
response field. Removing or renaming a field, changing its type, or making an optional input
required needs a new version. Clients should ignore response fields they do not know.

## Where the schema lives

The canonical artifact is
[`backend/rest/openapi/public.json`](https://github.com/traceroot-ai/traceroot/blob/main/backend/rest/openapi/public.json).
It is generated from the live FastAPI routes, never edited by hand:

```bash
uv run python scripts/sync_public_openapi.py           # regenerate
uv run python scripts/sync_public_openapi.py --check   # exit 1 if it drifts
```

The same script writes [`docs/api-reference/openapi.json`](../api-reference/openapi.json), the
copy the published API reference reads (it adds the `servers` block and docs-only notes), and the widget registry
snapshot. The CLI vendors `public.json`, not the docs copy.

## How drift is caught

In this repo, a change to a public route that is not followed by a regenerate fails CI:

- `tests/rest/test_public_openapi.py` holds both `public.json` and the docs copy to the live
  routes.
- `frontend/packages/tools/src/__tests__/registry-drift.test.ts` asserts the tool registry
  published as `@traceroot-ai/tools` equals a fresh generation from `public.json`.

Nothing guards the hop into the CLI. The CLI keeps its own copy as `openapi.json` and records
the backend commit and sha256 it was taken from in its
[`OPENAPI.md`](https://github.com/traceroot-ai/traceroot-cli/blob/main/OPENAPI.md). Its
`codegen:check` compares the generated `schema.ts` against that copy only, so the copy can lag
`main` indefinitely without anything failing. At runtime this is mostly invisible, since the
client returns the JSON it receives, but the typed surface is wrong and new fields go
unnoticed. For example, the copy vendored on 2026-09-24 (backend `8de2bea58`) has no `key_scope`
on `whoami` (#2617) and none of the `/signals` routes (#2574).

Today a CLI engineer learns that a field exists by reading this repo. The recommended fix is on
the CLI side: a CI step that fetches `public.json` from `main` and fails when it differs from
the vendored `openapi.json`:

```bash
curl -fsSL https://raw.githubusercontent.com/traceroot-ai/traceroot/main/backend/rest/openapi/public.json \
  | diff -q - openapi.json
```

A failure means "refresh per `OPENAPI.md`", not "the backend broke you": under the versioning
rule above, most differences are additive.

## Host and auth

TraceRoot Cloud serves the public API at `https://app.traceroot.ai`. A self-hosted backend
defaults to `http://localhost:8000`. Keep the host configurable.

Every request sends a bearer token:

```http
Authorization: Bearer <credential>
```

Which credentials a route accepts is in [Authentication](../api-reference/authentication.mdx).
In short: a project API key fixes its own project, so it needs no `project_id`. A session token
or CLI access token also works for the trace reads and export, but needs `project_id`.
`GET /whoami` takes an API key only.

## `whoami`

`GET /api/v1/public/whoami` returns the identity an API key resolves to, for `login --api-key`
and `status`.

- The full key is never returned, only `key_hint`.
- `project_name`, `workspace_name`, `key_name` and `key_hint` may be `null`; the backend does
  not fabricate them.
- `key_scope` is never null. It is `ingest` or `admin`, as the auth layer enforces it.
- `host` echoes the URL the request reached. It is client-controllable, so treat it as
  informational and never route requests from it.
- `ui_base_url` is the browser-facing UI base, from `TRACEROOT_PUBLIC_UI_URL`. In a self-hosted
  deployment it can differ from the API host.

## Trace links

The trace list and trace get responses carry a `trace_url` built by the backend, shaped
`{ui_base_url}/projects/{project_id}/traces?traceId={trace_id}`. Use it as returned; do not
rebuild it in the CLI, so frontend route changes do not break the CLI.

## Export bundle

`GET /api/v1/public/traces/{trace_id}/export` returns one JSON object, the V1 bundle:

- `manifest`: `trace_id`, `project_id`, `bundle_version` (`v1`), and `files`, which lists the
  file names to write the bundle to: `trace.json`, `spans.json`, `git_context.json`,
  `manifest.json`.
- `trace`: the same payload `traces get` returns.
- `spans`: the same spans as `trace.spans`, kept separate so a tool can read spans without
  parsing the trace.
- `git_context`: `git_repo`, `git_ref`, and per-span source locations.

Export defaults to the `full` projection (per-span input, output and metadata), while trace get
defaults to `skeleton`. Both take `fields` to change it.
