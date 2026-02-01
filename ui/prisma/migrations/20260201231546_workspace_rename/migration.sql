/*
  Warnings:

  - You are about to drop the column `created_at` on the `accounts` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `accounts` table. All the data in the column will be lost.
  - You are about to drop the column `created_at` on the `projects` table. All the data in the column will be lost.
  - You are about to drop the column `deleted_at` on the `projects` table. All the data in the column will be lost.
  - You are about to drop the column `org_id` on the `projects` table. All the data in the column will be lost.
  - You are about to drop the column `retention_days` on the `projects` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `projects` table. All the data in the column will be lost.
  - You are about to drop the column `created_at` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `users` table. All the data in the column will be lost.
  - You are about to drop the `api_keys` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `membership_invitations` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `organization_memberships` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `organizations` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `update_time` to the `accounts` table without a default value. This is not possible if the table is not empty.
  - Added the required column `workspace_id` to the `projects` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_project_id_fkey";

-- DropForeignKey
ALTER TABLE "membership_invitations" DROP CONSTRAINT "membership_invitations_invited_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "membership_invitations" DROP CONSTRAINT "membership_invitations_org_id_fkey";

-- DropForeignKey
ALTER TABLE "organization_memberships" DROP CONSTRAINT "organization_memberships_org_id_fkey";

-- DropForeignKey
ALTER TABLE "organization_memberships" DROP CONSTRAINT "organization_memberships_user_id_fkey";

-- DropForeignKey
ALTER TABLE "projects" DROP CONSTRAINT "projects_org_id_fkey";

-- DropIndex
DROP INDEX "ix_project_org_id";

-- AlterTable
ALTER TABLE "accounts" DROP COLUMN "created_at",
DROP COLUMN "updated_at",
ADD COLUMN     "create_time" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "update_time" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "projects" DROP COLUMN "created_at",
DROP COLUMN "deleted_at",
DROP COLUMN "org_id",
DROP COLUMN "retention_days",
DROP COLUMN "updated_at",
ADD COLUMN     "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "delete_time" TIMESTAMP(6),
ADD COLUMN     "trace_ttl_days" INTEGER,
ADD COLUMN     "update_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "workspace_id" VARCHAR NOT NULL;

-- AlterTable
ALTER TABLE "users" DROP COLUMN "created_at",
DROP COLUMN "updated_at",
ADD COLUMN     "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "update_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- DropTable
DROP TABLE "api_keys";

-- DropTable
DROP TABLE "membership_invitations";

-- DropTable
DROP TABLE "organization_memberships";

-- DropTable
DROP TABLE "organizations";

-- CreateTable
CREATE TABLE "access_keys" (
    "id" VARCHAR NOT NULL,
    "project_id" VARCHAR NOT NULL,
    "secret_hash" VARCHAR NOT NULL,
    "key_hint" VARCHAR NOT NULL,
    "name" VARCHAR,
    "expire_time" TIMESTAMP(6),
    "last_use_time" TIMESTAMP(6),
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" VARCHAR NOT NULL,
    "email" VARCHAR NOT NULL,
    "workspace_id" VARCHAR NOT NULL,
    "role" VARCHAR NOT NULL,
    "invited_by_user_id" VARCHAR,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "id" VARCHAR NOT NULL,
    "workspace_id" VARCHAR NOT NULL,
    "user_id" VARCHAR NOT NULL,
    "role" VARCHAR NOT NULL,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" VARCHAR NOT NULL,
    "name" VARCHAR NOT NULL,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "access_keys_secret_hash_key" ON "access_keys"("secret_hash");

-- CreateIndex
CREATE INDEX "ix_access_key_project_id" ON "access_keys"("project_id");

-- CreateIndex
CREATE INDEX "ix_invite_workspace_id" ON "invites"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_invite_email_workspace" ON "invites"("email", "workspace_id");

-- CreateIndex
CREATE INDEX "ix_workspace_member_workspace_id" ON "workspace_members"("workspace_id");

-- CreateIndex
CREATE INDEX "ix_workspace_member_user_id" ON "workspace_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_workspace_user" ON "workspace_members"("workspace_id", "user_id");

-- CreateIndex
CREATE INDEX "ix_project_workspace_id" ON "projects"("workspace_id");

-- AddForeignKey
ALTER TABLE "access_keys" ADD CONSTRAINT "access_keys_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
