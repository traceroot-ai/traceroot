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
});
