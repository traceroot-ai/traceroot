import { prisma, Role, escapeHtml, renderEmailCard } from "@traceroot/core";
import { after } from "next/server";
import { env } from "@/env";
import { isSmtpConfigured, sendSmtpEmail } from "@/lib/email/transport";
import { writeAudit } from "@/lib/write-services/audit";

export interface MembershipChange {
  actorUserId: string;
  workspaceId: string;
  membershipId: string;
  userId: string;
  role: Role;
  previousRole?: Role;
  operation: "joined" | "role_changed" | "removed";
}

// Audit after commit; deliver mail after the response, as with password reset email.
export async function notifyMembershipChange(change: MembershipChange): Promise<void> {
  await writeAudit(prisma, {
    actorUserId: change.actorUserId,
    operation: `workspace_member_${change.operation}`,
    resourceType: "workspace_member",
    resourceId: change.membershipId,
    workspaceId: change.workspaceId,
    summary: {
      userId: change.userId,
      role: change.role,
      ...(change.previousRole ? { previousRole: change.previousRole } : {}),
    },
    transport: "ui",
  });

  if (!isSmtpConfigured()) {
    console.warn("[membership] SMTP not configured", {
      workspaceId: change.workspaceId,
      membershipId: change.membershipId,
    });
    return;
  }

  after(async () => {
    try {
      const [workspace, target, admins] = await Promise.all([
        prisma.workspace.findUnique({ where: { id: change.workspaceId }, select: { name: true } }),
        prisma.user.findUnique({ where: { id: change.userId }, select: { id: true, email: true } }),
        prisma.workspaceMember.findMany({
          where: { workspaceId: change.workspaceId, role: Role.ADMIN },
          select: { user: { select: { id: true, email: true } } },
        }),
      ]);
      if (!workspace || !target) throw new Error("Workspace or target account no longer exists");

      const recipients = new Map<string, { id: string; email: string }>();
      for (const user of [target, ...admins.map((member) => member.user)]) {
        const key = user.email.toLowerCase();
        if (!recipients.has(key)) recipients.set(key, user);
      }
      const description =
        change.operation === "joined"
          ? `Joined as ${change.role}`
          : change.operation === "removed"
            ? "Removed from the workspace"
            : change.previousRole
              ? `Role changed from ${change.previousRole} to ${change.role}`
              : `Role changed to ${change.role}`;
      const text = `Workspace: ${workspace.name}\nAccount: ${target.email}\nChange: ${description}`;
      const html = renderEmailCard({
        title: "Workspace membership changed",
        bodyHtml: `<tr><td style="padding: 0 40px 32px;"><p>Workspace: ${escapeHtml(workspace.name)}</p><p>Account: ${escapeHtml(target.email)}</p><p>${escapeHtml(description)}</p></td></tr>`,
        buttonLabel: "Review workspaces",
        buttonUrl: `${env.BETTER_AUTH_URL}/workspaces`,
        footerText: "Review membership changes with your workspace administrator.",
      });
      await Promise.all(
        [...recipients.values()].map(async (recipient) => {
          try {
            await sendSmtpEmail({
              to: recipient.email,
              subject: "Workspace membership changed on traceroot",
              text,
              html,
            });
          } catch (error) {
            console.error("[membership] notification failed", {
              workspaceId: change.workspaceId,
              membershipId: change.membershipId,
              recipientUserId: recipient.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      );
    } catch (error) {
      console.error("[membership] notification lookup failed", {
        workspaceId: change.workspaceId,
        membershipId: change.membershipId,
        userId: change.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
