// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { PostHogIdentifier } from "./posthog-identifier";

const posthog = { identify: vi.fn(), reset: vi.fn(), get_property: vi.fn() };
const useSession = vi.fn();

vi.mock("posthog-js/react", () => ({ usePostHog: () => posthog }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => useSession() }));

const user = { id: "u1", email: "a@b.com", name: "Ada" };

beforeEach(() => {
  vi.clearAllMocks();
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
  });

  it("identifies a logged-in user", () => {
    useSession.mockReturnValue({ data: { user, session: {} }, isPending: false });
    render(<PostHogIdentifier />);
    expect(posthog.identify).toHaveBeenCalledWith("u1", { email: "a@b.com", name: "Ada" });
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
