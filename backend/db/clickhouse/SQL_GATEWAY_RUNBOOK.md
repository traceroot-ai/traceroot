# Public SQL Gateway — ClickHouse operational runbook

Provisioning for the read-only SQL gateway DB layer. Commands below are proven against
ClickHouse **24.3.18.7** and re-proven against **25.2.1.3085**, the
`bitnamilegacy/clickhouse` build staging deploys.

> **Version.** The DDL check passes on `bitnamilegacy/clickhouse:25.2.1-debian-12-r0` as well
> as on 24.3.18.7, covering **both** curated views and both physical tables: the explicit
> `DEFINER`, the read-only account reading `spans_public_v1` and `traces_public_v1`, that
> account refused `spans` and `traces` with `ACCESS_DENIED`, the `readonly = 1` profile
> rejecting a per-query `SETTINGS` override, and the row curation. Run it against any version
> you move to: `CH_IMAGE=<image> bash scripts/spikes/clickhouse_public_views_ddl_check.sh`.

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
   `012_create_public_sql_views.sql`. Parameterized on `{project_id:String}`, `SQL SECURITY
   DEFINER`, deduped after the project filter. They project curated analytical columns only
   (never `project_id`, `ch_create_time`, `ch_update_time`, or the `input`/`output` blobs;
   `metadata` is the queryable `metadata_map`, renamed, and the raw JSON document behind the
   physical `metadata` column stays unexposed). They curate **rows** as well: `source = 'user'`
   keeps customer traffic only, and evaluation traces are excluded by trace membership across
   both physical tables rather than by a per-row `is_evaluation = 0`, which would leak.
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

-- 2) Apply migration 012 — it creates spans_public_v1 / traces_public_v1 with
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
2. Run migration 012 — creates the views with `DEFINER = sql_gateway_writer`.
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
  against the live server, so it also provisions existing data volumes. Dev accounts take
  weak known defaults from `SQL_GATEWAY_WRITER_PASSWORD` and `CLICKHOUSE_RO_PASSWORD`;
  neither account is passwordless on any stack, because the writer can read the raw tables.
  The compose ClickHouse also mounts `sql_gateway_bootstrap_user.xml` into `users.d/`, which
  defines a dedicated `sql_gateway_bootstrap` account holding `ACCESS MANAGEMENT` +
  `SET DEFINER` — the stock admin has broad DDL but **not** access management, so without
  that account the `CREATE USER` bootstrap fails and migration 012 cannot set its explicit
  definer. That privilege is deliberately held by `sql_gateway_bootstrap` and **not** by
  `CLICKHOUSE_USER`: the application services (`rest`, `worker`, `billing`, `detector`) all
  authenticate as `CLICKHOUSE_USER`, so granting it access management would let a compromise
  of any one of them create further accounts. Only `clickhouse-init` and `migrate-clickhouse`
  use the bootstrap identity, and its password reaches ClickHouse through `from_env` rather
  than being written into the mounted config.
- **CI — no action.** CI does not apply ClickHouse migrations against a live server;
  the `tests/db/` migration/config/client tests are static/mocked.
- **Self-host / manual.** Run the "Provisioning order" SQL above (with **real secrets**,
  not `no_password`) against your ClickHouse before `goose up`. Note: the
  `docker-compose.prod.yml` stack provisions these accounts via `clickhouse-init` from
  `SQL_GATEWAY_WRITER_PASSWORD` and `CLICKHOUSE_RO_PASSWORD`, both of which it refuses to
  start without. The passwords are hashed before they reach ClickHouse, so they appear
  neither in the container's command line nor in `query_log`. The dev stack supplies weak
  known defaults for the same accounts.
