// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  signInEmail: vi.fn(),
  signInSocial: vi.fn(),
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

import { SignInClient } from "../sign-in-client";

function setParams(params: Record<string, string>) {
  searchParams = new URLSearchParams(params);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  searchParams = new URLSearchParams();
});

// The callback a signed-out visitor to an onboarding link arrives with: the
// path the proxy sent them from, carrying its own encoded callback to the
// `traceroot setup` run that is blocked waiting on them.
const NESTED_CALLBACK = "/onboarding?callbackUrl=%2Fdevice%3Fuser_code%3DABCD1234";

function fillAndSubmit() {
  fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
    target: { value: "kai@example.com" },
  });
  fireEvent.change(screen.getByPlaceholderText("********"), {
    target: { value: "password123" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

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

  it("returns the visitor to the full path, nested callback and all", async () => {
    setParams({ callbackUrl: NESTED_CALLBACK });
    mocks.signInEmail.mockResolvedValue({ error: null });

    render(<SignInClient googleAuthConfigured={false} />);
    fillAndSubmit();

    // Unchanged, so the onboarding page still finds the terminal in its query.
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(NESTED_CALLBACK));
  });

  it("carries the nested callback through the Google round-trip", async () => {
    setParams({ callbackUrl: NESTED_CALLBACK });
    mocks.signInSocial.mockResolvedValue({ error: null });

    render(<SignInClient googleAuthConfigured={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Google" }));

    await waitFor(() =>
      expect(mocks.signInSocial).toHaveBeenCalledWith({
        provider: "google",
        callbackURL: NESTED_CALLBACK,
      }),
    );
  });

  it("carries the nested callback to the sign-up link", () => {
    setParams({ callbackUrl: NESTED_CALLBACK });

    render(<SignInClient googleAuthConfigured={false} />);
    const link = screen.getByRole("link", { name: "Sign up" });
    expect(link.getAttribute("href")).toBe(
      `/auth/sign-up?callbackUrl=${encodeURIComponent(NESTED_CALLBACK)}`,
    );
  });

  it("refuses a nested callback whose outer path is off-origin", async () => {
    setParams({ callbackUrl: "//evil.example/onboarding?callbackUrl=%2Fdevice" });
    mocks.signInEmail.mockResolvedValue({ error: null });

    render(<SignInClient googleAuthConfigured={false} />);
    fillAndSubmit();

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/"));
  });

  it("drops a foreign callback rather than forwarding it to sign-up", () => {
    setParams({ callbackUrl: "https://evil.example.com/steal" });

    render(<SignInClient googleAuthConfigured={false} />);
    const link = screen.getByRole("link", { name: "Sign up" });
    // safeCallbackUrl collapses the off-origin value to the "/" fallback, which
    // is treated as "no real callback" — so the link stays bare.
    expect(link.getAttribute("href")).toBe("/auth/sign-up");
  });
});
