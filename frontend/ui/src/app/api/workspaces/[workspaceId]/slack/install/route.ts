import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireWorkspaceMembership } from "@/lib/auth-helpers";
import { installer, SLACK_BOT_SCOPES } from "@traceroot/slack";
import { hasEntitlement, prisma, type PlanType } from "@traceroot/core";
import { env } from "@/env";
import { slackResultUrl, slackReturnPath } from "@/lib/slack-return";

const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

async function handleGET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  const { workspaceId } = await params;
  const memberCheck = await requireWorkspaceMembership(auth.user.id, workspaceId, "ADMIN");
  if (memberCheck.error) return memberCheck.error;

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { billingPlan: true },
  });
  const plan = (workspace?.billingPlan ?? "free") as PlanType;
  if (!hasEntitlement(plan, "slack-integration")) {
    const upgradeUrl = new URL(`/workspaces/${workspaceId}/settings/billing`, APP_BASE_URL);
    upgradeUrl.searchParams.set("upgrade", "slack-integration");
    return NextResponse.redirect(upgradeUrl);
  }

  // Where the authorization comes back to: the page it was started from, kept
  // only when it is a path on this site.
  const url = new URL(request.url);
  const returnTo = slackReturnPath(workspaceId, url.searchParams.get("returnTo"));

  // A deployment without the Slack app's settings cannot start an
  // authorization (the state is signed with SLACK_STATE_SECRET). Back to the
  // starting page with the reason, rather than an error page.
  if (!env.SLACK_CLIENT_ID || !env.SLACK_STATE_SECRET) {
    console.error("[slack] install: SLACK_CLIENT_ID or SLACK_STATE_SECRET is not set");
    return NextResponse.redirect(
      slackResultUrl(returnTo, { connected: false, reason: "not_configured" }, APP_BASE_URL),
    );
  }

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
export const GET = withImpersonationPolicy(handleGET);
