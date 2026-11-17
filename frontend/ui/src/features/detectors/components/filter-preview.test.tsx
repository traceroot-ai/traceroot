// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FormEvent } from "react";
import { ApiError } from "@/lib/api/errors";

const mockFetchTraceApi = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", () => ({ fetchTraceApi: mockFetchTraceApi }));

import { FilterPreview } from "./filter-preview";

afterEach(() => {
  cleanup();
  mockFetchTraceApi.mockReset();
});

it("previews normalized draft conditions without submitting the detector form", async () => {
  mockFetchTraceApi.mockResolvedValue({
    trace_id: "trace-1",
    matches: false,
    condition_matches: [true, false],
  });
  const submit = vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault());
  render(
    <form onSubmit={submit}>
      <FilterPreview
        projectId="project-1"
        conditions={[
          { field: "cost", op: ">", value: "0.5" },
          { field: "errors", op: "=", value: 0 },
        ]}
      />
    </form>,
  );
  fireEvent.change(screen.getByLabelText("Trace ID to preview"), {
    target: { value: " trace-1 " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));

  await waitFor(() => expect(screen.getByText("Filter does not match this trace")).toBeTruthy());
  expect(screen.getByText("Condition 1: matches")).toBeTruthy();
  expect(screen.getByText("Condition 2: does not match")).toBeTruthy();
  expect(submit).not.toHaveBeenCalled();
  expect(mockFetchTraceApi).toHaveBeenCalledWith(
    "/projects/project-1/detectors/preview",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        trace_id: "trace-1",
        conditions: [
          { field: "cost", op: ">", value: 0.5 },
          { field: "errors", op: "=", value: 0 },
        ],
      }),
    }),
  );
});

it("clears a result when the draft conditions change", async () => {
  mockFetchTraceApi.mockResolvedValue({
    trace_id: "trace-1",
    matches: true,
    condition_matches: [true],
  });
  const { rerender } = render(
    <FilterPreview projectId="project-1" conditions={[{ field: "cost", op: ">", value: 1 }]} />,
  );
  fireEvent.change(screen.getByLabelText("Trace ID to preview"), { target: { value: "trace-1" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  await waitFor(() => expect(screen.getByText("Filter matches this trace")).toBeTruthy());

  rerender(
    <FilterPreview projectId="project-1" conditions={[{ field: "cost", op: ">", value: 2 }]} />,
  );
  expect(screen.queryByText("Filter matches this trace")).toBeNull();
  rerender(
    <FilterPreview projectId="project-1" conditions={[{ field: "cost", op: ">", value: 1 }]} />,
  );
  expect(screen.queryByText("Filter matches this trace")).toBeNull();
});

it("aborts a pending preview when the draft changes", async () => {
  let resolveRequest!: (value: unknown) => void;
  mockFetchTraceApi.mockReturnValue(new Promise((resolve) => (resolveRequest = resolve)));
  const { rerender } = render(
    <FilterPreview projectId="project-1" conditions={[{ field: "cost", op: ">", value: 1 }]} />,
  );
  fireEvent.change(screen.getByLabelText("Trace ID to preview"), { target: { value: "trace-1" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  const signal = mockFetchTraceApi.mock.calls[0][1].signal as AbortSignal;

  rerender(
    <FilterPreview projectId="project-1" conditions={[{ field: "cost", op: ">", value: 2 }]} />,
  );
  await waitFor(() => expect(signal.aborted).toBe(true));
  resolveRequest({ trace_id: "trace-1", matches: true, condition_matches: [true] });
  rerender(
    <FilterPreview projectId="project-1" conditions={[{ field: "cost", op: ">", value: 1 }]} />,
  );
  expect(screen.queryByText("Filter matches this trace")).toBeNull();
});

it("uses Enter for preview without submitting the new-detector form", async () => {
  mockFetchTraceApi.mockResolvedValue({
    trace_id: "trace-1",
    matches: true,
    condition_matches: [],
  });
  const submit = vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault());
  render(
    <form onSubmit={submit}>
      <FilterPreview projectId="project-1" conditions={[]} />
      <button type="submit">Create detector</button>
    </form>,
  );
  const input = screen.getByLabelText("Trace ID to preview");
  fireEvent.change(input, { target: { value: "trace-1" } });
  expect(fireEvent.keyDown(input, { key: "Enter", code: "Enter" })).toBe(false);
  await waitFor(() => expect(mockFetchTraceApi).toHaveBeenCalledOnce());
  expect(submit).not.toHaveBeenCalled();
});

it("does not request a preview for an incomplete filter", () => {
  render(
    <FilterPreview projectId="project-1" conditions={[{ field: "cost", op: ">", value: "" }]} />,
  );
  fireEvent.change(screen.getByLabelText("Trace ID to preview"), { target: { value: "trace-1" } });
  expect(screen.getByRole("button", { name: "Preview" }).hasAttribute("disabled")).toBe(true);
  expect(mockFetchTraceApi).not.toHaveBeenCalled();
});

it("explains when a trace is not in the project", async () => {
  mockFetchTraceApi.mockRejectedValue(new ApiError(404, "Trace not found"));
  render(<FilterPreview projectId="project-1" conditions={[]} />);
  fireEvent.change(screen.getByLabelText("Trace ID to preview"), { target: { value: "missing" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe("Trace not found in this project."),
  );
});
