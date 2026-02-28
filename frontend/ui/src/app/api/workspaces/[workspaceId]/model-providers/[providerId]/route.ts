import { NextRequest } from "next/server";
import { z } from "zod";
import {
  prisma,
  Role,
  encryptKey,
  maskKey,
  BEDROCK_USE_DEFAULT_CREDENTIALS,
} from "@traceroot/core";
import {
  requireAuth,
  requireWorkspaceMembership,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";

const updateSchema = z.object({
  provider: z.string().min(1).max(100).optional(), // rename label
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().url().nullable().optional(),
  customModels: z.array(z.string().min(1)).optional(),
  withDefaultModels: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  // Bedrock-specific
  awsAccessKeyId: z.string().optional(),
  awsSecretAccessKey: z.string().optional(),
  awsRegion: z.string().optional(),
  useDefaultCredentials: z.boolean().optional(),
});

type RouteParams = {
  params: Promise<{ workspaceId: string; providerId: string }>;
};

// PATCH /api/workspaces/[workspaceId]/model-providers/[providerId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { workspaceId, providerId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;

  const membershipResult = await requireWorkspaceMembership(
    authResult.user.id,
    workspaceId,
    Role.ADMIN,
  );
  if (membershipResult.error) return membershipResult.error;

  const existing = await prisma.modelProvider.findFirst({
    where: { id: providerId, workspaceId },
  });
  if (!existing) {
    return errorResponse("Model provider not found", 404);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  const result = updateSchema.safeParse(body);
  if (!result.success) {
    return errorResponse(result.error.issues[0].message, 400);
  }

  const {
    provider,
    apiKey,
    baseUrl,
    customModels,
    withDefaultModels,
    config,
    enabled,
    awsAccessKeyId,
    awsSecretAccessKey,
    awsRegion,
    useDefaultCredentials,
  } = result.data;

  const data: Record<string, unknown> = {};
  if (provider !== undefined) data.provider = provider;
  if (baseUrl !== undefined) data.baseUrl = baseUrl;
  if (customModels !== undefined) data.customModels = customModels;
  if (withDefaultModels !== undefined) data.withDefaultModels = withDefaultModels;
  if (config !== undefined) data.config = config;
  if (enabled !== undefined) data.enabled = enabled;

  // Handle credential updates
  if (existing.adapter === "amazon-bedrock") {
    if (useDefaultCredentials) {
      data.keyCipher = encryptKey(BEDROCK_USE_DEFAULT_CREDENTIALS);
      data.keyPreview = "Default AWS credentials";
    } else if (awsAccessKeyId && awsSecretAccessKey) {
      const creds = JSON.stringify({ awsAccessKeyId, awsSecretAccessKey });
      data.keyCipher = encryptKey(creds);
      data.keyPreview = maskKey(awsAccessKeyId);
    }
    if (awsRegion) {
      const existingConfig = (existing.config as Record<string, unknown>) || {};
      data.config = { ...existingConfig, awsRegion };
    }
  } else if (apiKey) {
    data.keyCipher = encryptKey(apiKey);
    data.keyPreview = maskKey(apiKey);
  }

  const updated = await prisma.modelProvider.update({
    where: { id: providerId },
    data,
    select: {
      id: true,
      adapter: true,
      provider: true,
      keyPreview: true,
      baseUrl: true,
      customModels: true,
      withDefaultModels: true,
      config: true,
      enabled: true,
      createdBy: true,
      createTime: true,
      updateTime: true,
    },
  });

  return successResponse(updated);
}

// DELETE /api/workspaces/[workspaceId]/model-providers/[providerId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { workspaceId, providerId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;

  const membershipResult = await requireWorkspaceMembership(
    authResult.user.id,
    workspaceId,
    Role.ADMIN,
  );
  if (membershipResult.error) return membershipResult.error;

  const existing = await prisma.modelProvider.findFirst({
    where: { id: providerId, workspaceId },
  });
  if (!existing) {
    return errorResponse("Model provider not found", 404);
  }

  await prisma.modelProvider.delete({ where: { id: providerId } });

  return successResponse({ deleted: true });
}
