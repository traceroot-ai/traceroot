// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PostHogIdentifier } from "./posthog-identifier";
import { PostHogPageView } from "./posthog-pageview";

const useSession = vi.fn();
const posthog = { capture: vi.fn(), reset: vi.fn(), identify: vi.fn(), get_property: vi.fn() };
const searchParams = new URLSearchParams("utm_source=github");
vi.mock("@/lib/auth-client", () => ({ useSession: () => useSession() }));
vi.mock("posthog-js/react", () => ({ usePostHog: () => posthog }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/auth/sign-in",
  useSearchParams: () => searchParams,
}));
vi.mock("@/lib/marketing-attribution-browser", () => ({
  captureBrowserAttribution: () => null,
  clearBrowserAttribution: () => {},
}));

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/auth/sign-in?utm_source=github");
});
afterEach(cleanup);

describe("session-aware landing page capture", () => {
  it("waits for session resolution and captures after stale identity reset", () => {
    useSession.mockReturnValue({ data: null, isPending: true });
    const tree = (
      <>
        <PostHogIdentifier />
        <PostHogPageView />
      </>
    );
    const view = render(tree);
    expect(posthog.capture).not.toHaveBeenCalled();
    posthog.get_property.mockReturnValue("identified");
    useSession.mockReturnValue({ data: null, isPending: false });
    view.rerender(
      <>
        <PostHogIdentifier />
        <PostHogPageView />
      </>,
    );
    expect(posthog.capture).toHaveBeenCalledTimes(1);
    expect(posthog.capture).toHaveBeenCalledWith("$pageview", {
      $current_url: window.location.href,
    });
    expect(posthog.reset.mock.invocationCallOrder[0]).toBeLessThan(
      posthog.capture.mock.invocationCallOrder[0],
    );
  });

  it("does not capture a support impersonation as the customer's visit", () => {
    useSession.mockReturnValue({
      data: { user: { id: "u1" }, session: { impersonatedBy: "admin" } },
      isPending: false,
    });
    render(<PostHogPageView />);
    expect(posthog.capture).not.toHaveBeenCalled();
  });
});
