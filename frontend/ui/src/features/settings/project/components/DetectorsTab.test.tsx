// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  project: {
    workspace_id: "w1",
    alert_emails: [] as string[],
    alert_window: "off",
  } as any,
  updateProject: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: mocks.project, isLoading: false }),
}));
vi.mock("@/lib/api", () => ({
  updateProject: (...a: any[]) => mocks.updateProject(...a),
}));
vi.mock("@/features/integrations/hooks/useSlackIntegration", () => ({
  useSlackStatus: () => ({ data: undefined }),
}));
vi.mock("@/features/ai-assistant/components/model-selector", () => ({
  ModelSelector: () => null,
}));
vi.mock("@/features/detectors/components/alert-channels-editor", () => ({
  AlertChannelsEditor: () => null,
}));

// Radix Select renders through a portal and is flaky in jsdom; mock it to a
// native <select> so we can drive the onValueChange path directly.
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
      aria-label="window"
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

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DetectorsTab } from "./DetectorsTab";

function renderTab() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <DetectorsTab projectId="p1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  mocks.updateProject.mockReset().mockResolvedValue({});
  mocks.project.alert_window = "off";
});

describe("DetectorsTab alert window", () => {
  it("hydrates the saved window from the project", () => {
    mocks.project.alert_window = "1h";
    renderTab();
    const trigger = screen.getByRole("combobox", { name: /window/i }) as HTMLSelectElement;
    expect(trigger.value).toBe("1h");
  });

  it("saves a changed window via alert_window", async () => {
    mocks.project.alert_window = "off";
    renderTab();
    const trigger = screen.getByRole("combobox", { name: /window/i });
    fireEvent.change(trigger, { target: { value: "2h" } });
    fireEvent.click(screen.getByRole("button", { name: /save alert window/i }));
    await waitFor(() =>
      expect(mocks.updateProject).toHaveBeenCalledWith("w1", "p1", { alert_window: "2h" }),
    );
  });

  it("disables Save window until the selection changes", () => {
    mocks.project.alert_window = "off";
    renderTab();
    const save = screen.getByRole("button", { name: /save alert window/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: /window/i }), {
      target: { value: "5m" },
    });
    expect(save.disabled).toBe(false);
  });
});
