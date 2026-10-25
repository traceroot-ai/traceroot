import { prisma } from "@traceroot/core";
import { isStaff } from "./policy";

export async function impersonationContext(session: {
  id: string;
  userId: string;
  impersonatedBy?: string | null;
  createdAt: Date;
  expiresAt: Date;
}) {
  if (!session.impersonatedBy) return null;
  const [actor, target, start] = await Promise.all([
    prisma.user.findUnique({
      where: { id: session.impersonatedBy },
      select: { id: true, email: true, role: true, banned: true },
    }),
    prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, email: true, role: true, banned: true },
    }),
    prisma.auditLog.findFirst({
      where: { impersonationSessionId: session.id, operation: "impersonation.started" },
    }),
  ]);
  // The live session owns expiry, just like ordinary login sessions. Audit
  // timestamps are snapshots, not an independent impersonation deadline.
  const expiresAt = new Date(session.expiresAt);
  const reason =
    !actor || !isStaff(actor.role) || actor.banned
      ? "revoked"
      : !target || target.banned || isStaff(target.role)
        ? "target_unavailable"
        : !start || start.endedAt
          ? "ended"
          : expiresAt.getTime() <= Date.now()
            ? "expired"
            : null;
  if (reason && start && !start.endedAt) {
    await prisma.auditLog.updateMany({
      where: { id: start.id, endedAt: null },
      data: { endedAt: reason === "expired" ? expiresAt : new Date(), endReason: reason },
    });
  }
  if (!reason && start && start.expiresAt?.getTime() !== expiresAt.getTime()) {
    await prisma.auditLog.updateMany({
      where: { id: start.id, endedAt: null },
      data: { expiresAt },
    });
  }
  return { actor, target, start, expiresAt, reason, valid: reason === null };
}
