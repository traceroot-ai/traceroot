import {
  resolveProviderBaseUrl,
  InvalidProviderUrlError,
  providerFetch,
} from "@traceroot/core/provider-url";
import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { z } from "zod";
import { Role, LLMAdapter, ADAPTER_DEFAULT_BASE_URL } from "@traceroot/core";
import {
  requireAuth,
  requireWorkspaceMembership,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
// Keep the deadline armed until the response body is cancelled.
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
  LLMAdapter.TYPESAFE,
] as const;

const testSchema = z.object({
  adapter: z.enum(ADAPTER_VALUES),
  apiKey: z.string().trim().optional(),
  baseUrl: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  // Bedrock-specific
  awsAccessKeyId: z.string().optional(),
  awsSecretAccessKey: z.string().optional(),
  awsRegion: z.string().optional(),
  useDefaultCredentials: z.boolean().optional(),
});

type RouteParams = { params: Promise<{ workspaceId: string }> };

// Check status only; never expose a target response or leave its body streaming.
async function checkEndpoint(
  url: string,
  headers: Record<string, string>,
  init: Pick<RequestInit, "method" | "body"> = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  return withTimeout(async (signal) => {
    const res = await providerFetch(url, { ...init, headers, signal });
    await res.body?.cancel();
    if (res.ok) return { ok: true as const };

    return { ok: false as const, error: "Connection failed" };
  });
}

function adapterBaseUrl(adapter: string, baseUrl?: string): string {
  return resolveProviderBaseUrl(adapter, baseUrl)!;
}

// POST /api/workspaces/[workspaceId]/model-providers/test
async function handlePOST(request: NextRequest, { params }: RouteParams) {
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

  // A connectivity check must not turn a write-only stored key into an outbound credential.
  const apiKey = result.data.apiKey;
  if (adapter !== "amazon-bedrock" && !apiKey) {
    return successResponse({
      success: false,
      error: "Re-enter the API key to test this connection.",
    });
  }

  try {
    if (baseUrl !== undefined || ADAPTER_DEFAULT_BASE_URL[adapter]) {
      resolveProviderBaseUrl(adapter, baseUrl);
    }
  } catch (error) {
    if (error instanceof InvalidProviderUrlError) return errorResponse(error.message, 400);
    throw error;
  }

  try {
    switch (adapter) {
      case "openai": {
        const openaiBase = adapterBaseUrl(adapter, baseUrl);
        const url = `${openaiBase}/models`;
        const check = await checkEndpoint(url, { Authorization: `Bearer ${apiKey}` });
        if (!check.ok) return successResponse({ success: false, error: check.error });
        break;
      }

      case "anthropic": {
        const anthropicBase = adapterBaseUrl(adapter, baseUrl);
        const check = await checkEndpoint(
          `${anthropicBase}/v1/messages`,
          {
            "x-api-key": apiKey || "",
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          {
            method: "POST",
            body: JSON.stringify({
              model: "claude-haiku-4-5",
              max_tokens: 1,
              messages: [{ role: "user", content: "hi" }],
            }),
          },
        );
        if (!check.ok) return successResponse({ success: false, error: check.error });
        break;
      }

      case "google": {
        const googleBase = adapterBaseUrl(adapter, baseUrl);
        const check = await checkEndpoint(`${googleBase}/models`, {
          "x-goog-api-key": apiKey || "",
        });
        if (!check.ok) return successResponse({ success: false, error: check.error });
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
        const azureBase = adapterBaseUrl(adapter, baseUrl);
        const check = await checkEndpoint(`${azureBase}/models?api-version=${apiVersion}`, {
          "api-key": apiKey || "",
        });
        if (!check.ok) return successResponse({ success: false, error: check.error });
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
        const deepseekBase = adapterBaseUrl(adapter, baseUrl);
        const check = await checkEndpoint(`${deepseekBase}/models`, {
          Authorization: `Bearer ${apiKey}`,
        });
        if (!check.ok) return successResponse({ success: false, error: check.error });
        break;
      }

      case "openrouter": {
        const openrouterBase = adapterBaseUrl(adapter, baseUrl);
        const check = await checkEndpoint(`${openrouterBase}/models`, {
          Authorization: `Bearer ${apiKey}`,
        });
        if (!check.ok) return successResponse({ success: false, error: check.error });
        break;
      }

      case "xai": {
        const xaiBase = adapterBaseUrl(adapter, baseUrl);
        const check = await checkEndpoint(`${xaiBase}/models`, {
          Authorization: `Bearer ${apiKey}`,
        });
        if (!check.ok) return successResponse({ success: false, error: check.error });
        break;
      }

      case "moonshot": {
        const moonshotBase = adapterBaseUrl(adapter, baseUrl);
        const check = await checkEndpoint(`${moonshotBase}/models`, {
          Authorization: `Bearer ${apiKey}`,
        });
        if (!check.ok) return successResponse({ success: false, error: check.error });
        break;
      }

      case "zai": {
        const zaiBase = adapterBaseUrl(adapter, baseUrl);
        const check = await checkEndpoint(`${zaiBase}/models`, {
          Authorization: `Bearer ${apiKey}`,
        });
        if (!check.ok) return successResponse({ success: false, error: check.error });
        break;
      }

      case "typesafe": {
        // GET /models answers 401 for a bad key. Only the status is checked: the
        // list names aliases (jev-latest), not every version /systemone accepts.
        const typesafeBase = adapterBaseUrl(adapter, baseUrl);
        const check = await checkEndpoint(`${typesafeBase}/models`, {
          Authorization: `Bearer ${apiKey}`,
        });
        if (!check.ok) return successResponse({ success: false, error: check.error });
        break;
      }
    }

    return successResponse({ success: true });
  } catch {
    return successResponse({ success: false, error: "Connection failed" });
  }
}
export const POST = withImpersonationPolicy(handlePOST);
