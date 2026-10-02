// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  isError: false,
}));
vi.mock("../hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks")>();
  return {
    rcaInProgress: actual.rcaInProgress,
    useRequestSignalRca: () => ({
      mutate: mocks.mutate,
      isPending: mocks.isPending,
      isError: mocks.isError,
    }),
  };
});

import { RunRca } from "./run-rca";

afterEach(() => {
  cleanup();
  mocks.mutate.mockReset();
  mocks.isPending = false;
  mocks.isError = false;
});

const button = () => screen.getByRole("button");

describe("RunRca", () => {
  it("runs the analysis of a signal that has none", () => {
    render(<RunRca projectId="p1" signalId="s1" state={null} />);
    expect(button().textContent).toBe("Run root cause analysis");
    fireEvent.click(button());
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });

  it("shows a running analysis and cannot start another", () => {
    render(<RunRca projectId="p1" signalId="s1" state="pending" />);
    expect(screen.getByText("Analyzing affected traces…")).toBeTruthy();
    expect(button().textContent).toBe("Running…");
    expect((button() as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers a retry after a failed analysis", () => {
    render(<RunRca projectId="p1" signalId="s1" state="failed" />);
    expect(screen.getByText("The last analysis failed.")).toBeTruthy();
    expect(button().textContent).toBe("Run root cause analysis");
  });

  it("says when the request could not start the analysis", () => {
    mocks.isError = true;
    render(<RunRca projectId="p1" signalId="s1" state={null} />);
    expect(screen.getByRole("alert").textContent).toBe(
      "Analysis could not start. Please try again.",
    );
  });
});
