// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { PostHogIdentifier } from "./posthog-identifier";

const posthog = { identify: vi.fn(), reset: vi.fn(), get_property: vi.fn() };
const useSession = vi.fn();
const attribution = vi.hoisted(() => ({ capture: vi.fn(), clear: vi.fn() }));
vi.mock("@/lib/marketing-attribution-browser", () => ({
  captureBrowserAttribution: attribution.capture,
  clearBrowserAttribution: attribution.clear,
}));

vi.mock("posthog-js/react", () => ({ usePostHog: () => posthog }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => useSession() }));

const user = { id: "u1", email: "a@b.com", name: "Ada" };

beforeEach(() => {
  vi.clearAllMocks();
  attribution.capture.mockReturnValue(null);
});

afterEach(() => {
  cleanup();
});

describe("PostHogIdentifier", () => {
  it("does nothing while the session is pending", () => {
    useSession.mockReturnValue({ data: null, isPending: true });
    render(<PostHogIdentifier />);
    expect(posthog.reset).not.toHaveBeenCalled();
    expect(posthog.identify).not.toHaveBeenCalled();
  });

  it.each(["anonymous", undefined])("does not reset an anonymous visitor (%s)", (state) => {
    posthog.get_property.mockReturnValue(state);
    useSession.mockReturnValue({ data: null, isPending: false });
    render(<PostHogIdentifier />);
    expect(posthog.reset).not.toHaveBeenCalled();
  });

  it("resets an identified visitor with no session", () => {
    posthog.get_property.mockReturnValue("identified");
    useSession.mockReturnValue({ data: null, isPending: false });
    render(<PostHogIdentifier />);
    expect(posthog.reset).toHaveBeenCalledTimes(1);
    expect(attribution.clear).toHaveBeenCalledTimes(1);
    expect(attribution.capture).toHaveBeenCalledWith(true);
  });

  it("identifies a logged-in user", () => {
    useSession.mockReturnValue({ data: { user, session: {} }, isPending: false });
    render(<PostHogIdentifier />);
    expect(posthog.identify).toHaveBeenCalledWith("u1", { email: "a@b.com", name: "Ada" });
  });

  it("links the anonymous campaign to the account and consumes it", () => {
    attribution.capture.mockReturnValue({
      capturedAt: Date.parse("2026-10-13T08:00:00Z"),
      utm: { utm_source: "github", utm_campaign: "github-navigation" },
    });
    useSession.mockReturnValue({ data: { user, session: {} }, isPending: false });
    render(<PostHogIdentifier />);
    expect(posthog.identify).toHaveBeenCalledWith("u1", {
      email: "a@b.com",
      name: "Ada",
      utm_source: "github",
      utm_campaign: "github-navigation",
      utm_medium: null,
      utm_content: null,
      utm_term: null,
      marketing_touch_at: "2026-10-13T08:00:00.000Z",
      marketing_attribution_model: "last_campaign_touch",
    });
    expect(attribution.clear).toHaveBeenCalledTimes(1);
    expect(posthog.identify.mock.invocationCallOrder[0]).toBeLessThan(
      attribution.clear.mock.invocationCallOrder[0],
    );
  });

  it("does not identify an impersonated session", () => {
    useSession.mockReturnValue({
      data: { user, session: { impersonatedBy: "admin1" } },
      isPending: false,
    });
    render(<PostHogIdentifier />);
    expect(posthog.identify).not.toHaveBeenCalled();
  });
});
