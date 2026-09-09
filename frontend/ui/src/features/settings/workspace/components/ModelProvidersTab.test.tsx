// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// Radix Select renders through a portal and is flaky in jsdom; mock it to a
// native <select> so we can drive onValueChange directly, matching the
// pattern used in DetectorsTab.test.tsx.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  }) => (
    <select
      aria-label="adapter"
      role="combobox"
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

import { getBaseUrlPayload, ModelProvidersTab } from "./ModelProvidersTab";

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

beforeEach(() => {
  mocks.getModelProviders.mockResolvedValue({ byokEnabled: true, providers: [] });
});

afterEach(() => {
  cleanup();
  mocks.getModelProviders.mockReset();
  mocks.createModelProvider.mockReset();
  mocks.updateModelProvider.mockReset();
  mocks.deleteModelProvider.mockReset();
  mocks.testModelProvider.mockReset();
});

describe("ModelProvidersTab - Test Connection error display", () => {
  it("renders the error in its own block below the button on failure, not inline", async () => {
    mocks.testModelProvider.mockResolvedValue({ success: false, error: "Invalid API key" });
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: /add provider/i }));
    fireEvent.change(screen.getByRole("combobox", { name: /adapter/i }), {
      target: { value: "openai" },
    });
    fireEvent.change(screen.getByPlaceholderText("sk-..."), {
      target: { value: "bad-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));

    const errorText = await screen.findByText("Invalid API key");
    // The error lives in its own block, not the same inline row as the button.
    const button = screen.getByRole("button", { name: /test connection/i });
    expect(button.parentElement?.contains(errorText)).toBe(false);
  });

  it("renders a non-auth failure as a headline with the raw provider text demoted to a detail line", async () => {
    mocks.testModelProvider.mockResolvedValue({
      success: false,
      error: "Connection failed",
      detail: "HTTP 500: Internal Server Error",
    });
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: /add provider/i }));
    fireEvent.change(screen.getByRole("combobox", { name: /adapter/i }), {
      target: { value: "openai" },
    });
    fireEvent.change(screen.getByPlaceholderText("sk-..."), { target: { value: "k" } });
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));

    const headline = await screen.findByText("Connection failed");
    const detail = screen.getByText("HTTP 500: Internal Server Error");
    // The raw provider text is a sibling of the headline, styled as secondary.
    expect(detail).not.toBe(headline);
    expect(detail.className).toContain("text-muted-foreground");
  });

  it("surfaces a failed request itself, rather than leaving the user with no result", async () => {
    mocks.testModelProvider.mockRejectedValue(new Error("Failed to fetch"));
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: /add provider/i }));
    fireEvent.change(screen.getByRole("combobox", { name: /adapter/i }), {
      target: { value: "openai" },
    });
    fireEvent.change(screen.getByPlaceholderText("sk-..."), { target: { value: "k" } });
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));

    expect(await screen.findByText("Connection failed")).toBeTruthy();
    expect(screen.getByText("Failed to fetch")).toBeTruthy();
  });

  it("shows Connected inline next to the button on success, not the error block", async () => {
    mocks.testModelProvider.mockResolvedValue({ success: true });
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: /add provider/i }));
    fireEvent.change(screen.getByRole("combobox", { name: /adapter/i }), {
      target: { value: "openai" },
    });
    fireEvent.change(screen.getByPlaceholderText("sk-..."), {
      target: { value: "good-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));

    await waitFor(() => expect(screen.getByText("Connected")).toBeTruthy());
    const button = screen.getByRole("button", { name: /test connection/i });
    const connectedText = screen.getByText("Connected");
    expect(button.parentElement?.contains(connectedText)).toBe(true);
    expect(screen.queryByText(/invalid api key/i)).toBeNull();
  });
});

describe("ModelProvidersTab", () => {
  describe("getBaseUrlPayload", () => {
    it("omits empty Base URL in create mode", () => {
      expect(getBaseUrlPayload("", false)).toEqual({});
      expect(getBaseUrlPayload("   ", false)).toEqual({});
    });

    it("sends null when Base URL is cleared in edit mode", () => {
      expect(getBaseUrlPayload("", true)).toEqual({ baseUrl: null });
    });

    it("trims a provided Base URL", () => {
      expect(getBaseUrlPayload(" https://example.com/v1testing ", false)).toEqual({
        baseUrl: "https://example.com/v1testing",
      });
    });
  });

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

  it("trims Base URL when testing a provider", async () => {
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
    mocks.testModelProvider.mockResolvedValue({ success: true });

    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const baseUrlInput = screen.getByDisplayValue("https://example.com/v1testing");
    fireEvent.change(baseUrlInput, { target: { value: " https://example.com/v1testing " } });
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));

    await waitFor(() => expect(mocks.testModelProvider).toHaveBeenCalledTimes(1));
    expect(mocks.testModelProvider).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ baseUrl: "https://example.com/v1testing" }),
    );
  });

  it("shows the catalog protocol for an o-series model and persists an explicit Responses pick", async () => {
    mocks.getModelProviders.mockResolvedValue({
      byokEnabled: true,
      providers: [
        {
          id: "provider-1",
          adapter: "openai",
          provider: "OpenAI",
          keyPreview: "sk-...",
          baseUrl: null,
          customModels: ["o3"],
          withDefaultModels: true,
          config: null, // saved before any override existed
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

    // The protocol select is the one offering the two OpenAI protocols. With no
    // override it must show what the resolver will actually use for o3.
    const protocolSelect = screen
      .getAllByRole("combobox")
      .find((el) =>
        Array.from((el as HTMLSelectElement).options).some((o) => o.value === "openai-completions"),
      ) as HTMLSelectElement;
    expect(protocolSelect.value).toBe("openai-completions");

    // Choosing Responses for o3 differs from its effective default, so it is persisted.
    fireEvent.change(protocolSelect, { target: { value: "openai-responses" } });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(mocks.updateModelProvider).toHaveBeenCalledTimes(1));
    expect(mocks.updateModelProvider).toHaveBeenCalledWith(
      "ws-1",
      "provider-1",
      expect.objectContaining({ config: { modelProtocols: { o3: "openai-responses" } } }),
    );
  });

  it("clears a saved override when the pick is changed back to the default", async () => {
    mocks.getModelProviders.mockResolvedValue({
      byokEnabled: true,
      providers: [
        {
          id: "provider-1",
          adapter: "openai",
          provider: "OpenAI",
          keyPreview: "sk-...",
          baseUrl: null,
          customModels: ["o3"],
          withDefaultModels: true,
          config: { modelProtocols: { o3: "openai-responses" } },
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
    const protocolSelect = screen
      .getAllByRole("combobox")
      .find((el) =>
        Array.from((el as HTMLSelectElement).options).some((o) => o.value === "openai-completions"),
      ) as HTMLSelectElement;
    expect(protocolSelect).toBeDefined();
    expect(protocolSelect.value).toBe("openai-responses");

    fireEvent.change(protocolSelect, { target: { value: "openai-completions" } });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(mocks.updateModelProvider).toHaveBeenCalledTimes(1));
    // The update API merges config, so the override must be sent as cleared,
    // not omitted — otherwise the stored Responses pick would survive.
    expect(mocks.updateModelProvider).toHaveBeenCalledWith(
      "ws-1",
      "provider-1",
      expect.objectContaining({ config: { modelProtocols: {} } }),
    );
  });
});
