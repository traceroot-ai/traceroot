import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ cloud: true, findMany: vi.fn() }));
vi.mock("@traceroot/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@traceroot/core")>()),
  prisma: { user: { findMany: m.findMany } },
}));
vi.mock("@/lib/server/cloud", () => ({ isCloud: () => m.cloud }));
vi.mock("@/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://app.example" } }));

import { followUpMode, lifecycleStartAt, runFollowUps } from "./follow-up-job";

const MAIL = {
  RESEND_API_KEY: "re_test",
  TRACEROOT_UPDATES_EMAIL_FROM: "Xinwei <x@updates.example>",
  TRACEROOT_UPDATES_EMAIL_REPLY_TO: "team@example.test",
  RESEND_PRODUCT_TOPIC_ID: "topic",
  TRACEROOT_UNSUBSCRIBE_TOKEN_SECRET: "s".repeat(40),
};

beforeEach(() => {
  m.cloud = true;
  m.findMany.mockReset().mockResolvedValue([]);
});

describe("the job's switches", () => {
  it.each([
    [{}, "off"],
    [{ LIFECYCLE_EMAILS_ENABLED: "true" }, "send"],
    [{ LIFECYCLE_EMAILS_ENABLED: "TRUE " }, "send"],
    [{ LIFECYCLE_EMAILS_ENABLED: "1" }, "off"],
    [{ LIFECYCLE_EMAILS_DRY_RUN: "true" }, "dry_run"],
    // A dry run wins: turning it on never sends.
    [{ LIFECYCLE_EMAILS_ENABLED: "true", LIFECYCLE_EMAILS_DRY_RUN: "true" }, "dry_run"],
  ])("%j → %s", (environment, mode) => {
    expect(followUpMode(environment)).toBe(mode);
  });

  it.each([
    [{}, null],
    [{ LIFECYCLE_START_AT: "not a date" }, null],
    [{ LIFECYCLE_START_AT: "2026-12-01T00:00:00Z" }, new Date("2026-12-01T00:00:00Z")],
  ])("start %j → %j", (environment, at) => {
    expect(lifecycleStartAt(environment)).toEqual(at);
  });
});

describe("a run that does nothing", () => {
  it.each([
    ["while off", { LIFECYCLE_START_AT: "2026-12-01T00:00:00Z" }, true],
    ["without a start", { LIFECYCLE_EMAILS_ENABLED: "true", ...MAIL }, true],
    [
      "self-hosted",
      { LIFECYCLE_EMAILS_ENABLED: "true", LIFECYCLE_START_AT: "2026-12-01T00:00:00Z", ...MAIL },
      false,
    ],
    [
      "sending without product mail settings",
      { LIFECYCLE_EMAILS_ENABLED: "true", LIFECYCLE_START_AT: "2026-12-01T00:00:00Z" },
      true,
    ],
  ])("reads no one %s", async (_when, environment, cloud) => {
    m.cloud = cloud;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = await runFollowUps({ environment, now: new Date("2026-12-05T00:00:00Z") });
    expect(run.considered).toBe(0);
    expect(m.findMany).not.toHaveBeenCalled();
  });

  it("a dry run needs no product mail settings, and looks only at sign-ups since the start", async () => {
    const run = await runFollowUps({
      environment: { LIFECYCLE_EMAILS_DRY_RUN: "true", LIFECYCLE_START_AT: "2026-12-01T00:00:00Z" },
      now: new Date("2026-12-05T00:00:00Z"),
    });
    expect(run.mode).toBe("dry_run");
    expect(m.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          createdAt: {
            gte: new Date("2026-12-01T00:00:00Z"),
            lte: new Date("2026-12-05T00:00:00Z"),
          },
        },
      }),
    );
  });
});
