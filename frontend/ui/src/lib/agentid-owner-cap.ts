import type { Prisma, PrismaClient } from "@prisma/client";
import type { ValidateUserInfoResult, ValidateUserInfoSource } from "better-auth";

export const AGENTID_OWNER_LIMIT_REACHED = "agent_owner_limit_reached";
export const AGENTID_OWNER_MISSING = "agent_owner_missing";
// Same as the "Maximum signups per owner" on our production AgentID app.
export const MAX_AGENTS_PER_OWNER = 5;

// A link with no account yet counts this long, so a sign-up in flight counts
// and a failed one stops counting.
const PENDING_LINK_WINDOW = "10 minutes";

// Records the agent under its owner (an AgentMail account or organization) if
// the owner has fewer than `max` others; the lock serializes one owner's sign-ups.
export async function reserveAgentIdOwnerSlot(
  prisma: Pick<PrismaClient, "$transaction">,
  ownerSub: string,
  agentSub: string,
  max = MAX_AGENTS_PER_OWNER,
): Promise<boolean> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('agentid-owner'), hashtext(${ownerSub}))`;
    const [{ count }] = await tx.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM "agentid_owner_links" l
      WHERE l."owner_sub" = ${ownerSub}
        AND l."agent_sub" <> ${agentSub}
        AND (
          l."created_at" > now() - ${PENDING_LINK_WINDOW}::interval
          OR EXISTS (
            SELECT 1 FROM "accounts" a
            WHERE a."provider_id" = 'agentid' AND a."account_id" = l."agent_sub"
          )
        )`;
    if (count >= max) return false;
    await tx.$executeRaw`
      INSERT INTO "agentid_owner_links" ("agent_sub", "owner_sub")
      VALUES (${agentSub}, ${ownerSub})
      ON CONFLICT ("agent_sub") DO UPDATE
        SET "owner_sub" = EXCLUDED."owner_sub", "created_at" = now()`;
    return true;
  });
}

// better-auth `user.validateUserInfo`: refuses a new AgentID user with no owner
// or over the cap. Only "create-user" is checked, so returning agents get in.
export function agentIdOwnerCap(reserve: (ownerSub: string, agentSub: string) => Promise<boolean>) {
  return async ({
    source,
  }: {
    source: ValidateUserInfoSource;
  }): Promise<ValidateUserInfoResult | undefined> => {
    if (source.action !== "create-user" || source.method !== "oauth") return;
    if (source.oauth?.providerId !== "agentid") return;
    const profile = source.oauth.profile ?? {};
    const agentSub = typeof profile.sub === "string" ? profile.sub : "";
    const ownerSub = typeof profile.owner_sub === "string" ? profile.owner_sub.trim() : "";
    if (!agentSub || !ownerSub) return { error: AGENTID_OWNER_MISSING };
    if (!(await reserve(ownerSub, agentSub))) return { error: AGENTID_OWNER_LIMIT_REACHED };
  };
}
