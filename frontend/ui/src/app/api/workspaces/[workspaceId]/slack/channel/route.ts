import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireWorkspaceMembership } from "@/lib/auth-helpers";
import { prisma } from "@traceroot/core";
import { getClientForTeam } from "@traceroot/slack";
import { z } from "zod";

const Body = z.object({
  channelId: z.string().min(1),
  channelName: z.string().min(1),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const { workspaceId } = await params;
  const member = await requireWorkspaceMembership(auth.user.id, workspaceId, "ADMIN");
  if (member.error) return member.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  let { channelId, channelName } = parsed.data;

  // Guard both branches: plain-id update would throw P2025 if row is missing.
  const exists = await prisma.slackIntegration.findUnique({
    where: { workspaceId },
    select: { teamId: true },
  });
  if (!exists) return NextResponse.json({ error: "not_connected" }, { status: 404 });

  // Manual `#name` entry — resolve to a real channel id via conversations.info.
  if (channelId.startsWith("#")) {
    const client = await getClientForTeam(exists.teamId);
    const info = await client.conversations.info({ channel: channelId });
    if (!info.ok || !info.channel) {
      return NextResponse.json({ error: "channel_not_found" }, { status: 404 });
    }
    channelId = info.channel.id!;
    channelName = info.channel.name ?? channelName;
  }

  await prisma.slackIntegration.update({
    where: { workspaceId },
    data: { channelId, channelName },
  });
  return NextResponse.json({ ok: true, channel: { id: channelId, name: channelName } });
}
