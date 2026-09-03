-- Back the write paths' idempotent creates with unique indexes on their
-- natural keys, so two concurrent identical creates cannot both pass the
-- read-then-insert existence check and fan out duplicates. The services
-- catch the loser's unique violation and return the existing row.

-- Workspaces have no owner column, but the workspace idempotency key is
-- (creating user, name). Denormalize the creator onto the row (mirroring
-- dashboards.created_by: a bare user id, no FK) so the key is indexable.
-- Legacy rows backfill from their oldest ADMIN member; a workspace with no
-- admin stays NULL and never collides (unique indexes treat NULLs as
-- distinct).
ALTER TABLE "workspaces" ADD COLUMN "created_by" VARCHAR;

UPDATE "workspaces" w
SET "created_by" = (
    SELECT wm."user_id"
    FROM "workspace_members" wm
    WHERE wm."workspace_id" = w."id" AND wm."role" = 'ADMIN'
    ORDER BY wm."create_time", wm."id"
    LIMIT 1
);

-- Existing duplicates would fail the CREATE UNIQUE INDEX statements below and
-- abort the whole migration, so deduplicate deterministically first: within
-- each key, the oldest row (create_time, then id) keeps its name and every
-- younger duplicate is renamed with a " (2)", " (3)", ... suffix in age
-- order. Each rename pass runs in a loop because a suffixed name can itself
-- collide with a pre-existing row (e.g. "X" beside an older "X (2)"); every
-- pass strictly lengthens the renamed names, so the loop terminates. All of
-- this runs inside the migration's transaction: either the dedupe and the
-- index both land, or neither does.

DO $$
DECLARE renamed integer;
BEGIN
  LOOP
    WITH ranked AS (
      SELECT id, row_number() OVER (
        PARTITION BY created_by, name ORDER BY create_time, id
      ) AS rn
      FROM workspaces
      WHERE created_by IS NOT NULL
    )
    UPDATE workspaces w
    SET name = w.name || ' (' || r.rn || ')',
        update_time = now()
    FROM ranked r
    WHERE w.id = r.id AND r.rn > 1;
    GET DIAGNOSTICS renamed = ROW_COUNT;
    EXIT WHEN renamed = 0;
  END LOOP;
END $$;

-- Projects: only live rows compete for a name (soft-deleted rows keep theirs
-- untouched, matching the partial index below).
DO $$
DECLARE renamed integer;
BEGIN
  LOOP
    WITH ranked AS (
      SELECT id, row_number() OVER (
        PARTITION BY workspace_id, name ORDER BY create_time, id
      ) AS rn
      FROM projects
      WHERE delete_time IS NULL
    )
    UPDATE projects p
    SET name = p.name || ' (' || r.rn || ')',
        update_time = now()
    FROM ranked r
    WHERE p.id = r.id AND r.rn > 1;
    GET DIAGNOSTICS renamed = ROW_COUNT;
    EXIT WHEN renamed = 0;
  END LOOP;
END $$;

-- Dashboards have no soft delete: every row competes.
DO $$
DECLARE renamed integer;
BEGIN
  LOOP
    WITH ranked AS (
      SELECT id, row_number() OVER (
        PARTITION BY project_id, name ORDER BY create_time, id
      ) AS rn
      FROM dashboards
    )
    UPDATE dashboards d
    SET name = d.name || ' (' || r.rn || ')',
        update_time = now()
    FROM ranked r
    WHERE d.id = r.id AND r.rn > 1;
    GET DIAGNOSTICS renamed = ROW_COUNT;
    EXIT WHEN renamed = 0;
  END LOOP;
END $$;

-- CreateIndex
CREATE UNIQUE INDEX "uq_workspace_created_by_name" ON "workspaces"("created_by", "name");

-- CreateIndex
CREATE UNIQUE INDEX "uq_dashboard_project_name" ON "dashboards"("project_id", "name");

-- Partial index (raw SQL — not expressible in the Prisma schema): a live
-- project's name is unique per workspace; soft-deleted projects release the
-- name without being renamed.
CREATE UNIQUE INDEX "uq_project_workspace_live_name"
    ON "projects" ("workspace_id", "name")
    WHERE "delete_time" IS NULL;
