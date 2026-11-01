// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { ModelSelection } from "@/features/ai-assistant/components/model-selector";

const mocks = vi.hoisted(() => ({
  project: {
    workspace_id: "w1",
    alert_emails: [] as string[],
    alert_window: "10m",
    rca_model: "saved-model",
    rca_provider: "saved-provider",
    rca_source: "byok",
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
  // Exercise the parent's selection and disabled props without loading a model catalog.
  ModelSelector: ({
    value,
    onChange,
    disabled,
  }: {
    value: ModelSelection;
    onChange: (selection: ModelSelection) => void;
    disabled?: boolean;
  }) => (
    <select
      aria-label="agent model"
      value={value.model}
      disabled={disabled}
      data-provider={value.provider}
      data-source={value.source}
      data-adapter={value.adapter}
      onChange={(e) =>
        onChange({
          model: e.target.value,
          provider: "updated-provider",
          source: "system",
          adapter: "openai",
        })
      }
    >
      <option value="saved-model">Saved model</option>
      <option value="updated-model">Updated model</option>
    </select>
  ),
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
    disabled,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
    disabled?: boolean;
  }) => (
    <select
      aria-label="window"
      role="combobox"
      value={value}
      disabled={disabled}
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
import { ApiError, ImpersonationError } from "@/lib/api/errors";

function renderTab() {
  const qc = new QueryClient();
  const result = render(
    <QueryClientProvider client={qc}>
      <DetectorsTab projectId="p1" />
    </QueryClientProvider>,
  );
  return { ...result, queryClient: qc };
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

describe("DetectorsTab agent model permissions", () => {
  it("lets members view the saved selection but disables editing", () => {
    mocks.workspace.role = "MEMBER";
    renderTab();
    const select = screen.getByRole("combobox", { name: "agent model" }) as HTMLSelectElement;
    const save = within(select.parentElement!).getByRole("button", { name: /^save$/i });

    expect(select.value).toBe("saved-model");
    expect(select.matches(":disabled")).toBe(true);
    expect(save.matches(":disabled")).toBe(true);
    expect(screen.getByText("Only workspace admins can change these settings.")).toBeTruthy();
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it("lets admins change and save the selection", async () => {
    renderTab();
    const select = screen.getByRole("combobox", { name: "agent model" }) as HTMLSelectElement;
    const save = within(select.parentElement!).getByRole("button", { name: /^save$/i });
    expect(select.matches(":disabled")).toBe(false);
    expect(save.matches(":disabled")).toBe(true);
    expect(screen.queryByText(/only workspace admins/i)).toBeNull();

    fireEvent.change(select, { target: { value: "updated-model" } });
    expect(save.matches(":disabled")).toBe(false);
    fireEvent.click(save);

    await waitFor(() => {
      expect(mocks.updateProject).toHaveBeenCalledWith("w1", "p1", {
        rca_model: "updated-model",
        rca_provider: "updated-provider",
        rca_source: "system",
      });
    });
  });

  it("shows the role error, restores the saved selection, and refreshes the workspace", async () => {
    mocks.updateProject.mockRejectedValueOnce(new ApiError(403, "Requires ADMIN role or higher"));
    const { queryClient } = renderTab();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const select = screen.getByRole("combobox", { name: "agent model" }) as HTMLSelectElement;
    const save = within(select.parentElement!).getByRole("button", { name: /^save$/i });

    fireEvent.change(select, { target: { value: "updated-model" } });
    fireEvent.click(save);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Failed to save agent model: Requires ADMIN role or higher",
    );
    expect(mocks.updateProject).toHaveBeenCalledWith("w1", "p1", {
      rca_model: "updated-model",
      rca_provider: "updated-provider",
      rca_source: "system",
    });
    expect(select.value).toBe("saved-model");
    expect(save.matches(":disabled")).toBe(true);
    expect(select.dataset.provider).toBe("saved-provider");
    expect(select.dataset.source).toBe("byok");
    expect(select.dataset.adapter).toBe("");
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["workspace", "w1"] });
  });

  it("preserves the draft when impersonation prevents saving", async () => {
    mocks.updateProject.mockRejectedValueOnce(new ImpersonationError("Read-only session"));
    const { queryClient } = renderTab();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const select = screen.getByRole("combobox", { name: "agent model" }) as HTMLSelectElement;
    const save = within(select.parentElement!).getByRole("button", { name: /^save$/i });

    fireEvent.change(select, { target: { value: "updated-model" } });
    fireEvent.click(save);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Failed to save agent model: Read-only session",
    );
    expect(select.value).toBe("updated-model");
    expect(save.matches(":disabled")).toBe(false);
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["workspace", "w1"] });
  });

  it("keeps the draft available for retry after a server error", async () => {
    mocks.updateProject.mockRejectedValueOnce(new ApiError(500, "Internal server error"));
    const { queryClient } = renderTab();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const select = screen.getByRole("combobox", { name: "agent model" }) as HTMLSelectElement;
    const save = within(select.parentElement!).getByRole("button", { name: /^save$/i });

    fireEvent.change(select, { target: { value: "updated-model" } });
    fireEvent.click(save);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Failed to save agent model: Internal server error",
    );
    expect(select.value).toBe("updated-model");
    expect(save.matches(":disabled")).toBe(false);
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["workspace", "w1"] });
  });
});

