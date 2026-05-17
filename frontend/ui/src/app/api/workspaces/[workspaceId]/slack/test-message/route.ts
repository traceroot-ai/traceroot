import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireWorkspaceMembership } from "@/lib/auth-helpers";
import { prisma } from "@traceroot/core";
import { getClientForTeam } from "@traceroot/slack";
import { env } from "@/env";

const APP_BASE_URL = env.NEXT_PUBLIC_APP_URL;

function mapSlackError(code: string): string {
  switch (code) {
    case "channel_not_found":
      return "Channel not found. Make sure the channel ID is correct.";
    case "not_in_channel":
      return "TraceRoot is not in this channel. Invite the app with `/invite @TraceRoot` in the channel and try again.";
    case "is_archived":
      return "This channel is archived. Pick an active channel.";
    case "invalid_auth":
    case "token_revoked":
    case "account_inactive":
      return "Slack authorization is invalid. Please disconnect and reconnect Slack.";
    default:
      return `Slack API error: ${code}`;
  }
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const { workspaceId } = await params;
  const member = await requireWorkspaceMembership(auth.user.id, workspaceId, "ADMIN");
  if (member.error) return member.error;

  const integration = await prisma.slackIntegration.findUnique({
    where: { workspaceId },
    select: { teamId: true, teamName: true, channelId: true, channelName: true },
  });
  if (!integration) {
    return NextResponse.json({ error: "not_connected" }, { status: 404 });
  }

  const channelId = integration.channelId;
  if (!channelId) {
    return NextResponse.json({ error: "no_channel_set" }, { status: 400 });
  }

  const channelName = integration.channelName ?? channelId;
  const teamName = integration.teamName;
  const userEmail = auth.user.email ?? auth.user.id;

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "🎉 Test Message from TraceRoot", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Hello from TraceRoot! This is a test message to verify your Slack integration is working properly.",
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Workspace:*\n${teamName}` },
        { type: "mrkdwn", text: `*Channel:*\n#${channelName}` },
        { type: "mrkdwn", text: `*Sent by:*\n${userEmail}` },
        { type: "mrkdwn", text: `*Time:*\n${new Date().toISOString()}` },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open TraceRoot" },
          url: `${APP_BASE_URL}/workspaces/${workspaceId}/settings/integrations`,
          style: "primary",
        },
      ],
    },
  ];

  let result: { ts?: string; channel?: string };
  try {
    const client = await getClientForTeam(integration.teamId);
    const res = await client.chat.postMessage({
      channel: channelId,
      blocks: blocks as any,
      text: "Test message from TraceRoot",
      unfurl_links: false,
      unfurl_media: false,
    });
    result = { ts: res.ts, channel: res.channel };
  } catch (err: any) {
    const code: string = err?.data?.error ?? err?.message ?? "unknown_error";
    const message = mapSlackError(code);
    return NextResponse.json({ ok: false, error: code, message }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    ts: result.ts,
    channel: { id: channelId, name: channelName },
  });
}
