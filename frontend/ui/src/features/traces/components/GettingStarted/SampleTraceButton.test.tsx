// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const pushMock = vi.fn();
const createSampleTraceMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("@/lib/api", () => ({
  createSampleTrace: (...args: unknown[]) => createSampleTraceMock(...args),
}));

import { SampleTraceButton } from "./SampleTraceButton";

function renderButton() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <SampleTraceButton projectId="proj-1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  pushMock.mockReset();
  createSampleTraceMock.mockReset();
});

describe("SampleTraceButton", () => {
  it("creates a sample trace and opens it", async () => {
    createSampleTraceMock.mockResolvedValue({ trace_id: "trace-1", span_count: 4 });

    renderButton();
    fireEvent.click(screen.getByRole("button", { name: "Create sample trace" }));

    await waitFor(() => {
      expect(createSampleTraceMock).toHaveBeenCalledWith("proj-1");
    });
    expect(pushMock).toHaveBeenCalledWith("/projects/proj-1/traces?traceId=trace-1&fullscreen=1");
  });

  it("shows an error when sample trace creation fails", async () => {
    createSampleTraceMock.mockRejectedValue(new Error("boom"));

    renderButton();
    fireEvent.click(screen.getByRole("button", { name: "Create sample trace" }));

    expect(
      await screen.findByText("Couldn't create the sample trace. Please try again."),
    ).toBeTruthy();
  });
});
