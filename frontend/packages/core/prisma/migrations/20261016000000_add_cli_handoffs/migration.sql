-- CLI handoffs: single-use tickets that let browser-first onboarding hand the
-- terminal a session without a second browser page. code_hash is the SHA-256
-- hex of the code; the code itself is never stored, so a read of this table
-- yields nothing usable. A new table only, no existing table touched. Bound
-- lock acquisition; roll back atomically on timeout and retry during a quiet
-- window.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- CreateTable
CREATE TABLE "cli_handoffs" (
    "id" VARCHAR NOT NULL,
    "code_hash" VARCHAR NOT NULL,
    "user_id" VARCHAR NOT NULL,
    "issued_by_session_id" VARCHAR,
    "project_id" VARCHAR,
    "workspace_id" VARCHAR,
    "client_id" VARCHAR,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "redeemed_at" TIMESTAMP(6),
    "redeemed_session_id" VARCHAR,
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "cli_handoffs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cli_handoffs_code_hash_key" ON "cli_handoffs"("code_hash");

-- CreateIndex
CREATE INDEX "ix_cli_handoff_user_id" ON "cli_handoffs"("user_id");

-- CreateIndex
CREATE INDEX "ix_cli_handoff_expires_at" ON "cli_handoffs"("expires_at");

-- AddForeignKey
ALTER TABLE "cli_handoffs" ADD CONSTRAINT "cli_handoffs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
