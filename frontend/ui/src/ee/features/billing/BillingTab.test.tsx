// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanType } from "@traceroot/core";
import type { UsageStats } from "@/types/api";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("./api", () => ({
  getPortalUrl: vi.fn(),
  getSubscriptionInfo: vi.fn(),
}));

vi.mock("./PricingDialog", () => ({
  PricingDialog: () => null,
}));

import { BillingTab } from "./BillingTab";

afterEach(() => {
  cleanup();
});

describe("BillingTab", () => {
  it("shows BYOK model cost as not billed information", () => {
    const usage: UsageStats = {
      traces: 0,
      spans: 0,
      tokens: 0,
      updatedAt: "2026-07-01T00:00:00.000Z",
      detector: {
        scansRun: 1,
        systemTokenCost: 0,
        systemInputTokens: 0,
        systemOutputTokens: 0,
        byModel: [
          {
            model: "glm-5.2",
            provider: "zai",
            isByok: true,
            messages: 1,
            inputTokens: 1000,
            outputTokens: 500,
            cost: 0.0015,
          },
        ],
      },
    };

    render(<BillingTab workspaceId="ws_1" currentPlan={PlanType.PRO} currentUsage={usage} />);

    expect(screen.getByText("glm-5.2")).toBeTruthy();
    expect(screen.getByText("BYOK")).toBeTruthy();
    expect(screen.getByText("1,500 tokens · < $0.01 (not billed)")).toBeTruthy();
  });

  it("splits the event total into customer and platform events when bySource is present", () => {
    const usage: UsageStats = {
      traces: 110,
      spans: 1090,
      tokens: 0,
      updatedAt: "2026-07-01T00:00:00.000Z",
      bySource: {
        user: { traces: 100, spans: 1000 },
        detector: { traces: 8, spans: 80 },
        agent: { traces: 2, spans: 10 },
      },
    };

    render(<BillingTab workspaceId="ws_1" currentPlan={PlanType.PRO} currentUsage={usage} />);

    // Customer rows: user traces + spans.
    expect(screen.getByText("Your events").nextSibling?.textContent).toBe("1,100");
    // Platform rows: everything that is not the customer's (total − user).
    expect(screen.getByText("Platform events").nextSibling?.textContent).toBe("100");
  });

  it("counts a platform writer the breakdown does not name", () => {
    const usage: UsageStats = {
      traces: 120, // 100 user + 8 detector + 2 agent + 10 from a newer writer
      spans: 1090,
      tokens: 0,
      updatedAt: "2026-07-01T00:00:00.000Z",
      bySource: {
        user: { traces: 100, spans: 1000 },
        detector: { traces: 8, spans: 80 },
        agent: { traces: 2, spans: 10 },
      },
    };

    render(<BillingTab workspaceId="ws_1" currentPlan={PlanType.PRO} currentUsage={usage} />);

    expect(screen.getByText("Platform events").nextSibling?.textContent).toBe("110");
  });

  it("omits the per-source breakdown for workspaces not yet re-metered (no bySource)", () => {
    const usage: UsageStats = {
      traces: 5,
      spans: 50,
      tokens: 0,
      updatedAt: "2026-07-01T00:00:00.000Z",
    };

    render(<BillingTab workspaceId="ws_1" currentPlan={PlanType.PRO} currentUsage={usage} />);

    expect(screen.queryByText("Your events")).toBeNull();
    expect(screen.queryByText("Platform events")).toBeNull();
  });

  it("hides unattributed unknown model rows", () => {
    const usage: UsageStats = {
      traces: 0,
      spans: 0,
      tokens: 0,
      updatedAt: "2026-07-01T00:00:00.000Z",
      detector: {
        scansRun: 2,
        systemTokenCost: 0.02,
        systemInputTokens: 2,
        systemOutputTokens: 157,
        byModel: [
          {
            model: "unknown",
            provider: "unknown",
            isByok: false,
            messages: 1,
            inputTokens: 0,
            outputTokens: 0,
            cost: 0,
          },
          {
            model: "claude-opus-4-8",
            provider: "anthropic",
            isByok: false,
            messages: 1,
            inputTokens: 2,
            outputTokens: 157,
            cost: 0.021204,
          },
        ],
      },
    };

    render(<BillingTab workspaceId="ws_1" currentPlan={PlanType.PRO} currentUsage={usage} />);

    expect(screen.queryByText("unknown")).toBeNull();
    expect(screen.getByText("claude-opus-4-8")).toBeTruthy();
  });

  describe("Loop usage", () => {
    const usage = (runsUsed: number): UsageStats => ({
      traces: 0,
      spans: 0,
      tokens: 0,
      updatedAt: "2026-11-11T00:00:00.000Z",
      loop: { runsUsed, systemTokenCost: 0, systemInputTokens: 0, systemOutputTokens: 0 },
    });

    it("shows the Free plan's Loop runs against its 30-run cap", () => {
      render(
        <BillingTab workspaceId="ws_1" currentPlan={PlanType.FREE} currentUsage={usage(12)} />,
      );
      expect(screen.getByText("Loop usage")).toBeTruthy();
      expect(screen.getByText("Loop runs").nextSibling?.textContent).toBe("12 / 30");
      expect(screen.queryByText(/Limit reached/)).toBeNull();
    });

    it("says when the Free cap is reached and runs are skipped", () => {
      render(
        <BillingTab workspaceId="ws_1" currentPlan={PlanType.FREE} currentUsage={usage(30)} />,
      );
      expect(screen.getByText("Loop runs").nextSibling?.textContent).toBe("30 / 30");
      expect(
        screen.getByText("Limit reached: Loop runs are skipped until you upgrade."),
      ).toBeTruthy();
    });

    it("shows paid plans as unlimited, never limit reached", () => {
      render(
        <BillingTab workspaceId="ws_1" currentPlan={PlanType.PRO} currentUsage={usage(500)} />,
      );
      expect(screen.getByText("Loop runs").nextSibling?.textContent).toBe("500 (Unlimited)");
      expect(screen.queryByText(/Limit reached/)).toBeNull();
    });

    it("reads zero before any Loop run has been metered", () => {
      render(<BillingTab workspaceId="ws_1" currentPlan={PlanType.FREE} currentUsage={null} />);
      expect(screen.getByText("Loop runs").nextSibling?.textContent).toBe("0 / 30");
    });
  });
});
