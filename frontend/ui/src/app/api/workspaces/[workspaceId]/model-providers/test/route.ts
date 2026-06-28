import { NextRequest } from "next/server";
import { z } from "zod";
import { Role, LLMAdapter, ADAPTER_DEFAULT_BASE_URL, prisma, decryptKey } from "@traceroot/core";
import {
  requireAuth,
  requireWorkspaceMembership,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
// Connectivity checks must be bounded: a provider host — or a user-supplied
// baseUrl — that accepts the socket but never responds would otherwise leave
// this handler hanging. `withTimeout` keeps the deadline armed across the whole
// provider check (including any response-body reads the operation performs).
import { withTimeout } from "./timeout";

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
        const res = await withTimeout((signal) =>
          fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal }),
        );
        if (!res.ok) {
          return successResponse({
            success: false,
            error: `HTTP ${res.status}: ${res.statusText}`,
          });
        }
        break;
      }

      case "anthropic": {
        const res = await withTimeout((signal) =>
          fetch("https://api.anthropic.com/v1/messages", {
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
            signal,
          }),
        );
        if (!res.ok && res.status === 401) {
          return successResponse({ success: false, error: "Invalid API key" });
        }
        break;
      }

      case "google": {
        const res = await withTimeout((signal) =>
          fetch("https://generativelanguage.googleapis.com/v1beta/models", {
            headers: { "x-goog-api-key": apiKey || "" },
            signal,
          }),
        );
        if (!res.ok) {
          return successResponse({
            success: false,
            error: `HTTP ${res.status}: ${res.statusText}`,
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
        const res = await withTimeout((signal) =>
          fetch(`${baseUrl.replace(/\/$/, "")}/models?api-version=${apiVersion}`, {
            headers: { "api-key": apiKey || "" },
            signal,
          }),
        );
        if (!res.ok) {
          return successResponse({
            success: false,
            error: `HTTP ${res.status}: ${res.statusText}`,
          });
        }
        break;
      }

      case "amazon-bedrock": {
        // For Bedrock, validate credential format. No network request is made,
        // so this branch intentionally runs outside withTimeout.
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
        const res = await withTimeout((signal) =>
          fetch(`${deepseekBase.replace(/\/$/, "")}/models`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal,
          }),
        );
        if (!res.ok) {
          return successResponse({
            success: false,
            error: `HTTP ${res.status}: ${res.statusText}`,
          });
        }
        break;
      }

      case "openrouter": {
        const res = await withTimeout((signal) =>
          fetch("https://openrouter.ai/api/v1/models", {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal,
          }),
        );
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
        const res = await withTimeout((signal) =>
          fetch(`${xaiBase.replace(/\/$/, "")}/models`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal,
          }),
        );
        if (!res.ok) {
          return successResponse({
            success: false,
            error: `HTTP ${res.status}: ${res.statusText}`,
          });
        }
        break;
      }

      case "moonshot": {
        const moonshotBase = baseUrl || ADAPTER_DEFAULT_BASE_URL.moonshot;
        const res = await withTimeout((signal) =>
          fetch(`${moonshotBase.replace(/\/$/, "")}/models`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal,
          }),
        );
        if (!res.ok) {
          return successResponse({
            success: false,
            error: `HTTP ${res.status}: ${res.statusText}`,
          });
        }
        break;
      }

      case "zai": {
        const zaiBase = baseUrl || ADAPTER_DEFAULT_BASE_URL.zai;
        const res = await withTimeout((signal) =>
          fetch(`${zaiBase.replace(/\/$/, "")}/models`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal,
          }),
        );
        if (!res.ok) {
          return successResponse({
            success: false,
            error: `HTTP ${res.status}: ${res.statusText}`,
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
