// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

import AuthErrorPage from "../page";

function setParams(params: Record<string, string>) {
  searchParams = new URLSearchParams(params);
}

afterEach(() => {
  cleanup();
  searchParams = new URLSearchParams();
});

const genericMessage = "An error occurred during authentication.";

describe("AuthErrorPage", () => {
  it("explains the OAuth codes a social sign-in redirects here with", () => {
    // This page is where a social sign-in's post-redirect failures land, and
    // the codes arrive in the callback's underscored form rather than the
    // capitalised ones the map was originally written around.
    setParams({ error: "account_not_linked" });

    render(<AuthErrorPage />);

    expect(screen.queryByText(genericMessage)).toBeNull();
    expect(
      screen.getByText(
        "This email is already associated with another account. Please sign in with the original provider.",
      ),
    ).toBeTruthy();
  });

  it("falls back to the generic message for a code it does not recognise", () => {
    setParams({ error: "unable_to_get_user_info" });

    render(<AuthErrorPage />);

    expect(screen.getByText(genericMessage)).toBeTruthy();
  });

  it("offers a way back into the app", () => {
    setParams({ error: "access_denied" });

    render(<AuthErrorPage />);

    expect(screen.getByRole("link", { name: "Back to Sign In" }).getAttribute("href")).toBe(
      "/auth/sign-in",
    );
  });
});
