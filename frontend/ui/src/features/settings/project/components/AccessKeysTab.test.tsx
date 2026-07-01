// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  getAccessKeys: vi.fn().mockResolvedValue({ access_keys: [] }),
  createAccessKey: vi.fn(),
  updateAccessKey: vi.fn(),
  deleteAccessKey: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  getAccessKeys: (...args: unknown[]) => mocks.getAccessKeys(...args),
  createAccessKey: (...args: unknown[]) => mocks.createAccessKey(...args),
  updateAccessKey: (...args: unknown[]) => mocks.updateAccessKey(...args),
  deleteAccessKey: (...args: unknown[]) => mocks.deleteAccessKey(...args),
}));

import { AccessKeysTab } from "./AccessKeysTab";

function renderAccessKeysTab() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <AccessKeysTab projectId="proj_123" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  mocks.getAccessKeys.mockReset().mockResolvedValue({ access_keys: [] });
  mocks.createAccessKey.mockReset();
  mocks.updateAccessKey.mockReset();
  mocks.deleteAccessKey.mockReset();
});

describe("AccessKeysTab", () => {
  it("shows Project API Keys help from the info icon", async () => {
    renderAccessKeysTab();

    const trigger = screen.getByRole("button", { name: /about project api keys/i });
    expect(trigger).toBeDefined();

    fireEvent.focus(trigger);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toMatch(/authenticate traceroot sdk and api requests/i);
    expect(tooltip.textContent).toMatch(/copy the full secret immediately/i);
    expect(tooltip.textContent).toMatch(/store it as traceroot_api_key/i);
    expect(tooltip.textContent).toMatch(/only a masked hint is shown/i);
  });
});
