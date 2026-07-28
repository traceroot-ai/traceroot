import { vi } from "vitest";

export function mockRetention(overrides?: Record<string, unknown>) {
  return {
    retentionDays: 15,
    showPricing: false,
    onUpgradeClick: vi.fn(),
    closePricing: vi.fn(),
    workspaceId: "ws-1",
    billingPlan: "free",
    ...overrides,
  };
}
