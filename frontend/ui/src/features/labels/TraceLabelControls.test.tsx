// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TraceLabelChips, TraceLabelPicker } from "./TraceLabelControls";
import { getTraceLabels, setTraceLabel } from "./api";

vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: { workspace_id: "workspace" } }),
}));
vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspace: () => ({ data: { role: "MEMBER" } }),
}));
vi.mock("./api", () => ({
  listProjectLabels: async () => [
    { id: "1", name: "Retry needed", description: "Internal label description" },
    { id: "2", name: "Investigate", description: null },
  ],
  getTraceLabels: vi.fn(),
  setTraceLabel: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("removes only the current person's annotation and keeps a shared chip", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const remaining = { values: ["Retry needed"], appliedByMe: [] };
  vi.mocked(getTraceLabels)
    .mockResolvedValueOnce({ values: ["Retry needed"], appliedByMe: ["Retry needed"] })
    .mockResolvedValue(remaining);
  vi.mocked(setTraceLabel).mockResolvedValue(remaining);

  const target = { projectId: "proj", traceId: "trace", spanId: "span" };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const traceListKey = ["traces", "proj", 1];
  client.setQueryData(traceListKey, []);
  render(
    <QueryClientProvider client={client}>
      <TraceLabelPicker {...target} />
      <TraceLabelChips {...target} />
    </QueryClientProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Add label" }));
  const picker = screen.getByRole("dialog", { name: "Add label" });
  expect(picker.contains(document.activeElement)).toBe(true);
  const applied = await within(picker).findByRole("checkbox", { name: "Retry needed" });
  expect((applied as HTMLInputElement).checked).toBe(true);
  fireEvent.change(within(picker).getByRole("textbox", { name: "Search labels" }), {
    target: { value: "retry" },
  });
  expect(within(picker).queryByRole("checkbox", { name: "Investigate" })).toBeNull();
  expect(within(picker).queryByText("Internal label description")).toBeNull();

  fireEvent.click(applied);
  await waitFor(() => expect((applied as HTMLInputElement).checked).toBe(false));
  expect(setTraceLabel).toHaveBeenCalledWith("proj", "trace", "span", "Retry needed", false);
  expect(client.getQueryState(traceListKey)?.isInvalidated).toBe(true);
  expect(
    within(screen.getByRole("group", { name: "Labels" })).getByText("Retry needed"),
  ).toBeTruthy();
});
