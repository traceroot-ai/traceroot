// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelProvidersTab } from "./ModelProvidersTab";

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

function renderWithQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ModelProvidersTab workspaceId="workspace-1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ModelProvidersTab", () => {
  function mockExistingProvider() {
    mocks.getModelProviders.mockResolvedValue({
      byokEnabled: true,
      providers: [
        {
          id: "provider-1",
          adapter: "openai",
          provider: "OpenAI",
          keyPreview: "sk-...",
          baseUrl: "http://localhost:9999",
          customModels: [],
          withDefaultModels: true,
          config: null,
          enabled: true,
          createdBy: "user-1",
          createTime: "2026-06-24T00:00:00.000Z",
          updateTime: "2026-06-24T00:00:00.000Z",
        },
      ],
    });
  }

  it("clears a stale connection test result when the Base URL changes", async () => {
    mockExistingProvider();
    mocks.testModelProvider.mockResolvedValue({
      success: false,
      error: "Unable to connect",
    });

    renderWithQueryClient();

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));

    expect(await screen.findByText("Unable to connect")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Default: https://api.openai.com/v1"), {
      target: { value: "https://api.openai.com/v1" },
    });

    await waitFor(() => {
      expect(screen.queryByText("Unable to connect")).toBeNull();
    });
  });

  it("ignores an older in-flight connection test after the Base URL changes", async () => {
    mockExistingProvider();
    let resolveTest: (result: { success: boolean; error?: string }) => void = () => {};
    mocks.testModelProvider.mockReturnValue(
      new Promise((resolve) => {
        resolveTest = resolve;
      }),
    );

    renderWithQueryClient();

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));

    await waitFor(() => expect(mocks.testModelProvider).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByPlaceholderText("Default: https://api.openai.com/v1"), {
      target: { value: "https://api.openai.com/v1" },
    });

    await act(async () => {
      resolveTest({ success: false, error: "Unable to connect" });
    });

    expect(screen.queryByText("Unable to connect")).toBeNull();
  });
});
