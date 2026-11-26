import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({ runNewsletterAudience: vi.fn() }));
vi.mock("@traceroot/core/email", () => core);
vi.mock("@traceroot/core", () => ({ prisma: { tag: "prisma" } }));
const deployment = vi.hoisted(() => ({ cloud: true }));
vi.mock("@/lib/server/cloud", () => ({ isCloud: () => deployment.cloud }));

import { newsletterMode, runNewsletterJob } from "./newsletter-job";

beforeEach(() => {
  core.runNewsletterAudience.mockReset().mockResolvedValue({ added: 1 });
  deployment.cloud = true;
  vi.unstubAllEnvs();
});

describe("newsletterMode", () => {
  it.each<[Record<string, string>, string]>([
    [{}, "off"],
    [{ NEWSLETTER_SEGMENT_ENABLED: "false" }, "off"],
    [{ NEWSLETTER_SEGMENT_ENABLED: "TRUE" }, "apply"],
    [{ NEWSLETTER_SEGMENT_DRY_RUN: "true" }, "dry_run"],
    // The dry run wins, so turning it on never needs the other switch off first.
    [{ NEWSLETTER_SEGMENT_ENABLED: "true", NEWSLETTER_SEGMENT_DRY_RUN: "true" }, "dry_run"],
  ])("%o → %s", (environment, mode) => {
    expect(newsletterMode(environment)).toBe(mode);
  });
});

describe("runNewsletterJob", () => {
  const now = new Date("2026-12-20T00:00:00Z");

  it("does nothing while off, which is the default", async () => {
    expect(await runNewsletterJob({ now })).toEqual({ mode: "off" });
    expect(core.runNewsletterAudience).not.toHaveBeenCalled();
  });

  it("does nothing on a self-hosted install, even switched on", async () => {
    vi.stubEnv("NEWSLETTER_SEGMENT_ENABLED", "true");
    deployment.cloud = false;
    expect(await runNewsletterJob({ now })).toEqual({ mode: "off" });
    expect(core.runNewsletterAudience).not.toHaveBeenCalled();
  });

  it("adds the 14-day sign-ups a batch per tick when on", async () => {
    vi.stubEnv("NEWSLETTER_SEGMENT_ENABLED", "true");
    expect(await runNewsletterJob({ now })).toEqual({ added: 1 });
    expect(core.runNewsletterAudience).toHaveBeenCalledWith(
      { tag: "prisma" },
      expect.objectContaining({
        mode: { kind: "scheduled", now },
        apply: true,
        limit: 10,
        budgetMs: 20_000,
      }),
    );
  });

  it("in a dry run, writes nothing", async () => {
    vi.stubEnv("NEWSLETTER_SEGMENT_DRY_RUN", "true");
    await runNewsletterJob({ now });
    expect(core.runNewsletterAudience.mock.calls[0][1]).toMatchObject({ apply: false });
  });

  it("ignores the follow-up switches", async () => {
    vi.stubEnv("LIFECYCLE_EMAILS_ENABLED", "true");
    expect(await runNewsletterJob({ now })).toEqual({ mode: "off" });
  });
});
