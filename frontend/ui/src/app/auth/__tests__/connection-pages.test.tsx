// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

// The sign-in and sign-up pages are server components: they read the assistant
// being connected from the callback, and the configured social providers from
// the environment, then hand both to the client form. These tests render the
// pages themselves so that wiring is covered, not just the forms.

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  signInSocial: vi.fn(),
  loadClient: vi.fn(),
}));

let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
  useSearchParams: () => searchParams,
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { social: (...args: unknown[]) => mocks.signInSocial(...args) },
  },
}));

vi.mock("@/env", () => ({ env: {} }));

vi.mock("@/lib/oauth/load-client-display", () => ({
  loadOAuthClientDisplay: (...args: unknown[]) => mocks.loadClient(...args),
}));

import { env } from "@/env";
import SignInPage from "../sign-in/page";
import SignUpPage from "../sign-up/page";

const CALLBACK =
  "/oauth/continue?response_type=code&client_id=https%3A%2F%2Fclaude.ai%2Fdoc&sig=abc";

type Page = (props: {
  searchParams: Promise<{ callbackUrl?: string | string[] }>;
}) => Promise<React.ReactElement>;

async function renderPage(page: Page, params: Record<string, string>) {
  searchParams = new URLSearchParams(params);
  render(await page({ searchParams: Promise.resolve(params) }));
}

beforeEach(() => {
  const e = env as Record<string, string>;
  e.AUTH_GOOGLE_CLIENT_ID = "google-id";
  e.AUTH_GOOGLE_CLIENT_SECRET = "google-secret";
  e.AUTH_AGENTID_CLIENT_ID = "agentid-id";
  e.AUTH_AGENTID_CLIENT_SECRET = "agentid-secret";
  mocks.loadClient.mockResolvedValue({ name: "Claude", verifiedHost: "claude.ai" });
  mocks.signInSocial.mockReturnValue(new Promise(() => {}));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  searchParams = new URLSearchParams();
});

const PAGES = [
  {
    name: "sign-in",
    page: SignInPage as Page,
    heading: "Sign in to connect Claude",
    socialCallback: CALLBACK,
  },
  {
    name: "sign-up",
    page: SignUpPage as Page,
    heading: "Create an account to connect Claude",
    // A new account sets up its first project before it picks one to connect.
    socialCallback: `/onboarding?callbackUrl=${encodeURIComponent(CALLBACK)}`,
  },
];

describe.each(PAGES)("$name page while connecting an assistant", (c) => {
  it("names the assistant read from the callback's client_id", async () => {
    await renderPage(c.page, { callbackUrl: CALLBACK });

    expect(mocks.loadClient).toHaveBeenCalledWith("https://claude.ai/doc");
    expect(screen.getByRole("heading", { name: c.heading })).toBeTruthy();
    expect(screen.getByText("claude.ai").parentElement?.textContent).toBe("Verified by claude.ai");
  });

  it("warns when the assistant registered itself", async () => {
    mocks.loadClient.mockResolvedValue({ name: "Acme Helper", verifiedHost: null });
    await renderPage(c.page, { callbackUrl: CALLBACK });

    expect(screen.getByRole("alert").textContent).toContain("Unverified application");
  });

  it.each([
    ["google", "Google"],
    ["agentid", "AgentID"],
  ] as const)("returns a %s sign-in to the authorization", async (provider, label) => {
    await renderPage(c.page, { callbackUrl: CALLBACK });
    fireEvent.click(screen.getByRole("button", { name: label }));

    expect(mocks.signInSocial).toHaveBeenCalledWith({ provider, callbackURL: c.socialCallback });
  });

  it("keeps the plain page when the callback is not an authorization", async () => {
    // The real loader answers null for a null client id without touching the database.
    mocks.loadClient.mockResolvedValue(null);
    await renderPage(c.page, { callbackUrl: "/projects/p1/traces" });

    expect(mocks.loadClient).toHaveBeenCalledWith(null);
    expect(screen.queryByText(/to connect/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