- **Staging / production (Helm).** **Written, not yet released.** `deploy/` was
  removed from this repo on 2026-09-01; infrastructure now lives in three
  dedicated repos:

  | What | Repo | Notes |
  |---|---|---|
  | Helm chart | `traceroot-ai/traceroot-k8s` | `charts/traceroot/`; released by chart-releaser on merge, bump `Chart.yaml` `version` in the same PR |
  | Terraform module | `traceroot-ai/traceroot-terraform-aws` | public, installs the chart |
  | Environments | `traceroot-ai/traceroot-infra` (private) | `staging/` + `production/` pin a module version; ESO delivery lives in `eso/` |

  As of the released chart (v1.0.0) nothing provisions the gateway users:
  `charts/traceroot/templates/migrations/migrate-clickhouse.yaml` runs at `hook-weight: 0`,
  and there is no `usersExtraOverrides`, no `access_management` and no `sql_gateway`
  reference anywhere; `rest/deployment.yaml` wires `CLICKHOUSE_USER`/`CLICKHOUSE_PASSWORD`
  but no read-only pair. The changes below are open for review in the chart and module
  repositories and are not in any release yet, so nothing here is available to an
  environment until they merge and are tagged.

  What the implementation needs, by repo:
  - **`traceroot-k8s`** — the `provision-clickhouse-users` hook Job at `hook-weight: -5`,
    `clickhouse.usersExtraOverrides` granting the admin `access_management`, and
    `CLICKHOUSE_RO_USER`/`CLICKHOUSE_RO_PASSWORD` in `rest/deployment.yaml`.
    `usersExtraOverrides` is confirmed supported by the bundled Bitnami clickhouse 8.0.5
    subchart (`templates/configmap-users-extra.yaml`), and it is a distinct config slot from
    `extraOverrides`, which staging already uses for log-table removal — adding one does not
    disturb the other.
  - **`traceroot-terraform-aws`** — a variable that turns the chart flag on and supplies the
    admin `access_management` override alongside it. The override is a ClickHouse subchart
    setting, so the chart cannot switch it on from its own flag and it has to come from here;
    the two are emitted together so they cannot drift apart. On the turnkey path, where the
    module manages application secrets, it also generates the two account passwords.
  - **`traceroot-infra`** — add `clickhouse-writer-password` and `clickhouse-ro-password` to
    the `traceroot/<env>/app` secret in AWS Secrets Manager, then bump both the module `ref`
    and `traceroot_helm_chart_version` in `staging/main.tf`, set the enable flag, and apply.

  **Secrets come from ESO, not Terraform.** Both environments set `manage_app_secrets = false`,
  so the Terraform module generates no application secrets at all. It does generate the two
  account passwords on the turnkey path, where it manages secrets, but that branch is inert
  here. External Secrets Operator syncs
  `traceroot/<env>/app` into the `traceroot` Kubernetes Secret using `dataFrom: extract`
  (`traceroot-infra/eso/setup-eso.sh`), which pulls **every** key in that JSON document. Adding
  the two passwords is therefore a Secrets Manager write plus a refresh (interval 1h) — no ESO
  manifest change and no Terraform change.

  **No staged rollout is needed.** The bundled ClickHouse image already grants its admin
  `CREATE USER`, `ALTER USER` and `SET DEFINER` — verified directly against
  `bitnamilegacy/clickhouse:25.2.1-debian-12-r0`, where both `CREATE USER` and a
  `CREATE VIEW ... DEFINER = <other user>` succeeded with no configuration added. Nothing has
  to reach the ClickHouse pod before the provisioning hook runs, so no restart is involved and
  a single apply is enough on a running cluster as well as a fresh one.

  `clickhouse.usersExtraOverrides` covers a **chart-managed** ClickHouse only: it configures
  the bundled subchart, so it has no effect on a server the chart does not deploy
  (`clickhouse.deploy: false`). For an independently managed ClickHouse, grant the admin
  access management on that server itself — through its own `users.d` configuration, or with
  `GRANT ACCESS MANAGEMENT ON *.* TO <admin>` from an account that already holds it. The
  provisioning hook reads `SHOW GRANTS` before any DDL and stops with a named cause if
  `CREATE USER` or `SET DEFINER` is missing, so a narrower admin fails immediately and says so.

  Note the compose stack uses a different image whose admin does **not** carry access
  management, which is why the local path still mounts an access-management file — the two are
  not in conflict, they are different servers.

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

### Accounts outlive the release that created them

Provisioning creates the writer and read-only accounts and the settings profile; nothing
removes them. Two cases follow, and neither is cleaned up automatically:

- **Renaming an account in values** leaves the previous one live, still holding its password
  and its `SELECT` on the curated views. The new name is provisioned alongside it.
