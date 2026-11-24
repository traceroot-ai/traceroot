// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { deleteProjectLabel, listProjectLabels } from "@/features/labels/api";
import { LabelsTab } from "./LabelsTab";

let role = "MEMBER";
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: { workspace_id: "workspace" } }),
}));
vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspace: () => ({ data: { role } }),
}));
vi.mock("@/features/labels/api", () => ({
  listProjectLabels: vi.fn(),
  deleteProjectLabel: vi.fn(),
}));

const savedLabel = { id: "label-1", name: "Needs review", description: null };

function renderLabelsTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LabelsTab projectId="project-1" />
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  role = "MEMBER";
});

it("warns before deleting and refreshes only the affected project's label and trace data", async () => {
  vi.mocked(listProjectLabels).mockResolvedValueOnce([savedLabel]).mockResolvedValue([]);
  vi.mocked(deleteProjectLabel).mockResolvedValue(undefined);
  const client = renderLabelsTab();
  const targetKey = ["trace-labels", "project-1", "trace-1", "span-1"];
  const listKey = ["traces", "project-1", 1];
  const otherProjectKey = ["trace-labels", "project-2", "trace-2", null];
  client.setQueryData(targetKey, { values: [savedLabel.name], appliedByMe: [savedLabel.name] });
  client.setQueryData(listKey, []);
  client.setQueryData(otherProjectKey, []);

  const trigger = await screen.findByRole("button", { name: "Delete Needs review" });
  fireEvent.click(trigger);
  let dialog = screen.getByRole("dialog", { name: "Delete label" });
  expect(dialog.textContent).toContain("every trace and span where it was applied");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(deleteProjectLabel).not.toHaveBeenCalled();

  fireEvent.click(trigger);
  dialog = screen.getByRole("dialog", { name: "Delete label" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete label" })).toBeNull());
  expect(screen.queryByText(savedLabel.name)).toBeNull();
  expect(deleteProjectLabel).toHaveBeenCalledExactlyOnceWith("project-1", savedLabel.id);
  expect(client.getQueryState(targetKey)?.isInvalidated).toBe(true);
  expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
  expect(client.getQueryState(otherProjectKey)?.isInvalidated).toBe(false);
});

it("lets a viewer see the labels with no delete action", async () => {
  role = "VIEWER";
  vi.mocked(listProjectLabels).mockResolvedValue([savedLabel]);
  renderLabelsTab();
  expect(await screen.findByText(savedLabel.name)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Delete Needs review" })).toBeNull();
});
