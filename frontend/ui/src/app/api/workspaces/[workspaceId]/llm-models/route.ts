import { NextRequest } from "next/server";
import { prisma, SYSTEM_MODELS, DEFAULT_MODELS } from "@traceroot/core";
import {
  requireAuth,
  requireWorkspaceMembership,
  successResponse,
} from "@/lib/auth-helpers";

type RouteParams = { params: Promise<{ workspaceId: string }> };

// GET /api/workspaces/[workspaceId]/llm-models
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { workspaceId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;

  const membershipResult = await requireWorkspaceMembership(authResult.user.id, workspaceId);
  if (membershipResult.error) return membershipResult.error;

  // System models: include entries where env var is set
  const systemModels = SYSTEM_MODELS.filter((s) => !!process.env[s.envVar]).map((s) => ({
    provider: s.provider,
    source: "system" as const,
    models: s.models,
  }));

  // BYOK providers: fetch from DB, merge default + custom models
  const dbProviders = await prisma.modelProvider.findMany({
    where: { workspaceId, enabled: true },
    select: {
      adapter: true,
      provider: true,
      customModels: true,
      withDefaultModels: true,
    },
  });

  const byokProviders = dbProviders.map((p) => {
    const defaultModels = p.withDefaultModels
      ? (DEFAULT_MODELS[p.adapter] || [])
      : [];
    const customModels = (p.customModels || []).map((id) => ({
      id,
      label: id,
    }));
    // Merge defaults + custom, deduplicate by ID
    const allModels = [...defaultModels];
    for (const cm of customModels) {
      if (!allModels.some((m) => m.id === cm.id)) {
        allModels.push(cm);
      }
    }
    return {
      provider: p.provider,
      adapter: p.adapter,
      source: "byok" as const,
      models: allModels,
    };
  });

  return successResponse({ systemModels, byokProviders });
}
