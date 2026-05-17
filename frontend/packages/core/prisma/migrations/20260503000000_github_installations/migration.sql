-- Move GitHub App connections from user level to workspace level.
--
-- Breaking change: drops github_connections entirely. Existing users will see
-- an unconnected state and reconnect via the normal Connect flow. The GitHub
-- App installations on github.com are unaffected — re-OAuth discovers them
-- and writes a row into the new table.

-- DropForeignKey
ALTER TABLE "github_connections" DROP CONSTRAINT IF EXISTS "github_connections_user_id_fkey";

-- DropTable
DROP TABLE IF EXISTS "github_connections";

-- CreateTable
CREATE TABLE "github_installations" (
    "id" VARCHAR NOT NULL,
    "workspace_id" VARCHAR NOT NULL,
    "installation_id" VARCHAR NOT NULL,
    "account_login" VARCHAR NOT NULL,
    "installed_by_user_id" VARCHAR,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "github_installations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_github_installation" ON "github_installations"("workspace_id", "installation_id");

-- CreateIndex
CREATE INDEX "ix_github_installation_workspace_id" ON "github_installations"("workspace_id");

-- AddForeignKey
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
