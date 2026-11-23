// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  signInSocial: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: {
      social: (...args: unknown[]) => mocks.signInSocial(...args),
    },
  },
}));

import { SocialSignInButtons } from "./social-sign-in-buttons";

afterEach(() => {
  cleanup();
  mocks.signInSocial.mockReset();
});

describe("SocialSignInButtons", () => {
  it("renders nothing when no social providers are enabled", () => {
    const { container } = render(
      <SocialSignInButtons providers={[]} callbackURL="/after-auth" onError={vi.fn()} />,
    );

    expect(container.textContent).toBe("");
  });

  it("starts the selected provider sign-in with the configured callback", async () => {
    mocks.signInSocial.mockResolvedValue({});
    const onError = vi.fn();

    render(
      <SocialSignInButtons
        providers={["github", "google"]}
        callbackURL="/onboarding"
        onError={onError}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));

    expect(onError).toHaveBeenCalledWith(null);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Redirecting..." }).disabled).toBe(
      true,
    );
    await waitFor(() =>
      expect(mocks.signInSocial).toHaveBeenCalledWith({
        provider: "github",
        callbackURL: "/onboarding",
      }),
    );
  });

  it("surfaces provider errors and re-enables the buttons", async () => {
    mocks.signInSocial.mockResolvedValue({ error: { message: "OAuth app is not configured" } });
    const onError = vi.fn();

    render(<SocialSignInButtons providers={["google"]} callbackURL="/" onError={onError} />);

    fireEvent.click(screen.getByRole("button", { name: "Google" }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("OAuth app is not configured"));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Google" }).disabled).toBe(false);
  });

  it("uses the shared fallback message when the auth client returns an empty error", async () => {
    mocks.signInSocial.mockResolvedValue({ error: {} });
    const onError = vi.fn();

    render(<SocialSignInButtons providers={["github"]} callbackURL="/" onError={onError} />);

    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("Could not start sign-in. Please try again."),
    );
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "GitHub" }).disabled).toBe(false);
  });

  it("handles unexpected auth client failures", async () => {
    mocks.signInSocial.mockRejectedValue(new Error("network down"));
    const onError = vi.fn();

    render(<SocialSignInButtons providers={["google"]} callbackURL="/" onError={onError} />);

    fireEvent.click(screen.getByRole("button", { name: "Google" }));

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("Could not start sign-in. Please try again."),
    );
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Google" }).disabled).toBe(false);
  });

  it("re-enables every button when the page is restored from the back/forward cache", async () => {
    // A redirect that starts successfully never comes back through the error
    // paths, so the pending state is still set when the browser hands the tab
    // to the provider. Coming back restores this page from the back/forward
    // cache with the React state replayed verbatim - no remount, no effect -
    // so without a `pageshow` reset both buttons stay locked on "Redirecting...".
    mocks.signInSocial.mockResolvedValue({});

    render(
      <SocialSignInButtons providers={["github", "google"]} callbackURL="/" onError={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));

    await waitFor(() => expect(mocks.signInSocial).toHaveBeenCalled());
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Redirecting..." }).disabled).toBe(
      true,
    );
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Google" }).disabled).toBe(true);

    fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true }));

    expect(screen.getByRole<HTMLButtonElement>("button", { name: "GitHub" }).disabled).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Google" }).disabled).toBe(false);
  });

  it("starts each provider with the same callback", async () => {
    // A failure on the OAuth callback is a server redirect and never reaches
    // `onError`; the server sends those to /auth/error (auth.ts onAPIError).
    mocks.signInSocial.mockResolvedValue({});

    render(
      <SocialSignInButtons
        providers={["github", "google"]}
        callbackURL="/onboarding"
        onError={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Google" }));
    await waitFor(() => expect(mocks.signInSocial).toHaveBeenCalledTimes(1));
    expect(mocks.signInSocial).toHaveBeenLastCalledWith({
      provider: "google",
      callbackURL: "/onboarding",
    });

    fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true }));

    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));
    await waitFor(() => expect(mocks.signInSocial).toHaveBeenCalledTimes(2));
    expect(mocks.signInSocial).toHaveBeenLastCalledWith({
      provider: "github",
      callbackURL: "/onboarding",
    });
  });

  it("stops listening for restores once unmounted", () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");

    try {
      const { unmount } = render(
        <SocialSignInButtons providers={["google"]} callbackURL="/" onError={vi.fn()} />,
      );

      const registration = addEventListener.mock.calls.find(([type]) => type === "pageshow");
      expect(registration).toBeDefined();

      unmount();

      expect(removeEventListener).toHaveBeenCalledWith("pageshow", registration![1]);
    } finally {
      addEventListener.mockRestore();
      removeEventListener.mockRestore();
    }
  });

  it("puts GitHub first, in one row of three when all are configured", () => {
    render(
      <SocialSignInButtons
        providers={["github", "google", "agentid"]}
        callbackURL="/"
        onError={vi.fn()}
      />,
    );
    const [github, google, agentid] = ["GitHub", "Google", "AgentID"].map((name) =>
      screen.getByRole("button", { name }),
    );
    expect(github.parentElement).toBe(agentid.parentElement);
    expect(github.parentElement?.className).toContain("grid-cols-3");
    expect(github.compareDocumentPosition(google) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no GitHub button when GitHub is not configured", () => {
    render(<SocialSignInButtons providers={["google"]} callbackURL="/" onError={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "GitHub" })).toBeNull();
  });

  it("starts GitHub with the terminal's device callback, unchanged", () => {
    mocks.signInSocial.mockReturnValue(new Promise(() => {}));
    render(
      <SocialSignInButtons
        providers={["github"]}
        callbackURL="/device?user_code=ABCD1234"
        onError={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));
    expect(mocks.signInSocial).toHaveBeenCalledWith({
      provider: "github",
      callbackURL: "/device?user_code=ABCD1234",
    });
  });
});
