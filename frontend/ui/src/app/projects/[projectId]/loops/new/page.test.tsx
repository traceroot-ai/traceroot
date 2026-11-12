// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  mutate: vi.fn(),
  error: null as Error | null,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/features/loops/hooks/use-loops", () => ({
  useCreateLoop: () => ({ mutate: mocks.mutate, isPending: false, error: mocks.error }),
}));
vi.mock("@/features/loops/components/loop-form", () => ({
  LoopForm: ({
    onSubmit,
    onCancel,
    error,
  }: {
    onSubmit: (v: unknown) => void;
    onCancel: () => void;
    error: Error | null;
  }) => (
    <>
      <button onClick={() => onSubmit({ name: "L" })}>submit</button>
      <button onClick={onCancel}>cancel</button>
      {error && <span>{error.message}</span>}
    </>
  ),
}));

import NewLoopPage from "./page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.error = null;
});

describe("New Loop page", () => {
  it("creates, then returns to the list on success", () => {
    render(<NewLoopPage />);
    fireEvent.click(screen.getByText("submit"));
    expect(mocks.mutate).toHaveBeenCalledWith(
      { name: "L" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    mocks.mutate.mock.calls[0][1].onSuccess();
    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/loops");
  });

  it("goes back to the list on cancel and passes the failure to the form", () => {
    mocks.error = new Error("A project can have at most 5 Loops");
    render(<NewLoopPage />);
    expect(screen.getByText("A project can have at most 5 Loops")).toBeTruthy();
    fireEvent.click(screen.getByText("cancel"));
    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/loops");
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});
