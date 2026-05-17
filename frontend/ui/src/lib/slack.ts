export interface SlackStatus {
  connected: boolean;
  teamName?: string;
  botUserId?: string;
  channel?: { id: string; name: string } | null;
}

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
}

export interface SlackChannelsResponse {
  channels: SlackChannel[];
  hasPrivateChannelAccess: boolean;
}

export async function fetchSlackConnection(workspaceId: string): Promise<SlackStatus> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/slack`);
  if (!res.ok) throw new Error("failed to fetch slack status");
  return res.json();
}

export async function fetchSlackChannels(workspaceId: string): Promise<SlackChannelsResponse> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/slack/channels`);
  if (!res.ok) throw new Error("failed to fetch slack channels");
  return res.json();
}

export async function saveSlackChannel(
  workspaceId: string,
  channelId: string,
  channelName: string,
): Promise<void> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/slack/channel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channelId, channelName }),
  });
  if (!res.ok) throw new Error("failed to save slack channel");
}

export async function disconnectSlack(workspaceId: string): Promise<void> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/slack`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("failed to disconnect slack");
}

export interface SlackTestMessageResponse {
  ok: boolean;
  ts?: string;
  channel?: { id: string; name: string };
  error?: string;
  message?: string;
}

export async function sendSlackTestMessage(workspaceId: string): Promise<SlackTestMessageResponse> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/slack/test-message`, {
    method: "POST",
  });
  // Always parse the body — both success and error responses are JSON
  const body: SlackTestMessageResponse = await res.json();
  if (!res.ok) {
    // Throw a typed error so onError handler can show the user-readable `message`
    const err = new Error(body.message ?? "Failed to send test message") as Error & {
      code?: string;
    };
    err.code = body.error;
    throw err;
  }
  return body;
}
