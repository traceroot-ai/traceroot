// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ImpersonationError } from "@/lib/api/errors";
import { getAccessKeys } from "@/lib/api";
import { AccessKeysTab } from "./AccessKeysTab";

vi.mock("@/lib/api", () => ({
  getAccessKeys: vi.fn(),
  createAccessKey: vi.fn(),
  updateAccessKey: vi.fn(),
  deleteAccessKey: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("shows the restriction instead of an empty key list", async () => {
  vi.mocked(getAccessKeys).mockRejectedValue(
    new ImpersonationError("API keys cannot be viewed while impersonating."),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AccessKeysTab projectId="p" />
    </QueryClientProvider>,
  );
  expect((await screen.findByRole("alert")).textContent).toContain("while impersonating");
  expect(screen.queryByText(/No API keys yet/)).toBeNull();
  expect(screen.queryByText("Create new API key")).toBeNull();
});

it("keeps the ordinary empty-state copy", async () => {
  vi.mocked(getAccessKeys).mockResolvedValue({ access_keys: [] });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AccessKeysTab projectId="p" />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByText("No API keys yet. Create one to start using the SDK."),
  ).toBeTruthy();
});