describe("DetectorsTab alert window permissions", () => {
  it("lets members view the saved selection but disables editing", () => {
    mocks.workspace.role = "MEMBER";
    renderTab();
    const select = screen.getByRole("combobox", { name: /window/i }) as HTMLSelectElement;
    const save = screen.getByRole("button", { name: /save alert window/i });

    expect(select.value).toBe("10m");
    expect(select.matches(":disabled")).toBe(true);
    expect(save.matches(":disabled")).toBe(true);
    expect(screen.getByText("Only workspace admins can change these settings.")).toBeTruthy();
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it("lets admins change and save the selection", async () => {
    renderTab();
    const select = screen.getByRole("combobox", { name: /window/i }) as HTMLSelectElement;
    const save = screen.getByRole("button", { name: /save alert window/i });
    expect(select.matches(":disabled")).toBe(false);
    expect(save.matches(":disabled")).toBe(true);
    expect(screen.queryByText(/only workspace admins/i)).toBeNull();

    fireEvent.change(select, { target: { value: "2h" } });
    expect(save.matches(":disabled")).toBe(false);
    fireEvent.click(save);

    await waitFor(() => {
      expect(mocks.updateProject).toHaveBeenCalledWith("w1", "p1", { alert_window: "2h" });
    });
  });

  it("shows the role error, restores the saved selection, and refreshes the workspace", async () => {
    mocks.updateProject.mockRejectedValueOnce(new ApiError(403, "Requires ADMIN role or higher"));
    const { queryClient } = renderTab();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const select = screen.getByRole("combobox", { name: /window/i }) as HTMLSelectElement;
    const save = screen.getByRole("button", { name: /save alert window/i });

    fireEvent.change(select, { target: { value: "2h" } });
    fireEvent.click(save);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Failed to save alert window: Requires ADMIN role or higher",
    );
    expect(mocks.updateProject).toHaveBeenCalledWith("w1", "p1", { alert_window: "2h" });
    expect(select.value).toBe("10m");
    expect(save.matches(":disabled")).toBe(true);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["workspace", "w1"] });
  });

  it("preserves the draft when impersonation prevents saving", async () => {
    mocks.updateProject.mockRejectedValueOnce(new ImpersonationError("Read-only session"));
    const { queryClient } = renderTab();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const select = screen.getByRole("combobox", { name: /window/i }) as HTMLSelectElement;
    const save = screen.getByRole("button", { name: /save alert window/i });

    fireEvent.change(select, { target: { value: "2h" } });
    fireEvent.click(save);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Failed to save alert window: Read-only session",
    );
    expect(select.value).toBe("2h");
    expect(save.matches(":disabled")).toBe(false);
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["workspace", "w1"] });
  });

  it("keeps the draft available for retry after a server error", async () => {
    mocks.updateProject.mockRejectedValueOnce(new ApiError(500, "Internal server error"));
    const { queryClient } = renderTab();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const select = screen.getByRole("combobox", { name: /window/i }) as HTMLSelectElement;
    const save = screen.getByRole("button", { name: /save alert window/i });

    fireEvent.change(select, { target: { value: "2h" } });
    fireEvent.click(save);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Failed to save alert window: Internal server error",
    );
    expect(select.value).toBe("2h");
    expect(save.matches(":disabled")).toBe(false);
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["workspace", "w1"] });
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
    const { queryClient } = renderTab();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

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
    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["workspace", "w1"],
      });
    });
  });

  it("preserves the draft when impersonation prevents saving", async () => {
    mocks.project.alert_emails = ["existing@example.com"];
    mocks.updateProject.mockRejectedValueOnce(
      new ImpersonationError("This impersonation session is read-only."),
    );
    const { queryClient } = renderTab();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    const input = screen.getByRole("textbox") as HTMLInputElement;
    const save = within(input.closest("fieldset")!).getByRole("button", { name: /^save$/i });
    fireEvent.change(input, { target: { value: "updated@example.com" } });
    fireEvent.click(save);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "This impersonation session is read-only.",
    );
    expect(input.value).toBe("updated@example.com");
    expect(save.matches(":disabled")).toBe(false);
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["workspace", "w1"],
    });
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
