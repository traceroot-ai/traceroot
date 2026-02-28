import { NextRequest } from "next/server";
import { z } from "zod";
import {
  prisma,
  Role,
  encryptKey,
  maskKey,
  hasEntitlement,
  type PlanType,
  LlmAdapter,
  BEDROCK_USE_DEFAULT_CREDENTIALS,
} from "@traceroot/core";
import {
  requireAuth,
  requireWorkspaceMembership,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";

const ADAPTER_VALUES = [
  LlmAdapter.OPENAI,
  LlmAdapter.ANTHROPIC,
  LlmAdapter.AZURE,
  LlmAdapter.GOOGLE,
  LlmAdapter.AMAZON_BEDROCK,
  LlmAdapter.DEEPSEEK,
  LlmAdapter.OPENROUTER,
] as const;

const createSchema = z.object({
  adapter: z.enum(ADAPTER_VALUES),
  provider: z.string().min(1).max(100), // user-defined label
  apiKey: z.string().optional(), // not required for bedrock with default creds
  baseUrl: z.string().url().optional(),
  customModels: z.array(z.string().min(1)).default([]),
  withDefaultModels: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  // Bedrock-specific
  awsAccessKeyId: z.string().optional(),
  awsSecretAccessKey: z.string().optional(),
  awsRegion: z.string().optional(),
  useDefaultCredentials: z.boolean().optional(),
});

type RouteParams = { params: Promise<{ workspaceId: string }> };

// GET /api/workspaces/[workspaceId]/model-providers
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { workspaceId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;

  const membershipResult = await requireWorkspaceMembership(authResult.user.id, workspaceId);
  if (membershipResult.error) return membershipResult.error;

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { billingPlan: true },
  });

  const byokEnabled = workspace ? hasEntitlement(workspace.billingPlan as PlanType, "byok") : false;

  const providers = await prisma.modelProvider.findMany({
    where: { workspaceId },
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
    orderBy: { createTime: "asc" },
  });

  return successResponse({ providers, byokEnabled });
}

// POST /api/workspaces/[workspaceId]/model-providers
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { workspaceId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const membershipResult = await requireWorkspaceMembership(user.id, workspaceId, Role.ADMIN);
  if (membershipResult.error) return membershipResult.error;

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { billingPlan: true },
  });
  if (!workspace || !hasEntitlement(workspace.billingPlan as PlanType, "byok")) {
    return errorResponse("BYOK is not available on your current plan", 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  const result = createSchema.safeParse(body);
  if (!result.success) {
    return errorResponse(result.error.issues[0].message, 400);
  }

  const {
    adapter,
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

  // Determine the credential to encrypt
  let credentialToEncrypt: string;
  let credentialPreview: string;

  if (adapter === "amazon-bedrock") {
    if (useDefaultCredentials) {
      credentialToEncrypt = BEDROCK_USE_DEFAULT_CREDENTIALS;
      credentialPreview = "Default AWS credentials";
    } else if (awsAccessKeyId && awsSecretAccessKey) {
      const creds = JSON.stringify({ awsAccessKeyId, awsSecretAccessKey });
      credentialToEncrypt = creds;
      credentialPreview = maskKey(awsAccessKeyId);
    } else {
      return errorResponse("AWS credentials or default credentials option required", 400);
    }
  } else {
    if (!apiKey) {
      return errorResponse("API key is required", 400);
    }
    credentialToEncrypt = apiKey;
    credentialPreview = maskKey(apiKey);
  }

  const keyCipher = encryptKey(credentialToEncrypt);

  // Build config with adapter-specific fields
  const providerConfig: Record<string, unknown> = { ...(config || {}) };
  if (awsRegion) {
    providerConfig.awsRegion = awsRegion;
  }

  const modelProvider = await prisma.modelProvider.upsert({
    where: {
      workspaceId_provider: { workspaceId, provider },
    },
    create: {
      workspaceId,
      adapter,
      provider,
      keyCipher,
      keyPreview: credentialPreview,
      baseUrl: baseUrl || null,
      customModels,
      withDefaultModels,
      config: Object.keys(providerConfig).length > 0 ? (providerConfig as object) : undefined,
      enabled: enabled ?? true,
      createdBy: user.id,
    },
    update: {
      adapter,
      keyCipher,
      keyPreview: credentialPreview,
      baseUrl: baseUrl || null,
      customModels,
      withDefaultModels,
      config: Object.keys(providerConfig).length > 0 ? (providerConfig as object) : undefined,
      enabled: enabled ?? true,
    },
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

  return successResponse(modelProvider, 201);
}
