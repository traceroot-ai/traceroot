// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  getModelProviders: vi.fn(),
  createModelProvider: vi.fn(),
  updateModelProvider: vi.fn(),
  deleteModelProvider: vi.fn(),
  testModelProvider: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  getModelProviders: mocks.getModelProviders,
  createModelProvider: mocks.createModelProvider,
  updateModelProvider: mocks.updateModelProvider,
  deleteModelProvider: mocks.deleteModelProvider,
  testModelProvider: mocks.testModelProvider,
}));

import { ModelProvidersTab } from "./ModelProvidersTab";

function renderTab() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ModelProvidersTab workspaceId="ws-1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  mocks.getModelProviders.mockReset();
  mocks.createModelProvider.mockReset();
  mocks.updateModelProvider.mockReset();
  mocks.deleteModelProvider.mockReset();
  mocks.testModelProvider.mockReset();
});

describe("ModelProvidersTab", () => {
  it("sends null when a saved Base URL is cleared in edit mode", async () => {
    mocks.getModelProviders.mockResolvedValue({
      byokEnabled: true,
      providers: [
        {
          id: "provider-1",
          adapter: "google",
          provider: "Google Gemini",
          keyPreview: "sk-...",
          baseUrl: "https://example.com/v1testing",
          customModels: [],
          withDefaultModels: true,
          config: null,
          enabled: true,
          createdBy: "user-1",
          createTime: "2026-06-17T00:00:00.000Z",
          updateTime: "2026-06-17T00:00:00.000Z",
        },
      ],
    });
    mocks.updateModelProvider.mockResolvedValue({ id: "provider-1" });

    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const baseUrlInput = screen.getByDisplayValue("https://example.com/v1testing");
    fireEvent.change(baseUrlInput, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => expect(mocks.updateModelProvider).toHaveBeenCalledTimes(1));
    expect(mocks.updateModelProvider).toHaveBeenCalledWith(
      "ws-1",
      "provider-1",
      expect.objectContaining({ baseUrl: null }),
    );
  });
});
