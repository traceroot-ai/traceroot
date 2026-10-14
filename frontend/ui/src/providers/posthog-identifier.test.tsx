// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { PostHogIdentifier } from "./posthog-identifier";
import { ATTRIBUTION_COOKIE, readAttributionCookie } from "@/lib/marketing-attribution";

const posthog = {
  identify: vi.fn(),
  reset: vi.fn(),
  get_property: vi.fn(),
  has_opted_out_capturing: vi.fn(),
};
const useSession = vi.fn();
vi.mock("posthog-js/react", () => ({ usePostHog: () => posthog }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => useSession() }));

const user = { id: "u1", email: "a@b.com", name: "Ada" };

beforeEach(() => {
  vi.clearAllMocks();
  posthog.has_opted_out_capturing.mockReturnValue(false);
  document.cookie = `${ATTRIBUTION_COOKIE}=; Max-Age=0; Path=/`;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
  });

  it("identifies a logged-in user", () => {
    useSession.mockReturnValue({ data: { user, session: {} }, isPending: false });
    render(<PostHogIdentifier />);
    expect(posthog.identify).toHaveBeenCalledWith("u1", { email: "a@b.com", name: "Ada" });
  });

  it("links the anonymous campaign to the account and consumes it", () => {
    const capturedAt = Date.now();
    document.cookie = `${ATTRIBUTION_COOKIE}=${encodeURIComponent(
      JSON.stringify({
        v: 1,
        capturedAt,
        utm: { utm_source: "github", utm_campaign: "github-navigation" },
      }),
    )}; Path=/`;
    const setter = vi.spyOn(document, "cookie", "set");
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
      marketing_touch_at: new Date(capturedAt).toISOString(),
      marketing_attribution_model: "last_campaign_touch",
    });
    expect(readAttributionCookie(document.cookie)).toBeNull();
    expect(posthog.identify.mock.invocationCallOrder[0]).toBeLessThan(
      setter.mock.invocationCallOrder[0],
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
  it("does not apply a consumed campaign to another account", () => {
    document.cookie = `${ATTRIBUTION_COOKIE}=${encodeURIComponent(
      JSON.stringify({
        v: 1,
        capturedAt: Date.now(),
        utm: { utm_source: "github" },
      }),
    )}; Path=/`;
    useSession.mockReturnValue({ data: { user, session: {} }, isPending: false });
    const { rerender } = render(<PostHogIdentifier />);
    useSession.mockReturnValue({ data: null, isPending: false });
    posthog.get_property.mockReturnValue("identified");
    rerender(<PostHogIdentifier />);
    useSession.mockReturnValue({
      data: { user: { ...user, id: "u2" }, session: {} },
      isPending: false,
    });
    rerender(<PostHogIdentifier />);
    expect(posthog.identify).toHaveBeenLastCalledWith("u2", { email: user.email, name: user.name });
  });

  it("clears the campaign without identifying an opted-out user", () => {
    document.cookie = `${ATTRIBUTION_COOKIE}=anything; Path=/`;
    posthog.has_opted_out_capturing.mockReturnValue(true);
    useSession.mockReturnValue({ data: { user, session: {} }, isPending: false });
    render(<PostHogIdentifier />);
    expect(posthog.identify).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain(ATTRIBUTION_COOKIE);
  });

  it("keeps identification working when cookie access is blocked", () => {
    vi.spyOn(document, "cookie", "get").mockImplementation(() => {
      throw new Error("blocked");
    });
    useSession.mockReturnValue({ data: { user, session: {} }, isPending: false });
    expect(() => render(<PostHogIdentifier />)).not.toThrow();
    expect(posthog.identify).toHaveBeenCalledWith("u1", { email: user.email, name: user.name });
  });
  it("uses the server's campaign timestamp even when the device clock is behind", () => {
    const capturedAt = Date.now();
    document.cookie = `${ATTRIBUTION_COOKIE}=${encodeURIComponent(
      JSON.stringify({
        v: 1,
        capturedAt,
        utm: { utm_source: "github" },
      }),
    )}; Path=/`;
    vi.spyOn(Date, "now").mockReturnValue(capturedAt - 120_000);
    useSession.mockReturnValue({ data: { user, session: {} }, isPending: false });
    render(<PostHogIdentifier />);
    expect(posthog.identify).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({
        utm_source: "github",
        marketing_touch_at: new Date(capturedAt).toISOString(),
      }),
    );
  });
});
