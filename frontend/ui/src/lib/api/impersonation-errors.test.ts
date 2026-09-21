import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, ImpersonationError, throwIfImpersonationDenied } from "./errors";
import { fetchNextApi } from "./client";
import { fetchSlackConnection, sendSlackTestMessage } from "@/lib/slack";

vi.mock("@/lib/auth-client", () => ({ authClient: {} }));
afterEach(() => vi.unstubAllGlobals());

function response(message: string, marker?: string, status = 403) {
  return Response.json(
    { error: message },
    {
      status,
      headers: marker ? { "x-impersonation-denied": marker } : {},
    },
  );
}

describe("impersonation-only error messages", () => {
  it.each([
    ["Credentials are unavailable while impersonating", "API keys cannot be viewed or managed"],
    ["Provider credentials are unavailable while impersonating", "Providers cannot be added"],
    [
      "Integration authorization is unavailable while impersonating",
      "Integrations cannot be managed",
    ],
    ["Read-only while impersonating", "This impersonation session is read-only"],
  ])("explains tagged denial: %s", async (message, expected) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(message, "policy")));
    await expect(fetchNextApi("/example")).rejects.toThrow(expected);
  });

  it("keeps ordinary 403 messages and error types unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("Forbidden")));
    const error = await fetchNextApi("/example").catch((error) => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(ImpersonationError);
    expect((error as ApiError).message).toBe("Forbidden");
  });

  it.each([undefined, "unknown"])(
    "ignores unrecognized marker %s without consuming body",
    async (marker) => {
      const res = response("Forbidden", marker);
      await throwIfImpersonationDenied(res);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    },
  );

  it("does not reclassify server failures", async () => {
    await expect(
      throwIfImpersonationDenied(response("failure", "policy", 500)),
    ).resolves.toBeUndefined();
  });

  it("explains ended sessions and malformed policy responses", async () => {
    await expect(throwIfImpersonationDenied(response("", "ended"))).rejects.toThrow("Select Stop");
    await expect(
      throwIfImpersonationDenied(
        new Response("not json", { status: 403, headers: { "x-impersonation-denied": "policy" } }),
      ),
    ).rejects.toThrow("This action is not allowed while impersonating.");
  });

  it("preserves Slack's ordinary error and identifies impersonation refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response("Forbidden"))
        .mockResolvedValueOnce(
          response("Integration authorization is unavailable while impersonating", "policy"),
        ),
    );
    await expect(fetchSlackConnection("ws")).rejects.toThrow("failed to fetch slack status");
    await expect(fetchSlackConnection("ws")).rejects.toBeInstanceOf(ImpersonationError);
  });

  it("does not label a Slack policy refusal a failed connection", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response("Integration authorization is unavailable while impersonating", "policy"),
        ),
    );
    await expect(sendSlackTestMessage("ws")).rejects.toThrow("Integrations cannot be managed");
  });
});
