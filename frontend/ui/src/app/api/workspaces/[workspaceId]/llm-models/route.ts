import { NextRequest } from "next/server";
import { prisma, SYSTEM_MODELS } from "@traceroot/core";
import { requireAuth, requireWorkspaceMembership, successResponse } from "@/lib/auth-helpers";

type RouteParams = { params: Promise<{ workspaceId: string }> };

// GET /api/workspaces/[workspaceId]/llm-models
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { workspaceId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;

  const membershipResult = await requireWorkspaceMembership(authResult.user.id, workspaceId);
  if (membershipResult.error) return membershipResult.error;

  // System models: include entries where env var is set
  console.log("[llm-models] Env check:", SYSTEM_MODELS.map((s) => `${s.envVar}=${!!process.env[s.envVar]}`).join(", "));
  const systemModels = SYSTEM_MODELS.filter((s) => !!process.env[s.envVar]).map((s) => ({
    provider: s.provider,
    source: "system" as const,
    models: s.models,
  }));

  // BYOK providers: only user-configured custom models
  const dbProviders = await prisma.modelProvider.findMany({
    where: { workspaceId, enabled: true },
    select: {
      adapter: true,
      provider: true,
      customModels: true,
    },
  });

  const byokProviders = dbProviders.map((p) => ({
    provider: p.provider,
    adapter: p.adapter,
    source: "byok" as const,
    models: (p.customModels || []).map((id) => id.trim()).filter(Boolean).map((id) => ({ id, label: id })),
  }));

  return successResponse({ systemModels, byokProviders });
}
