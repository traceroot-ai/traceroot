# Public SQL Gateway — ClickHouse operational runbook

Provisioning for the read-only SQL gateway DB layer. Commands below are the
forms proven against ClickHouse **24.3.18.7**.

> **Version warning.** Staging runs `bitnamilegacy/clickhouse:25.2.1-debian-12-r0`. Nothing in
> this runbook has been re-verified on 25.2 — treat the 24.3 results as indicative, not proven,
> for the cloud path.

> **Tenant isolation is application-enforced.** DB grants do **not** restrict which
> `project_id` a caller passes to a curated view — a holder of the view grant can call
> `spans_public_v1(project_id = '<any>')`. The application MUST bind the *authenticated*
> `project_id` into the view call. At the DB layer the read-only user is denied the raw
> physical tables, other application databases, and — via access-management grants — most
> `system.*` tables. But ClickHouse still exposes some system metadata (e.g. `system.settings`,
> `system.functions`, `system.databases`) to any user for query processing, so the gateway's
> SQL validator must reject **all** `system.*` references (the application's SQL validator layer);
> do not rely on DB grants alone to hide `system.*`.

## Components

1. **Curated views** `spans_public_v1` / `traces_public_v1` — created by migration
   `006_create_public_sql_views.sql`. Parameterized on `{project_id:String}`, `SQL SECURITY
   DEFINER`, deduped after the project filter. They project curated analytical columns only
   (never `project_id`, `ch_create_time`, `ch_update_time`, or `input`/`output`/`metadata`).
2. **Scoped writer user** — the view DEFINER. Holds `SELECT` on the physical `spans`/`traces`
   tables only. NOT a superuser.
3. **Read-only user** — the identity the backend uses to run user SQL, granted `SELECT` on the
   curated views **only**. Called `sql_gateway_ro` in the examples below; set the backend's
   `CLICKHOUSE_RO_USER` / `CLICKHOUSE_RO_PASSWORD` to this user's credentials.
4. **Settings profile** — enforces the resource caps as immutable (`CONST`) settings.

## Provisioning order (run once, with an admin client)

```sql
-- 1) Scoped writer user = the view DEFINER. SELECT on the physical tables only; NOT a superuser.
--    Use a REAL secret — never no_password: this account can read raw tenant data.
CREATE USER IF NOT EXISTS sql_gateway_writer
    IDENTIFIED WITH sha256_password BY '<writer-secret>';
GRANT SELECT ON <database>.spans  TO sql_gateway_writer;
GRANT SELECT ON <database>.traces TO sql_gateway_writer;

-- 2) Apply migration 006 — it creates spans_public_v1 / traces_public_v1 with
--    DEFINER = sql_gateway_writer. MUST run AFTER step 1, or the CREATE VIEW fails
--    ("There is no user 'sql_gateway_writer'"). May be applied by an admin/deploy user
--    (it does not have to run AS the writer); the stored definer is sql_gateway_writer.
--    e.g.  goose -dir backend/db/clickhouse/migrations clickhouse "<dsn>" up

-- 3) Settings profile — caps as CONST (immutable; a readonly=1 user cannot change them).
CREATE SETTINGS PROFILE IF NOT EXISTS sql_readonly_profile SETTINGS
    readonly = 1,
    max_execution_time = 30 CONST,
    max_result_rows = 100000 CONST,
    max_result_bytes = 536870912 CONST,
    max_memory_usage = 4294967296 CONST;

-- 4) Read-only user used by the backend for user SQL (set CLICKHOUSE_RO_USER=sql_gateway_ro).
CREATE USER IF NOT EXISTS sql_gateway_ro
    IDENTIFIED WITH sha256_password BY '<ro-secret>'
    SETTINGS PROFILE 'sql_readonly_profile';

-- 5) Grant the RO user SELECT on the curated views ONLY (never the physical tables).
GRANT SELECT ON <database>.spans_public_v1  TO sql_gateway_ro;
GRANT SELECT ON <database>.traces_public_v1 TO sql_gateway_ro;
```

## Required deploy order

1. Create `sql_gateway_writer` (+ `SELECT` on the physical `spans`/`traces`).
2. Run migration 006 — creates the views with `DEFINER = sql_gateway_writer`.
3. Create `sql_readonly_profile` and `sql_gateway_ro`.
4. Grant `sql_gateway_ro` `SELECT` on `spans_public_v1` / `traces_public_v1`.
5. Set the backend `CLICKHOUSE_RO_USER` / `CLICKHOUSE_RO_PASSWORD`.
6. Deploy the app (the public SQL endpoint, delivered separately).
7. Verify `SHOW CREATE VIEW` shows `DEFINER = sql_gateway_writer`.
8. Verify `sql_gateway_ro` is denied on the physical tables (Code 497).

Step 1 MUST precede step 2 (the definer is resolved at `CREATE VIEW` time). Steps
3–4 may run before step 2 as well: ClickHouse grants are **name-based** and are
recorded even when the target view does not exist yet (verified on 24.3.18.7), so a
single pre-migration bootstrap may create every user and grant at once. The numbered
order above is the safe logical sequence for staged/manual provisioning.

## Per-environment provisioning

- **Local dev & docker-compose (automatic — no manual step).** The `clickhouse-init`
  service (`docker-compose.yml`, `docker-compose.prod.yml`) pipes
  `backend/db/clickhouse/bootstrap/sql_gateway_users.sql` through `clickhouse-client`
  and `migrate-clickhouse` gates on it
  (`depends_on: clickhouse-init: condition: service_completed_successfully`). `make dev`
  runs it via `tmux_tools/launcher.py` before `goose up` (the goose docker fallback uses
  `--no-deps`, so the launcher runs it explicitly). The script is idempotent and runs
  against the live server, so it also provisions existing data volumes. Dev accounts use
  `no_password`. The compose ClickHouse also mounts `clickhouse_access_management.xml`
  into `users.d/` so the admin user (`CLICKHOUSE_USER`) gains `ACCESS MANAGEMENT` +
  `SET DEFINER` — the stock user has broad DDL but **not** access management, so without
  it the `CREATE USER` bootstrap fails and migration 006 cannot set its explicit definer.
- **CI — no action.** CI does not apply ClickHouse migrations against a live server;
  the `tests/db/` migration/config/client tests are static/mocked.
- **Self-host / manual.** Run the "Provisioning order" SQL above (with **real secrets**,
  not `no_password`) against your ClickHouse before `goose up`. Note: the
  `docker-compose.prod.yml` stack instead auto-provisions the `no_password` compose
  accounts via `clickhouse-init` — for a hardened host, create the users with real
  secrets out of band and do not rely on that bootstrap.
- **Staging / production (Helm).** **Not yet implemented — the chart moved.** `deploy/` was
  removed from this repo on 2026-09-01; infrastructure now lives in three
  dedicated repos:

  | What | Repo | Notes |
  |---|---|---|
  | Helm chart | `traceroot-ai/traceroot-k8s` | `charts/traceroot/`; released by chart-releaser on merge, bump `Chart.yaml` `version` in the same PR |
  | Terraform module | `traceroot-ai/traceroot-terraform-aws` | public, installs the chart |
  | Environments | `traceroot-ai/traceroot-infra` (private) | `staging/` + `production/` pin a module version; ESO delivery lives in `eso/` |

  The gap itself is unchanged: `charts/traceroot/templates/migrations/migrate-clickhouse.yaml`
  runs at `hook-weight: 0` and nothing provisions the gateway users. Verified against the
  chart at v1.0.0 — no `usersExtraOverrides`, no `access_management`, no `sql_gateway`
  reference anywhere, and `rest/deployment.yaml` wires `CLICKHOUSE_USER`/`CLICKHOUSE_PASSWORD`
  but no read-only pair.

  What the implementation needs, by repo:
  - **`traceroot-k8s`** — the `provision-clickhouse-users` hook Job at `hook-weight: -5`,
    `clickhouse.usersExtraOverrides` granting the admin `access_management`, and
    `CLICKHOUSE_RO_USER`/`CLICKHOUSE_RO_PASSWORD` in `rest/deployment.yaml`.
    `usersExtraOverrides` is confirmed supported by the bundled Bitnami clickhouse 8.0.5
    subchart (`templates/configmap-users-extra.yaml`), and it is a distinct config slot from
    `extraOverrides`, which staging already uses for log-table removal — adding one does not
    disturb the other.
  - **`traceroot-infra`** — add `clickhouse-writer-password` and `clickhouse-ro-password` to
    the `traceroot/<env>/app` secret in AWS Secrets Manager, then bump
    `traceroot_helm_chart_version` in `staging/main.tf` and apply.

  **Secrets come from ESO, not Terraform.** Both environments set `manage_app_secrets = false`,
  so the Terraform module generates no application secrets at all — an earlier plan to add
  `random_password` resources to the module does not apply. External Secrets Operator syncs
  `traceroot/<env>/app` into the `traceroot` Kubernetes Secret using `dataFrom: extract`
  (`traceroot-infra/eso/setup-eso.sh`), which pulls **every** key in that JSON document. Adding
  the two passwords is therefore a Secrets Manager write plus a refresh (interval 1h) — no ESO
  manifest change and no Terraform change.

  **First rollout onto an already-running cluster — one-time manual sequencing.** Helm runs
  `pre-upgrade` hooks *before* it updates non-hook resources (the ClickHouse StatefulSet). On
  the very first upgrade that introduces `access_management`, the provisioning hook would run
  against the old pod that lacks it and fail with a permissions error (no retry can fix that).
  Do it in two steps: (1) upgrade with only the `usersExtraOverrides` change and confirm the
  ClickHouse pod rolled with the new flag (`SHOW GRANTS` shows `ACCESS MANAGEMENT`); (2) upgrade
  again to add the provisioning Job + enable the migration. Fresh installs and every subsequent
  upgrade need no manual step. Confirm afterwards: `SHOW CREATE VIEW` shows the writer definer,
  and `sql_gateway_ro` is denied the physical tables (Code 497). Under the current repo layout
  each step is a chart release plus a version bump in `staging/main.tf`, and `traceroot-infra`'s
  rule is staging first, always.

  Secret rotation is handled in-code: the provisioning Job follows each `CREATE USER` with
  `ALTER USER ... IDENTIFIED WITH sha256_password BY ...`, so a rerun after rotating the
  writer/ro secrets propagates the new password.

### Verifying on staging with read-only access

Engineers get `AmazonEKSViewPolicy` on staging via Identity Center
(`traceroot-infra/staging/main.tf`), deliberately not `AmazonEKSAdminViewPolicy` — AdminView
would expose the Secrets that ESO syncs. Confirmed live on 2026-09-03 as
`AWSReservedSSO_Engineer_.../hao` against `traceroot-staging`:

| `kubectl auth can-i` | |
|---|---|
| `get pods`, `get pods/log`, `get configmaps`, `get statefulsets`, `get jobs`, `get events` | yes |
| `create pods/exec`, `create pods/portforward`, `create pods` | **no** |
| `get secrets`, `get externalsecrets` | **no** |

So an engineer **cannot** open a ClickHouse session on staging: every route to one
(`exec`, `port-forward`, or running a throwaway client pod) requires a create verb that View
withholds, and the admin and `sql_gateway_ro` passwords are Secret keys that View cannot read.
`SHOW CREATE VIEW` and the Code 497 denial check therefore cannot be run ad hoc by an engineer.

Two consequences for the implementation:

1. **The provisioning Job must report its own verification.** Have it run `SHOW CREATE VIEW`
   and the `sql_gateway_ro`-denial probe and print the results, so the evidence lands somewhere
   a logs-only reader can see.
2. **Do not leave the default hook-delete-policy on that Job.** `migrate-clickhouse.yaml` uses
   `hook-delete-policy: before-hook-creation,hook-succeeded`, which deletes the Job and its pod
   on success — confirmed on staging, where `kubectl get jobs` returns nothing despite
   migrations having run. Logs of a successful run are unrecoverable. For the provisioning Job,
   drop `hook-succeeded` and keep `before-hook-creation` so the Job persists until the next
   release replaces it.

Anything needing an actual query — including the open access-management question below — has to
be run by an admin principal (`sso_admin` or the deploy role) or emitted by the Job.

### Open items — must be settled before enabling the gateway in the cloud

- **ClickHouse version gap.** All of this was verified against **24.3** — the
  `ddl-check` run on 24.3.18.7 and the compose end-to-end run. Staging runs
  **`bitnamilegacy/clickhouse:25.2.1-debian-12-r0`**. Re-verify explicit `DEFINER` /
  `SQL SECURITY DEFINER` semantics, settings-profile enforcement, and the readonly denial on
  25.2 before relying on any of the 24.3 results.
- **Does the admin already carry access management?** Narrowed but not settled. The Bitnami
  clickhouse 8.0.5 chart never sets `access_management` (grepped, no match), and the rendered
  `traceroot-clickhouse` ConfigMap on staging contains no `<users>` block, so if the admin has
  it, it comes from the image entrypoint rather than from chart config. Settle it with
  `SHOW GRANTS` from an admin session — if the admin already has it, the `usersExtraOverrides`
  change is redundant and the two-step rollout above is unnecessary.
- **`helm template` / `helm lint` and `terraform fmt`/`validate`** have never been run against
  these changes; neither tool was available where they were authored.
- **The migration number collides with `main`.** This work numbers the views migration
  `006_create_public_sql_views.sql`, but `main` now has `006_add_source_column.sql` and runs
  through `011_add_is_evaluation.sql`. It must be renumbered (`012_`) when the branch is
  rebased, and every "migration 006" reference in this runbook updated with it.

## DEFINER: explicit scoped writer

Migration 006 sets the view definer **explicitly** to `sql_gateway_writer`:

```sql
CREATE OR REPLACE VIEW spans_public_v1
    DEFINER = sql_gateway_writer SQL SECURITY DEFINER AS ...
```

- **`sql_gateway_writer` MUST exist before migration 006 runs** (provisioning step 1). If it
  does not, `CREATE VIEW` fails with `There is no user 'sql_gateway_writer'`. This makes the
  security dependency explicit and enforced instead of silently defaulting to whoever applies
  the migration.
- The migration **may be applied by an admin/deploy user** — it does not have to run *as*
  `sql_gateway_writer` — provided that user has permission to create a view with a different
  definer (admins do). The stored definer is `sql_gateway_writer` regardless of who runs the DDL.
- `sql_gateway_writer` is a **dedicated, non-superuser role** holding only `SELECT` on the
  physical `spans`/`traces` tables. `sql_gateway_ro` holds `SELECT` on the curated
  `*_public_v1` views **only** (never the physical tables); it reads the views because the
  view body runs under the writer's privileges.

Verify:

```sql
SHOW CREATE VIEW <database>.spans_public_v1;
--   expect: DEFINER = sql_gateway_writer SQL SECURITY DEFINER
-- RO user can read the view but NOT the physical table:
--   SELECT 1 FROM <database>.spans_public_v1(project_id = 'x')   -> ok
--   SELECT 1 FROM <database>.spans                               -> ACCESS_DENIED (Code 497)
```

> **Verified on ClickHouse 24.3.18.7** (`scripts/spikes/clickhouse_public_views_ddl_check.sh`):
> after creating `sql_gateway_writer` (SELECT on physical tables), applying migration 006's
> `Up` DDL stores `DEFINER = sql_gateway_writer SQL SECURITY DEFINER`; parameterization
> (`WHERE project_id = {project_id:String}`) is preserved; the RO user reads the view but is
> denied the physical table (Code 497); and a foreign `project_id` returns that project's rows
> — the DB has no tenant-choice backstop, so the application must bind the authenticated
> `project_id`.

## Backend behavior

- Set `CLICKHOUSE_RO_USER` / `CLICKHOUSE_RO_PASSWORD`. `get_readonly_clickhouse_client()` uses
  them. If unset: **fatal in cloud** (`ENABLE_BILLING` != `false`); **warn + fall back to the
  default client** on local/dev/self-host.
- Under `readonly = 1`, the RO user cannot apply per-query `SETTINGS`. The query service
  therefore relies on the profile for caps and applies row limits via a `LIMIT`
  wrapper in the SQL text, never via per-query settings.
- **RO env wiring:** the chart's `rest/deployment.yaml` must pass `CLICKHOUSE_RO_USER` /
  `CLICKHOUSE_RO_PASSWORD` (the host that serves the SQL endpoint). As of `traceroot-k8s`
  v1.0.0 it does **not** — see the staging/production section above. Also not wired, and
  intentionally so since nothing reads the RO client there: `docker-compose.prod.yml`'s app
  services and the chart's `worker`. Wire them if the public SQL endpoint ever runs outside `rest`
  (in cloud, `rest` defaults `ENABLE_BILLING=true`, so a missing `CLICKHOUSE_RO_USER` is fatal
  by design).
