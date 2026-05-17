import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireWorkspaceMembership } from "@/lib/auth-helpers";
import { prisma } from "@traceroot/core";
import { getClientForTeam, WebClient } from "@traceroot/slack";

const FETCH_LIMIT = 5000;
const PAGE_SIZE = 1000;

interface ChannelDTO {
  id: string;
  name: string;
  isPrivate: boolean;
}

async function listChannels(
  client: WebClient,
  types: string,
  limit: number,
): Promise<ChannelDTO[]> {
  const out: ChannelDTO[] = [];
  let cursor: string | undefined;
  while (out.length < limit) {
    const page = await client.conversations.list({
      exclude_archived: true,
      types,
      limit: PAGE_SIZE,
      cursor,
    });
    for (const ch of page.channels ?? []) {
      out.push({ id: ch.id ?? "", name: ch.name ?? "", isPrivate: !!ch.is_private });
      if (out.length >= limit) break;
    }
    cursor = page.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return out;
}

function isMissingScope(err: unknown): boolean {
  return (err as { data?: { error?: string } } | undefined)?.data?.error === "missing_scope";
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const { workspaceId } = await params;
  const member = await requireWorkspaceMembership(auth.user.id, workspaceId, "ADMIN");
  if (member.error) return member.error;

  const integration = await prisma.slackIntegration.findUnique({
    where: { workspaceId },
    select: { teamId: true },
  });
  if (!integration) return NextResponse.json({ error: "not_connected" }, { status: 404 });

  const client = await getClientForTeam(integration.teamId);
  let channels: ChannelDTO[];
  let hasPrivateChannelAccess = true;
  try {
    channels = await listChannels(client, "public_channel,private_channel", FETCH_LIMIT);
  } catch (err) {
    if (!isMissingScope(err)) throw err;
    hasPrivateChannelAccess = false;
    channels = await listChannels(client, "public_channel", FETCH_LIMIT);
  }
  return NextResponse.json({ channels, hasPrivateChannelAccess });
}
