// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

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
});
