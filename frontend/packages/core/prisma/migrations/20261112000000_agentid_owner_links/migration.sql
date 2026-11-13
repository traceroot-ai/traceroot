BEGIN;
SET LOCAL lock_timeout = '5s';

-- AgentID per-owner sign-up cap: each agent's AgentMail owner. Additive.
CREATE TABLE "agentid_owner_links" (
    "agent_sub" VARCHAR NOT NULL,
    "owner_sub" VARCHAR NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agentid_owner_links_pkey" PRIMARY KEY ("agent_sub")
);

CREATE INDEX "ix_agentid_owner_link_owner_sub" ON "agentid_owner_links"("owner_sub");

COMMIT;
