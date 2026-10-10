-- Email sends: one row per (user, campaign) so app email that must not repeat
-- (the welcome today) is sent once however many times the code path runs. A
-- new table only, no existing table touched. Bound lock acquisition; roll back
-- atomically on timeout and retry during a quiet window.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- CreateTable
CREATE TABLE "email_sends" (
    "id" VARCHAR NOT NULL,
    "user_id" VARCHAR NOT NULL,
    "campaign" VARCHAR NOT NULL,
    "kind" VARCHAR NOT NULL,
    "claimed_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(6),
    "provider_id" VARCHAR,

    CONSTRAINT "email_sends_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_email_send_user_campaign" ON "email_sends"("user_id", "campaign");

-- AddForeignKey
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

COMMIT;
