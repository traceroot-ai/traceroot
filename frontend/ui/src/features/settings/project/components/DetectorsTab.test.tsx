// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  project: {
    workspace_id: "w1",
    alert_emails: [] as string[],
    alert_window: "10m",
  } as any,
  updateProject: vi.fn().mockResolvedValue({}),
  workspace: { role: "ADMIN" },
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
vi.mock("@/features/settings/workspace/hooks", () => ({
  useWorkspace: () => ({ data: mocks.workspace }),
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
import { ApiError } from "@/lib/api/errors";

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
  mocks.project.alert_window = "10m";
  mocks.workspace.role = "ADMIN";
  mocks.project.alert_emails = [];
});

describe("DetectorsTab alert window", () => {
  it("describes email notifications as windowed digests", () => {
    renderTab();
    expect(
      screen.getByText("New and reopened signals are batched into one email per alert window."),
    ).toBeTruthy();
  });

  it("hydrates the saved window from the project", () => {
    mocks.project.alert_window = "1h";
    renderTab();
    const trigger = screen.getByRole("combobox", { name: /window/i }) as HTMLSelectElement;
    expect(trigger.value).toBe("1h");
  });

  it("saves a changed window via alert_window", async () => {
    mocks.project.alert_window = "10m";
    renderTab();
    const trigger = screen.getByRole("combobox", { name: /window/i });
    fireEvent.change(trigger, { target: { value: "2h" } });
    fireEvent.click(screen.getByRole("button", { name: /save alert window/i }));
    await waitFor(() =>
      expect(mocks.updateProject).toHaveBeenCalledWith("w1", "p1", { alert_window: "2h" }),
    );
  });

  it("disables Save window until the selection changes", () => {
    mocks.project.alert_window = "10m";
    renderTab();
    const save = screen.getByRole("button", { name: /save alert window/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: /window/i }), {
      target: { value: "5m" },
    });
    expect(save.disabled).toBe(false);
  });
});

describe("DetectorsTab email permissions", () => {
  it("lets members view recipients but disables editing", () => {
    mocks.workspace.role = "MEMBER";
    mocks.project.alert_emails = ["existing@example.com"];
    renderTab();

    const input = screen.getByRole("textbox") as HTMLInputElement;
    const add = screen.getByRole("button", { name: /add recipient/i });
    const remove = screen.getByRole("button", { name: /remove recipient/i });
    const emailSection = add.closest("fieldset")!;
    const save = within(emailSection).getByRole("button", { name: /^save$/i });

    expect(input.value).toBe("existing@example.com");
    for (const control of [input, add, remove, save]) {
      expect(control.matches(":disabled")).toBe(true);
    }
    expect(screen.getByText(/only workspace admins/i)).toBeTruthy();
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it("lets admins edit email recipients", async () => {
    mocks.project.alert_emails = ["existing@example.com"];
    renderTab();

    const input = screen.getByRole("textbox") as HTMLInputElement;
    const add = screen.getByRole("button", { name: /add recipient/i });
    const remove = screen.getByRole("button", { name: /remove recipient/i });
    const emailSection = add.closest("fieldset")!;
    const save = within(emailSection).getByRole("button", { name: /^save$/i });

    expect(input.matches(":disabled")).toBe(false);
    expect(add.matches(":disabled")).toBe(false);
    expect(remove.matches(":disabled")).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.change(input, {
      target: { value: "new@example.com" },
    });
    fireEvent.click(save);

    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => {
      expect(mocks.updateProject).toHaveBeenCalledWith("w1", "p1", {
        alert_emails: ["new@example.com"],
      });
    });
  });

  it("shows an error and restores recipients when the server rejects permission", async () => {
    mocks.workspace.role = "ADMIN";
    mocks.project.alert_emails = ["existing@example.com"];
    mocks.updateProject.mockRejectedValueOnce(new ApiError(403, "Requires ADMIN role or higher"));
    renderTab();

    const input = screen.getByRole("textbox");
    const emailSection = input.closest("fieldset")!;
    const save = within(emailSection).getByRole("button", { name: /^save$/i });

    expect(input.matches(":disabled")).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.change(input, {
      target: { value: "updated@example.com" },
    });
    fireEvent.click(save);

    const error = await screen.findByRole("alert");

    expect(error.textContent).toContain(
      "Failed to save email recipients: Requires ADMIN role or higher",
    );
    expect(mocks.updateProject).toHaveBeenCalledWith("w1", "p1", {
      alert_emails: ["updated@example.com"],
    });
    expect((input as HTMLInputElement).value).toBe("existing@example.com");
    expect(save.matches(":disabled")).toBe(true);
  });

  it("keeps the email draft available for retry after a server error", async () => {
    mocks.project.alert_emails = ["existing@example.com"];
    mocks.updateProject.mockRejectedValueOnce(new ApiError(500, "Internal server error"));
    renderTab();

    const input = screen.getByRole("textbox") as HTMLInputElement;
    const save = within(input.closest("fieldset")!).getByRole("button", { name: /^save$/i });
    fireEvent.change(input, { target: { value: "updated@example.com" } });
    fireEvent.click(save);

    expect((await screen.findByRole("alert")).textContent).toContain("Internal server error");
    expect(input.value).toBe("updated@example.com");
    expect(save.matches(":disabled")).toBe(false);
  });
});
