// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  mutate: vi.fn(),
  loop: { data: undefined as unknown, isLoading: false, error: null as Error | null },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1", loopId: "loop-1" }),
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/features/loops/hooks/use-loops", () => ({
  useLoop: () => mocks.loop,
  useUpdateLoop: () => ({ mutate: mocks.mutate, isPending: false, error: null }),
}));
vi.mock("@/features/loops/components/loop-form", () => ({
  LoopForm: ({ loop, onSubmit }: { loop: { name: string }; onSubmit: (v: unknown) => void }) => (
    <button onClick={() => onSubmit({ dryRun: true })}>save {loop.name}</button>
  ),
}));

import EditLoopPage from "./page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.loop = { data: undefined, isLoading: false, error: null };
});

describe("Edit Loop page", () => {
  it("shows the Loop's name and status, and saves a patch for that Loop", () => {
    mocks.loop = {
      data: {
        id: "loop-1",
        name: "Regressions",
        status: "paused_by_system",
        pauseReason: "failures",
        failureStreak: 5,
      },
      isLoading: false,
      error: null,
    };
    render(<EditLoopPage />);
    expect(screen.getByText("Edit Regressions")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Paused by system" })).toBeTruthy();
    fireEvent.click(screen.getByText("save Regressions"));
    expect(mocks.mutate).toHaveBeenCalledWith({ dryRun: true }, expect.any(Object));
    mocks.mutate.mock.calls[0][1].onSuccess();
    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/loops");
  });

  it("waits while loading and reports a Loop that does not exist", () => {
    mocks.loop = { data: undefined, isLoading: true, error: null };
    const { unmount } = render(<EditLoopPage />);
    expect(screen.getByText("Loading Loop...")).toBeTruthy();
    unmount();
    mocks.loop = { data: undefined, isLoading: false, error: new Error("Loop not found") };
    render(<EditLoopPage />);
    expect(screen.getByText("Loop not found")).toBeTruthy();
  });
});
