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
// provider check (including the error-body reads below).
import { TimeoutError, withTimeout } from "./timeout";

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

// Extract a provider's `{ error: { message } }` text from an error response.
// Runs inside the withTimeout operation, so a stalled body read is still bounded
// by the deadline: if the abort fired mid-read, rethrow so withTimeout reports a
// timeout; a merely unparseable/empty body falls back to the HTTP status line.
async function readErrorMessage(res: Response, signal: AbortSignal): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } | string };
    if (body?.error && typeof body.error === "object" && "message" in body.error) {
      return body.error.message ? String(body.error.message) : undefined;
    }
    if (typeof body?.error === "string") {
      return body.error;
    }
    return undefined;
  } catch (err) {
    if (signal.aborted) throw err;
    return undefined;
  }
}

// Bounded connectivity check for a "list models"-style GET endpoint. Both the
// fetch and the error-body read run under a single deadline.
async function checkEndpoint(
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: true } | { ok: false; error: string; detail?: string }> {
  return withTimeout(async (signal) => {
    const res = await fetch(url, { headers, signal });
    if (res.ok) return { ok: true as const };

    // Check status before reading the body — 401/403 never need the provider's message.
    if (res.status === 401) {
      return { ok: false as const, error: "Invalid API key" };
    }
    if (res.status === 403) {
      return { ok: false as const, error: "API lacks permission" };
    }

    const message = await readErrorMessage(res, signal);
    const isGoogleInvalidKey = /api key not valid/i.test(message ?? "");

    let normalizedError: string;
    let errorDetail: string | undefined;
    if (res.status === 400 && isGoogleInvalidKey) {
      // Google's machine-readable API_KEY_INVALID lives in error.details[].reason, which
      // readErrorMessage does not surface — so match the prose in error.message instead.
      normalizedError = "Invalid API key";
    } else if (res.status === 400 && message && /incorrect api key/i.test(message)) {
      // xAI returns 400 with a plain-string error mentioning "Incorrect API key".
      normalizedError = "Invalid API key";
    } else {
      normalizedError = "Connection failed";
      errorDetail = message ?? `HTTP ${res.status}: ${res.statusText}`;
    }
    return { ok: false as const, error: normalizedError, detail: errorDetail };
  });
}

function adapterBaseUrl(adapter: string, baseUrl?: string): string {
  return (baseUrl || ADAPTER_DEFAULT_BASE_URL[adapter]).replace(/\/$/, "");
}

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
        const check = await checkEndpoint(url, { Authorization: `Bearer ${apiKey}` });
        if (!check.ok)
          return successResponse({ success: false, error: check.error, detail: check.detail });
        break;
      }

      case "anthropic": {
        // Anthropic has no list-models endpoint; a minimal message call only
        // distinguishes an invalid key (401) from a reachable provider.
        const anthropicBase = adapterBaseUrl(adapter, baseUrl);
        const check = await withTimeout(async (signal) => {
          const res = await fetch(`${anthropicBase}/v1/messages`, {
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
          });
          if (res.ok) return { invalid: false as const };
          if (res.status === 401) return { invalid: true as const, error: "Invalid API key" };
          if (res.status === 403) return { invalid: true as const, error: "API lacks permission" };
          return { invalid: false as const };
        });
        if (check.invalid) return successResponse({ success: false, error: check.error });
        break;
      }

      case "google": {
        const googleBase = adapterBaseUrl(adapter, baseUrl);
        const check = await checkEndpoint(
          `${googleBase}/models`,
          { "x-goog-api-key": apiKey || "" },
        );
        if (!check.ok)
          return successResponse({ success: false, error: check.error, detail: check.detail });
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
        const check = await checkEndpoint(
          `${baseUrl.replace(/\/$/, "")}/models?api-version=${apiVersion}`,
          { "api-key": apiKey || "" },
        );
        if (!check.ok)
          return successResponse({ success: false, error: check.error, detail: check.detail });
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
        const check = await checkEndpoint(`${deepseekBase.replace(/\/$/, "")}/models`, {
          Authorization: `Bearer ${apiKey}`,
        });
        if (!check.ok)
          return successResponse({ success: false, error: check.error, detail: check.detail });
        break;
      }

      case "openrouter": {
        const openrouterBase = adapterBaseUrl(adapter, baseUrl);
        const check = await checkEndpoint(`${openrouterBase}/models`, {
          Authorization: `Bearer ${apiKey}`,
        });
        if (!check.ok)
          return successResponse({ success: false, error: check.error, detail: check.detail });
        break;
      }

      case "xai": {
        const xaiBase = baseUrl || ADAPTER_DEFAULT_BASE_URL.xai;
        const check = await checkEndpoint(`${xaiBase.replace(/\/$/, "")}/models`, {
          Authorization: `Bearer ${apiKey}`,
        });
        if (!check.ok)
          return successResponse({ success: false, error: check.error, detail: check.detail });
        break;
      }

      case "moonshot": {
        const moonshotBase = baseUrl || ADAPTER_DEFAULT_BASE_URL.moonshot;
        const check = await checkEndpoint(`${moonshotBase.replace(/\/$/, "")}/models`, {
          Authorization: `Bearer ${apiKey}`,
        });
        if (!check.ok)
          return successResponse({ success: false, error: check.error, detail: check.detail });
        break;
      }

      case "zai": {
        const zaiBase = baseUrl || ADAPTER_DEFAULT_BASE_URL.zai;
        const check = await checkEndpoint(`${zaiBase.replace(/\/$/, "")}/models`, {
          Authorization: `Bearer ${apiKey}`,
        });
        if (!check.ok)
          return successResponse({ success: false, error: check.error, detail: check.detail });
        break;
      }
    }

    return successResponse({ success: true });
  } catch (err) {
    // A timeout message stands on its own as a headline. Transport failures
    // ("fetch failed", "ECONNREFUSED") are raw runtime text, so they belong in
    // the detail line under a normalized headline.
    if (err instanceof TimeoutError) {
      return successResponse({ success: false, error: err.message });
    }
    return successResponse({
      success: false,
      error: "Connection failed",
      detail: err instanceof Error ? err.message : undefined,
    });
  }
}
