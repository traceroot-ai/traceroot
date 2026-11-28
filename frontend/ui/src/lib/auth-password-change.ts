import { createAuthMiddleware, getAuthoritativeSessionFromCtx, isAPIError } from "better-auth/api";
import type { GenericEndpointContext } from "@better-auth/core";
import { prisma } from "@traceroot/core";

export async function revokeSessionsOnPasswordChange(ctx: GenericEndpointContext) {
  if (ctx.path !== "/change-password") return;

  // The server owns this policy, including requests that explicitly pass false.
  ctx.body = { ...ctx.body, revokeOtherSessions: true };
  const session = await getAuthoritativeSessionFromCtx(ctx);
  if (!session) return { context: { body: ctx.body } };

  // A pre-change snapshot, not a claim about concurrent SQL deletion counts.
  const context = ctx.context as typeof ctx.context & { otherSessionsBeforeChange?: number };
  context.otherSessionsBeforeChange = await prisma.session.count({
    where: {
      userId: session.user.id,
      id: { not: session.session.id },
      expiresAt: { gt: new Date() },
    },
  });
  return { context: { body: ctx.body } };
}

export const reportPasswordChangeSessions = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/change-password" || isAPIError(ctx.context.returned)) return;
  return ctx.json({
    ...(ctx.context.returned as Record<string, unknown>),
    otherSessionsBeforeChange: (ctx.context as { otherSessionsBeforeChange?: number })
      .otherSessionsBeforeChange,
  });
});
