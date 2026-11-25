import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest, NextResponse } from "next/server";
import { installer, SlackOAuthResponseSchema } from "@traceroot/slack";
import { env } from "@/env";
import { slackResultUrl, slackReturnPath } from "@/lib/slack-return";

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

// Back to the page the installation was started from (its saved `returnTo`, kept
// only when it is a path on this site), or the workspace's integration settings,
// with the outcome in the query. Use BETTER_AUTH_URL as base — request.url inside
// Docker resolves to 0.0.0.0 (Next.js standalone with HOSTNAME=0.0.0.0), which
// loses the session cookie set on the user-facing host (localhost / prod domain).
// Mirrors the pattern in app/api/github/callback/route.ts.
function destination(
  meta: InstallMetadata,
  outcome: { connected: true } | { connected: false; reason: string },
): URL {
  return slackResultUrl(
    slackReturnPath(meta.workspaceId, meta.returnTo),
    outcome,
    env.BETTER_AUTH_URL,
  );
}

const failed = (reason: string) => ({ connected: false as const, reason });

/** Recovers the metadata the install route signed into `state`, or null when it does not verify. */
async function verifiedMeta(state: string): Promise<InstallMetadata | null> {
  try {
    // stateStore is a public property on InstallProvider (StateStore | undefined)
    const verified = await installer.stateStore!.verifyStateParam(new Date(), state);
    return parseMeta(verified.metadata);
  } catch {
    return null;
  }
}

async function handleGET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  // Slack sends `error` (access_denied when the person cancels) instead of a code.
  const slackError = url.searchParams.get("error");

  if (!state || (!code && !slackError)) {
    return NextResponse.redirect(destination({}, failed("missing_params")));
  }

  // 1. Verify the state param (signed via SLACK_STATE_SECRET) and recover metadata,
  // which says where to go back to.
  const meta = await verifiedMeta(state);
  if (!meta) {
    return NextResponse.redirect(destination({}, failed("invalid_state")));
  }
  if (slackError || !code) {
    // Slack's own error code (access_denied when the person cancels), kept only
    // when it looks like one, since the page shows it.
    const reason = slackError && /^[a-z_]{1,40}$/.test(slackError) ? slackError : "slack_error";
    return NextResponse.redirect(destination(meta, failed(reason)));
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
    return NextResponse.redirect(destination(meta, failed("exchange_failed")));
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
    return NextResponse.redirect(destination(meta, failed("store_failed")));
  }

  return NextResponse.redirect(destination(meta, { connected: true }));
}
export const GET = withImpersonationPolicy(handleGET);
