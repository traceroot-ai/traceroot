// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AGENTID_OWNER_LIMIT_REACHED, AGENTID_OWNER_MISSING } from "@/lib/agentid-owner-cap";

let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => searchParams }));

import AuthErrorPage from "../page";

afterEach(() => {
  cleanup();
  searchParams = new URLSearchParams();
});

describe("AuthErrorPage", () => {
  it.each([
    [AGENTID_OWNER_LIMIT_REACHED, /already has the maximum number of AgentID agents/],
    [AGENTID_OWNER_MISSING, /which AgentMail account or organization this agent belongs to/],
  ])("explains the AgentID cap code %s", (code, message) => {
    searchParams = new URLSearchParams({ error: code });
    render(<AuthErrorPage />);
    expect(screen.getByText(message)).toBeTruthy();
  });

  it("falls back to a generic message for an unknown code, without echoing it", () => {
    searchParams = new URLSearchParams({ error: "<script>x</script>" });
    render(<AuthErrorPage />);
    expect(screen.getByText("An error occurred during authentication.")).toBeTruthy();
    expect(screen.queryByText(/script/)).toBeNull();
  });
});
