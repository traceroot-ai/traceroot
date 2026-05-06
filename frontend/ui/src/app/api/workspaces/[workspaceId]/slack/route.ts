import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireWorkspaceMembership, type Role } from "@/lib/auth-helpers";
import { prisma } from "@traceroot/core";

type RouteParams = { params: Promise<{ workspaceId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  const { workspaceId } = await params;
  const member = await requireWorkspaceMembership(auth.user.id, workspaceId, "MEMBER" as Role);
  if (member.error) return member.error;

  const row = await prisma.slackIntegration.findUnique({
    where: { workspaceId },
    select: { teamName: true, botUserId: true, channelId: true, channelName: true },
  });
  if (!row) return NextResponse.json({ connected: false });

  return NextResponse.json({
    connected: true,
    teamName: row.teamName,
    botUserId: row.botUserId,
    channel: row.channelId ? { id: row.channelId, name: row.channelName ?? row.channelId } : null,
  });
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  const { workspaceId } = await params;
  const member = await requireWorkspaceMembership(auth.user.id, workspaceId, "ADMIN" as Role);
  if (member.error) return member.error;

  // deleteMany is a no-op when no matching row exists (idempotent disconnect)
  // and lets real DB errors propagate as 500 instead of being silently swallowed.
  await prisma.slackIntegration.deleteMany({ where: { workspaceId } });
  return NextResponse.json({ ok: true });
}
