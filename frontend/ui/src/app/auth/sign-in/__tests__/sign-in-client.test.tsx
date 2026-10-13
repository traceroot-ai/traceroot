// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  signInEmail: vi.fn(),
  signInSocial: vi.fn(),
  captureAttribution: vi.fn(),
}));

let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
  useSearchParams: () => searchParams,
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: {
      email: (...args: unknown[]) => mocks.signInEmail(...args),
      social: (...args: unknown[]) => mocks.signInSocial(...args),
    },
  },
}));

vi.mock("@/lib/marketing-attribution-browser", () => ({
  captureBrowserAttribution: mocks.captureAttribution,
}));

import { SignInClient } from "../sign-in-client";

function setParams(params: Record<string, string>) {
  searchParams = new URLSearchParams(params);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  searchParams = new URLSearchParams();
});

describe("SignInClient", () => {
  it("carries the callback to the sign-up link so a new user finishes the round-trip", () => {
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });

    render(<SignInClient googleAuthConfigured={false} />);
    const link = screen.getByRole("link", { name: "Sign up" });
    expect(link.getAttribute("href")).toBe(
      `/auth/sign-up?callbackUrl=${encodeURIComponent("/device?user_code=ABCD1234")}`,
    );
  });

  it("uses a bare sign-up link when there is no callback", () => {
    render(<SignInClient googleAuthConfigured={false} />);
    const link = screen.getByRole("link", { name: "Sign up" });
    expect(link.getAttribute("href")).toBe("/auth/sign-up");
  });

  it("drops a foreign callback rather than forwarding it to sign-up", () => {
    setParams({ callbackUrl: "https://evil.example.com/steal" });

    render(<SignInClient googleAuthConfigured={false} />);
    const link = screen.getByRole("link", { name: "Sign up" });
    // safeCallbackUrl collapses the off-origin value to the "/" fallback, which
    // is treated as "no real callback" — so the link stays bare.
    expect(link.getAttribute("href")).toBe("/auth/sign-up");
  });

  it("preserves top-level UTMs and a safe callback when switching to sign-up", () => {
    setParams({
      callbackUrl: "/device?user_code=ABCD1234",
      utm_source: "github",
      utm_campaign: "github-navigation",
      utm_content: "readme-cloud-en",
      token: "private-token",
    });
    render(<SignInClient googleAuthConfigured={false} />);

    const href = screen.getByRole("link", { name: "Sign up" }).getAttribute("href")!;
    const target = new URL(href, "http://localhost");
    expect(Object.fromEntries(target.searchParams)).toEqual({
      callbackUrl: "/device?user_code=ABCD1234",
      utm_source: "github",
      utm_campaign: "github-navigation",
      utm_content: "readme-cloud-en",
    });
  });

  it("saves attribution before email sign-in and keeps its destination", async () => {
    setParams({ callbackUrl: "/projects/p1/traces" });
    mocks.signInEmail.mockResolvedValue({ error: null });
    render(<SignInClient googleAuthConfigured={false} />);
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "kai@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("********"), {
      target: { value: "password123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/projects/p1/traces"));
    expect(mocks.captureAttribution).toHaveBeenCalledOnce();
    expect(mocks.captureAttribution.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.signInEmail.mock.invocationCallOrder[0],
    );
  });

  it("saves attribution before leaving for Google sign-in", async () => {
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });
    mocks.signInSocial.mockResolvedValue(undefined);
    render(<SignInClient googleAuthConfigured={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Google" }));

    await waitFor(() =>
      expect(mocks.signInSocial).toHaveBeenCalledWith({
        provider: "google",
        callbackURL: "/device?user_code=ABCD1234",
      }),
    );
    expect(mocks.captureAttribution).toHaveBeenCalledOnce();
    expect(mocks.captureAttribution.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.signInSocial.mock.invocationCallOrder[0],
    );
  });
});
