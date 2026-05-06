import { NextRequest, NextResponse } from "next/server";
import { installer, SlackOAuthResponseSchema } from "@traceroot/slack";
import { env } from "@/env";

interface InstallMetadata {
  workspaceId?: string;
  connectedByUserId?: string;
  returnTo?: string;
}

function parseMeta(raw: string | undefined | null): InstallMetadata {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as InstallMetadata;
  } catch {
    return {};
  }
}

function destination(workspaceId: string | undefined, params: string, requestUrl: string): URL {
  const path = workspaceId
    ? `/workspaces/${workspaceId}/settings/integrations?${params}`
    : `/?${params}`;
  return new URL(path, requestUrl);
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return NextResponse.redirect(
      destination(undefined, "slack=error&reason=missing_params", request.url),
    );
  }

  // 1. Verify the state param (signed via SLACK_STATE_SECRET) and recover metadata.
  let meta: InstallMetadata;
  try {
    // stateStore is a public property on InstallProvider (StateStore | undefined)
    const verified = await installer.stateStore!.verifyStateParam(new Date(), state);
    meta = parseMeta(verified.metadata);
  } catch {
    return NextResponse.redirect(
      destination(undefined, "slack=error&reason=invalid_state", request.url),
    );
  }

  // 2. Exchange the code for a bot token.
  const basic = Buffer.from(`${env.SLACK_CLIENT_ID}:${env.SLACK_CLIENT_SECRET}`).toString("base64");
  const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({ code, redirect_uri: env.SLACK_REDIRECT_URI }),
  });
  const parsed = SlackOAuthResponseSchema.safeParse(await tokenRes.json());
  if (!parsed.success) {
    return NextResponse.redirect(
      destination(meta.workspaceId, "slack=error&reason=exchange_failed", request.url),
    );
  }
  const data = parsed.data;

  // 3. Persist via installationStore (encrypts the bot token).
  // Wrapped in try/catch — Prisma upserts and AES encryption can both throw,
  // and we want a clean redirect rather than a raw 500 mid-OAuth flow.
  try {
    await installer.installationStore.storeInstallation({
      team: { id: data.team.id, name: data.team.name },
      bot: {
        token: data.access_token,
        userId: data.bot_user_id ?? "",
        scopes: (data.scope ?? "").split(",").filter(Boolean),
        id: data.app_id ?? "",
      },
      enterprise: undefined,
      user: { token: undefined, id: data.authed_user?.id ?? "", scopes: undefined },
      tokenType: "bot",
      metadata: JSON.stringify(meta),
      appId: data.app_id,
    } as never);
  } catch {
    return NextResponse.redirect(
      destination(meta.workspaceId, "slack=error&reason=store_failed", request.url),
    );
  }

  return NextResponse.redirect(destination(meta.workspaceId, "slack=connected", request.url));
}
