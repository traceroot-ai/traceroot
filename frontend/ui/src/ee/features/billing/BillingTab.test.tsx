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
  getSubscriptionInfo: vi.fn().mockResolvedValue(null),
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

describe("BillingTab - self-host (ENABLE_BILLING=false)", () => {
  it("hides Change plan / Manage billing and shows the unlimited self-host message", () => {
    render(
      <BillingTab
        workspaceId="ws_1"
        currentPlan={PlanType.FREE}
        hasSubscription={false}
        billingEnabled={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "Change plan" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Manage billing/ })).toBeNull();
    expect(
      screen.getByText(
        "This is a self-hosted deployment — every plan limit is unlimited, so there's no higher tier to move to.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/currently on the/)).toBeNull();
  });

  it("does not advertise the Free plan's hard caps on self-host", () => {
    render(
      <BillingTab
        workspaceId="ws_1"
        currentPlan={PlanType.FREE}
        hasSubscription={false}
        billingEnabled={false}
        currentUsage={{
          traces: 60_000,
          spans: 0,
          tokens: 0,
          updatedAt: "2026-07-01T00:00:00.000Z",
        }}
      />,
    );

    expect(screen.queryByText(/hard cap/)).toBeNull();
    expect(
      screen.getByText(
        "Events ingested this period. Self-hosted deployments have no event limits.",
      ),
    ).toBeTruthy();
    // 60,000 traces exceeds the Free plan's 50,000 cap — the "Total events"
    // row must render as unlimited (no "/ 50,000" suffix), matching the
    // enforcement layer which never blocks ingestion when billing is disabled.
    const totalEventsLabel = screen.getByText("Total events");
    const totalEventsRow = totalEventsLabel.closest("div");
    expect(totalEventsRow?.textContent).toBe("Total events60,000");
  });

  it("shows chat/RCA runs as Unlimited and drops the billing-mechanics copy", () => {
    render(
      <BillingTab
        workspaceId="ws_1"
        currentPlan={PlanType.FREE}
        hasSubscription={false}
        billingEnabled={false}
        currentUsage={{
          traces: 0,
          spans: 0,
          tokens: 0,
          updatedAt: "2026-07-01T00:00:00.000Z",
          ai: {
            runsUsed: 45,
            systemUsage: { messages: 0, cost: 0, inputTokens: 0, outputTokens: 0 },
            byokUsage: { messages: 0, cost: 0, inputTokens: 0, outputTokens: 0 },
            byModel: [],
          },
        }}
      />,
    );

    // 45 exceeds Free's 30-run cap — must show Unlimited, not "45 / 30".
    expect(screen.getByText("45 (Unlimited)")).toBeTruthy();
    expect(screen.getAllByText("No billing on self-hosted deployments.").length).toBeGreaterThan(0);
    expect(screen.queryByText(/we pay/)).toBeNull();
    expect(screen.queryByText(/markup/)).toBeNull();
  });

  it("still shows a Change plan button and cloud caps when billing is enabled", () => {
    render(<BillingTab workspaceId="ws_1" currentPlan={PlanType.FREE} billingEnabled={true} />);

    expect(screen.getByRole("button", { name: "Change plan" })).toBeTruthy();
    expect(screen.getByText(/currently on the/)).toBeTruthy();
    expect(screen.getByText(/hard cap/)).toBeTruthy();
  });

  it("still shows Manage billing for a subscribed cloud workspace", () => {
    render(
      <BillingTab
        workspaceId="ws_1"
        currentPlan={PlanType.PRO}
        hasSubscription={true}
        billingEnabled={true}
      />,
    );

    expect(screen.getByRole("button", { name: /Manage billing/ })).toBeTruthy();
  });

  it("shows unlimited events copy for a paid plan with no included cap", () => {
    render(
      <BillingTab workspaceId="ws_1" currentPlan={PlanType.ENTERPRISE} billingEnabled={true} />,
    );

    expect(
      screen.getByText("Events used this billing period. Unlimited events included."),
    ).toBeTruthy();
  });
});
