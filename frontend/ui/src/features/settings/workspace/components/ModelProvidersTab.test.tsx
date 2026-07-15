// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  testModelProvider: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  getModelProviders: vi.fn().mockResolvedValue({ byokEnabled: true, providers: [] }),
  createModelProvider: vi.fn(),
  updateModelProvider: vi.fn(),
  deleteModelProvider: vi.fn(),
  testModelProvider: (...a: unknown[]) => mocks.testModelProvider(...a),
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

import { ModelProvidersTab } from "./ModelProvidersTab";

function renderTab() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <ModelProvidersTab workspaceId="ws-1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
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
