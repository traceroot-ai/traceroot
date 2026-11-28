// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => searchParams }));

import AuthErrorPage from "../page";

afterEach(() => {
  cleanup();
  searchParams = new URLSearchParams();
});

describe("AuthErrorPage", () => {
  it("explains a sign-in that was not linked to an existing account", () => {
    searchParams = new URLSearchParams({ error: "account_not_linked" });
    render(<AuthErrorPage />);
    expect(screen.getByText(/this sign-in was not linked to it/)).toBeTruthy();
  });

  it("falls back to a generic message for an unknown code, without echoing it", () => {
    searchParams = new URLSearchParams({ error: "<script>x</script>" });
    render(<AuthErrorPage />);
    expect(screen.getByText("An error occurred during authentication.")).toBeTruthy();
    expect(screen.queryByText(/script/)).toBeNull();
  });
});
