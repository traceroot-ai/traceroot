import { prisma } from "@traceroot/core";
import { requireAuth, successResponse } from "@/lib/auth-helpers";

// GET /api/github/status - Check GitHub connection status for current user
// Only returns connected:true if both OAuth AND app installation are complete
export async function GET() {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const connection = await prisma.gitHubConnection.findUnique({
    where: { userId: user.id },
    select: { githubUsername: true, installationId: true },
  });

  if (!connection) {
    return successResponse({ connected: false });
  }

  return successResponse({
    connected: true,
    username: connection.githubUsername,
    installationId: connection.installationId,
  });
}
