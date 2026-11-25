import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/env", () => ({ env: {} }));

import { buildWorkspaceMemberEvent, notifyWorkspaceMember } from "./membership-webhook";
// The same sample request the receiver tests against (gtm-lead-service,
// src/events/samples/workspace_member_joined.json): change both together.
import sample from "./__fixtures__/workspace_member_joined.json";

const env = {
  TRACEROOT_SIGNUP_WEBHOOK_URL: "https://leads.example/events",
  TRACEROOT_SIGNUP_WEBHOOK_SECRET: "s3cret",
};
const input = { userId: "u1", workspaceId: "w1", createdBy: "u1", via: "created" as const };

afterEach(() => vi.restoreAllMocks());

describe("buildWorkspaceMemberEvent", () => {
  it("builds exactly the sample request the receiver accepts", () => {
    expect(
      buildWorkspaceMemberEvent({
        userId: "u_123",
        workspaceId: "ws_acme_1",
        createdBy: "u_100",
        via: "invite",
        occurredAt: new Date("2026-11-06T16:30:00.000Z"),
      }),
    ).toEqual(sample);
  });

  it("carries ids and how the person joined, nothing else", () => {
    const at = new Date("2026-11-23T10:00:00Z");
    expect(buildWorkspaceMemberEvent({ ...input, occurredAt: at })).toEqual({
      event: "workspace_member_joined",
      occurred_at: "2026-11-23T10:00:00.000Z",
      user: { id: "u1" },
      workspace: { id: "w1", created_by: "u1" },
      via: "created",
    });
    expect(
      buildWorkspaceMemberEvent({ userId: "u2", workspaceId: "w1", via: "invite" }).workspace,
    ).toEqual({
      id: "w1",
      created_by: null,
    });
  });
});

describe("notifyWorkspaceMember", () => {
  it("posts it signed as the sign-up event is, to the same URL", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    expect(await notifyWorkspaceMember(input, { env, fetchImpl })).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(env.TRACEROOT_SIGNUP_WEBHOOK_URL);
    const headers = init.headers as Record<string, string>;
    const expected = createHmac("sha256", "s3cret")
      .update(`${headers["X-TraceRoot-Timestamp"]}.${init.body}`, "utf8")
      .digest("hex");
    expect(headers["X-TraceRoot-Signature"]).toBe(expected);
    expect(JSON.parse(String(init.body))).toMatchObject({
      event: "workspace_member_joined",
      via: "created",
    });
  });

  it("sends nothing while the webhook is not configured", async () => {
    const fetchImpl = vi.fn();
    expect(await notifyWorkspaceMember(input, { env: {}, fetchImpl })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("tries a failed delivery three times, then logs the ids only and never throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(notifyWorkspaceMember(input, { env, fetchImpl, retryDelayMs: 0 })).resolves.toBe(
      false,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledTimes(1);
    // The ids are arguments to a fixed format string, never part of it.
    expect(error.mock.calls[0].slice(0, 3)).toEqual([
      "[signup] membership webhook failed for user %s in workspace %s: %s",
      "u1",
      "w1",
    ]);
  });

  it("stops retrying once a delivery gets through", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(await notifyWorkspaceMember(input, { env, fetchImpl, retryDelayMs: 0 })).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
