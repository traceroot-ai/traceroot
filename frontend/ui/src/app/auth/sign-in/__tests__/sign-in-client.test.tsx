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
import { configuredSocialProviders } from "@/lib/social-providers";

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
  it("titles the card with the product name", () => {
    render(<SignInClient socialProviders={[]} />);
    expect(screen.getByRole("heading", { name: "Sign in to traceroot" })).toBeTruthy();
  });

  it("carries the callback to the sign-up link so a new user finishes the round-trip", () => {
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });

    render(<SignInClient socialProviders={[]} />);
    const link = screen.getByRole("link", { name: "Sign up" });
    expect(link.getAttribute("href")).toBe(
      `/auth/sign-up?callbackUrl=${encodeURIComponent("/device?user_code=ABCD1234")}`,
    );
  });

  it("uses a bare sign-up link when there is no callback", () => {
    render(<SignInClient socialProviders={[]} />);
    const link = screen.getByRole("link", { name: "Sign up" });
    expect(link.getAttribute("href")).toBe("/auth/sign-up");
  });

  it("returns the visitor to the full path, nested callback and all", async () => {
    setParams({ callbackUrl: NESTED_CALLBACK });
    mocks.signInEmail.mockResolvedValue({ error: null });

    render(<SignInClient socialProviders={[]} />);
    fillAndSubmit();

    // Unchanged, so the onboarding page still finds the terminal in its query.
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(NESTED_CALLBACK));
  });

  it("carries the nested callback through the Google round-trip", async () => {
    setParams({ callbackUrl: NESTED_CALLBACK });
    mocks.signInSocial.mockResolvedValue({ error: null });

    render(<SignInClient socialProviders={["google"]} />);
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

    render(<SignInClient socialProviders={[]} />);
    const link = screen.getByRole("link", { name: "Sign up" });
    expect(link.getAttribute("href")).toBe(
      `/auth/sign-up?callbackUrl=${encodeURIComponent(NESTED_CALLBACK)}`,
    );
  });

  it("refuses a nested callback whose outer path is off-origin", async () => {
    setParams({ callbackUrl: "//evil.example/onboarding?callbackUrl=%2Fdevice" });
    mocks.signInEmail.mockResolvedValue({ error: null });

    render(<SignInClient socialProviders={[]} />);
    fillAndSubmit();

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/"));
  });

  it("drops a foreign callback rather than forwarding it to sign-up", () => {
    setParams({ callbackUrl: "https://evil.example.com/steal" });

    render(<SignInClient socialProviders={[]} />);
    const link = screen.getByRole("link", { name: "Sign up" });
    // safeCallbackUrl collapses the off-origin value to the "/" fallback, which
    // is treated as "no real callback" — so the link stays bare.
    expect(link.getAttribute("href")).toBe("/auth/sign-up");
  });
});

describe("SignInClient social buttons", () => {
  it("shows no divider when neither provider is configured", () => {
    render(<SignInClient socialProviders={[]} />);
    expect(screen.queryByText("Or continue with")).toBeNull();
  });

  it("gives the button back and shows why when the sign-in cannot start", async () => {
    mocks.signInSocial.mockResolvedValue({ error: { message: "Provider not found" } });

    render(<SignInClient socialProviders={["google"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Google" }));

    expect(await screen.findByText("Provider not found")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Google" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("recovers the same way when the request itself fails", async () => {
    mocks.signInSocial.mockRejectedValue(new Error("network down"));

    render(<SignInClient socialProviders={["google"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Google" }));

    expect(await screen.findByText("Could not start sign-in. Please try again.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Google" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("configuredSocialProviders", () => {
  it("lists Google only when its id and secret are both set", () => {
    expect(
      configuredSocialProviders({ AUTH_GOOGLE_CLIENT_ID: "", AUTH_GOOGLE_CLIENT_SECRET: "" }),
    ).toEqual([]);
    expect(
      configuredSocialProviders({ AUTH_GOOGLE_CLIENT_ID: "g", AUTH_GOOGLE_CLIENT_SECRET: " " }),
    ).toEqual([]);
    expect(
      configuredSocialProviders({ AUTH_GOOGLE_CLIENT_ID: "g", AUTH_GOOGLE_CLIENT_SECRET: "g" }),
    ).toEqual(["google"]);
  });
});
