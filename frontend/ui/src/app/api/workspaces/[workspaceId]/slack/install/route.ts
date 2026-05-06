import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireWorkspaceMembership } from "@/lib/auth-helpers";
import { installer, SLACK_BOT_SCOPES } from "@traceroot/slack";
import { env } from "@/env";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  const { workspaceId } = await params;
  const memberCheck = await requireWorkspaceMembership(auth.user.id, workspaceId, "ADMIN");
  if (memberCheck.error) return memberCheck.error;

  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") || "/";

  // Use the SDK's URL builder (which signs state via SLACK_STATE_SECRET)
  // and redirect with NextResponse — bypassing the SDK's HTTP plumbing,
  // which is incompatible with Next.js App Router.
  const installUrl = await installer.generateInstallUrl(
    {
      scopes: [...SLACK_BOT_SCOPES],
      redirectUri: env.SLACK_REDIRECT_URI,
      metadata: JSON.stringify({
        workspaceId,
        connectedByUserId: auth.user.id,
        returnTo,
      }),
    },
    true, // stateVerification
  );

  return NextResponse.redirect(installUrl);
}
