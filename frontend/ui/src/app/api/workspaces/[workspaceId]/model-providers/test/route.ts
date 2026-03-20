import { NextRequest } from "next/server";
import { z } from "zod";
import { Role, LLMAdapter, ADAPTER_DEFAULT_BASE_URL, prisma, decryptKey } from "@traceroot/core";
import {
  requireAuth,
  requireWorkspaceMembership,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";

const ADAPTER_VALUES = [
  LLMAdapter.OPENAI,
  LLMAdapter.ANTHROPIC,
  LLMAdapter.AZURE,
  LLMAdapter.GOOGLE,
  LLMAdapter.AMAZON_BEDROCK,
  LLMAdapter.DEEPSEEK,
  LLMAdapter.OPENROUTER,
  LLMAdapter.XAI,
  LLMAdapter.MOONSHOT,
  LLMAdapter.ZAI,
] as const;

const testSchema = z.object({
  adapter: z.enum(ADAPTER_VALUES),
  apiKey: z.string().optional(),
  providerId: z.string().optional(), // use stored key from DB
  baseUrl: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  // Bedrock-specific
  awsAccessKeyId: z.string().optional(),
  awsSecretAccessKey: z.string().optional(),
  awsRegion: z.string().optional(),
  useDefaultCredentials: z.boolean().optional(),
});

type RouteParams = { params: Promise<{ workspaceId: string }> };

// POST /api/workspaces/[workspaceId]/model-providers/test
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { workspaceId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;

  const membershipResult = await requireWorkspaceMembership(
    authResult.user.id,
    workspaceId,
    Role.ADMIN,
  );
  if (membershipResult.error) return membershipResult.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  const result = testSchema.safeParse(body);
  if (!result.success) {
    return errorResponse(result.error.issues[0].message, 400);
  }

  const { adapter, baseUrl, awsAccessKeyId, awsSecretAccessKey, useDefaultCredentials } =
    result.data;

  // Resolve API key: use provided key, or fetch from DB via providerId
  let apiKey = result.data.apiKey;
  if (!apiKey && result.data.providerId) {
    const provider = await prisma.modelProvider.findFirst({
      where: { id: result.data.providerId, workspaceId },
      select: { keyCipher: true },
    });
    if (provider?.keyCipher) {
      apiKey = decryptKey(provider.keyCipher);
    }
  }

  try {
    switch (adapter) {
      case "openai": {
        const url = baseUrl
          ? `${baseUrl.replace(/\/$/, "")}/v1/models`
          : "https://api.openai.com/v1/models";
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return successResponse({
            success: false,
            error: (err as Record<string, Record<string, unknown>>).error?.message
              ? String((err as Record<string, Record<string, unknown>>).error.message)
              : `HTTP ${res.status}`,
          });
        }
        break;
      }

      case "anthropic": {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey || "",
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5",
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          }),
        });
        if (!res.ok && res.status === 401) {
          const err = await res.json().catch(() => ({}));
          const errObj = err as Record<string, Record<string, unknown>>;
          return successResponse({
            success: false,
            error: errObj.error?.message ? String(errObj.error.message) : "Invalid API key",
          });
        }
        break;
      }

      case "google": {
        const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
          headers: { "x-goog-api-key": apiKey || "" },
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return successResponse({
            success: false,
            error: (err as Record<string, unknown>).error
              ? String(
                  (err as Record<string, Record<string, unknown>>).error?.message ||
                    `HTTP ${res.status}`,
                )
              : `HTTP ${res.status}`,
          });
        }
        break;
      }

      case "azure": {
        if (!baseUrl) {
          return successResponse({
            success: false,
            error: "Base URL is required for Azure OpenAI",
          });
        }
        const apiVersion = "2024-06-01";
        const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models?api-version=${apiVersion}`, {
          headers: { "api-key": apiKey || "" },
        });
        if (!res.ok) {
          return successResponse({
            success: false,
            error: `HTTP ${res.status}: ${res.statusText}`,
          });
        }
        break;
      }

      case "amazon-bedrock": {
        // For Bedrock, validate credential format
        if (useDefaultCredentials) {
          // Cannot fully validate server-side without AWS SDK; accept as valid format
          break;
        }
        if (!awsAccessKeyId || !awsSecretAccessKey) {
          return successResponse({
            success: false,
            error: "AWS Access Key ID and Secret Access Key are required",
          });
        }
        if (!awsAccessKeyId.startsWith("AKIA") && !awsAccessKeyId.startsWith("ASIA")) {
          return successResponse({
            success: false,
            error: "Invalid AWS Access Key ID format",
          });
        }
        break;
      }

      case "deepseek": {
        const deepseekBase = baseUrl || ADAPTER_DEFAULT_BASE_URL.deepseek;
        const res = await fetch(`${deepseekBase.replace(/\/$/, "")}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return successResponse({
            success: false,
            error: (err as Record<string, Record<string, unknown>>).error?.message
              ? String((err as Record<string, Record<string, unknown>>).error.message)
              : `HTTP ${res.status}`,
          });
        }
        break;
      }

      case "openrouter": {
        const res = await fetch("https://openrouter.ai/api/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) {
          return successResponse({
            success: false,
            error: `HTTP ${res.status}: ${res.statusText}`,
          });
        }
        break;
      }

      case "xai": {
        const xaiBase = baseUrl || ADAPTER_DEFAULT_BASE_URL.xai;
        const res = await fetch(`${xaiBase.replace(/\/$/, "")}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return successResponse({
            success: false,
            error: (err as Record<string, Record<string, unknown>>).error?.message
              ? String((err as Record<string, Record<string, unknown>>).error.message)
              : `HTTP ${res.status}`,
          });
        }
        break;
      }

      case "moonshot": {
        const moonshotBase = baseUrl || ADAPTER_DEFAULT_BASE_URL.moonshot;
        const res = await fetch(`${moonshotBase.replace(/\/$/, "")}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return successResponse({
            success: false,
            error: (err as Record<string, Record<string, unknown>>).error?.message
              ? String((err as Record<string, Record<string, unknown>>).error.message)
              : `HTTP ${res.status}`,
          });
        }
        break;
      }

      case "zai": {
        const zaiBase = baseUrl || ADAPTER_DEFAULT_BASE_URL.zai;
        const res = await fetch(`${zaiBase.replace(/\/$/, "")}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return successResponse({
            success: false,
            error: (err as Record<string, Record<string, unknown>>).error?.message
              ? String((err as Record<string, Record<string, unknown>>).error.message)
              : `HTTP ${res.status}`,
          });
        }
        break;
      }
    }

    return successResponse({ success: true });
  } catch (err) {
    return successResponse({
      success: false,
      error: err instanceof Error ? err.message : "Connection failed",
    });
  }
}