- **Uninstalling the release** removes no ClickHouse state at all — both accounts and the
  profile remain, with nothing recording which release created them.

This is deliberate rather than an oversight. The provisioning hook runs before the new
application pods roll, so a `DROP USER` on a renamed account would cut off every pod still
serving the old one, and a hook that deletes credentials has no safe outcome if the rename
was a typo or a bad values merge. Leaving the account is the conservative failure.

The verification hook reports the situation instead: it lists every account holding `SELECT`
on the curated views **and on the physical `spans`/`traces` tables**, warning when one is
neither the configured read-only user nor the configured writer. Both halves matter, and the
second matters more: an orphaned writer keeps SELECT on the raw tables, including the blobs the
curated views deliberately omit, so it is the more dangerous leftover of the two. That is a
warning, not a failure. Removing an orphaned account is a deliberate manual step:

```sql
DROP USER IF EXISTS <old_account>;
```

### Settled: the evaluation exclusion survives compaction

Worth recording, because it was investigated as a suspected leak and is not one.

The two halves of `VIEW_EVALUATION_EXCLUSION` behave differently under a
`ReplacingMergeTree` merge, and building the set from both is what makes it durable:

- **`traces`** — two versions of a trace collapse only when they share the *whole* sort key,
  which includes the `toDate(trace_start_time)` bucket as well as `trace_id`. When they do,
  a later batch that rewrites the row with `is_evaluation = 0` and a newer `ch_update_time`
  wins the merge and the flagged version is physically deleted, and a traces-only predicate
  would stop excluding from that point. Versions whose start times fall in different date
  buckets both survive, so this is the common shape rather than an inevitability.
- **`spans`** — `span_id` is in the sort key, so distinct spans never collapse into each
  other, and a span's flag is derived from its kind (`otel_transform` sets
  `is_evaluation = span_kind in EVALUATION_SPAN_KINDS`), which does not change between
  exports of that span. The flagged span row survives.

Ingest derives the trace-level flag *from* those spans, so a flagged trace always has a
flagged span of its own — meaning the surviving half is always populated. Verified on
25.2.1: after `OPTIMIZE ... FINAL` on both tables the flagged traces row is gone, the
flagged span row remains, and the trace stays excluded.
`clickhouse_public_views_ddl_check.sh` asserts exactly this, and fails if the flagged span
ever stops surviving.

### Open items — must be settled before enabling the gateway in the cloud

- **ClickHouse passwords passed through the environment must not contain `&`.** The image
  interpolates `CLICKHOUSE_PASSWORD` and `SQL_GATEWAY_BOOTSTRAP_PASSWORD` into its own
  generated `users.xml` without escaping, so an ampersand makes that file invalid and the
  server exits (`exit=232`) before it finishes starting. Verified on 24.3: `/`, `#`, `?` and
  `=` are all accepted; only `&` breaks it. This is upstream behaviour, not something the
  gateway introduced, and it applies to the admin password just as much.
- **Nothing has run on a cluster.** The DDL check proves the SQL model against a local
  container of the same image staging deploys; it says nothing about the chart's hooks
  executing in order, the provisioning Job reaching ClickHouse, or the read-only credentials
  arriving in the API service. A staging install is still the thing that settles those.
- **The curated views encode the public schema contract by hand.** A `.sql` migration cannot
  import `backend/rest/services/sql/schema.py`, so the column list and the two row-curation
  rules are duplicated. `tests/db/test_public_sql_views_migration.py` pins the duplicate;
  once the contract module lands on `main`, replace the pinned copies with an import so the
  two cannot drift.

## DEFINER: explicit scoped writer

Migration 006 sets the view definer **explicitly** to `sql_gateway_writer`:

```sql
CREATE OR REPLACE VIEW spans_public_v1
    DEFINER = sql_gateway_writer SQL SECURITY DEFINER AS ...
```

- **`sql_gateway_writer` MUST exist before migration 012 runs** (provisioning step 1). If it
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

> **Verified on ClickHouse 24.3.18.7 and 25.2.1.3085** (`scripts/spikes/clickhouse_public_views_ddl_check.sh`):
> after creating `sql_gateway_writer` (SELECT on physical tables), applying migration 012's
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
