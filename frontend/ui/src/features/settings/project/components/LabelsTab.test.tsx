// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fetchNextApi } from "@/lib/api/client";
import { LabelsTab } from "./LabelsTab";

let role = "MEMBER";
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: { workspace_id: "workspace" } }),
}));
vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspace: () => ({ data: { role } }),
}));
vi.mock("@/lib/api/client", () => ({ fetchNextApi: vi.fn() }));

const savedLabel = { id: "label-1", name: "Needs review", description: null };
const labelsPath = "/projects/project-1/labels";
const labelPath = `${labelsPath}/${savedLabel.id}`;

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
  vi.mocked(fetchNextApi)
    .mockResolvedValueOnce({ labels: [savedLabel] })
    .mockResolvedValueOnce(undefined)
    .mockResolvedValue({ labels: [] });
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
  expect(fetchNextApi).not.toHaveBeenCalledWith(labelPath, { method: "DELETE" });

  fireEvent.click(trigger);
  dialog = screen.getByRole("dialog", { name: "Delete label" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete label" })).toBeNull());
  expect(screen.queryByText(savedLabel.name)).toBeNull();
  expect(
    vi.mocked(fetchNextApi).mock.calls.filter(([, options]) => options?.method === "DELETE"),
  ).toEqual([[labelPath, { method: "DELETE" }]]);
  expect(client.getQueryState(targetKey)?.isInvalidated).toBe(true);
  expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
  expect(client.getQueryState(otherProjectKey)?.isInvalidated).toBe(false);
});

it("lets a viewer see the labels with no delete action", async () => {
  role = "VIEWER";
  vi.mocked(fetchNextApi).mockResolvedValue({ labels: [savedLabel] });
  renderLabelsTab();
  expect(await screen.findByText(savedLabel.name)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Delete Needs review" })).toBeNull();
});

it("creates a label and edits its description through the project API", async () => {
  vi.mocked(fetchNextApi)
    .mockResolvedValueOnce({ labels: [] })
    .mockResolvedValueOnce({ label: savedLabel })
    .mockResolvedValueOnce({ labels: [savedLabel] })
    .mockResolvedValueOnce({ label: { ...savedLabel, description: "Updated" } })
    .mockResolvedValue({ labels: [{ ...savedLabel, description: "Updated" }] });
  renderLabelsTab();
  expect(await screen.findByText("No project labels yet.")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Create label" }));
  const create = screen.getByRole("dialog", { name: "Create label" });
  const createButton = within(create).getByRole<HTMLButtonElement>("button", { name: "Create" });
  expect(createButton.disabled).toBe(true);
  fireEvent.change(within(create).getByRole("textbox", { name: "Name" }), {
    target: { value: " Needs review " },
  });
  fireEvent.click(createButton);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create label" })).toBeNull());
  expect(fetchNextApi).toHaveBeenCalledWith(labelsPath, {
    method: "POST",
    body: '{"name":"Needs review"}',
  });

  fireEvent.click(screen.getByRole("button", { name: "Edit Needs review" }));
  const edit = screen.getByRole("dialog", { name: "Edit label" });
  expect(within(edit).getByRole<HTMLInputElement>("textbox", { name: "Name" }).readOnly).toBe(true);
  fireEvent.change(within(edit).getByRole("textbox", { name: /Description/ }), {
    target: { value: " Updated " },
  });
  fireEvent.click(within(edit).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit label" })).toBeNull());
  expect(fetchNextApi).toHaveBeenCalledWith(labelPath, {
    method: "PATCH",
    body: '{"description":"Updated"}',
  });
});
