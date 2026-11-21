// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  mutate: vi.fn(),
  search: "",
  loop: { data: undefined as unknown, isLoading: false, error: null as Error | null },
  memory: { data: [] as unknown[], isLoading: false, error: null as Error | null },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1", loopId: "loop-1" }),
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}));
vi.mock("@/lib/hooks/use-list-return", () => ({
  useListReturnHref: (_key: string, path: string) => `${path}?page=2`,
}));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/features/loops/hooks/use-loops", () => ({
  useLoop: () => mocks.loop,
  useLoopMemory: () => mocks.memory,
  useUpdateLoop: () => ({ mutate: mocks.mutate, isPending: false, error: null }),
}));
vi.mock("@/features/loops/components/loop-form", () => ({
  LoopForm: ({
    loop,
    onSubmit,
    children,
  }: {
    loop: { name: string };
    onSubmit: (v: unknown) => void;
    children?: React.ReactNode;
  }) => (
    <div>
      {children}
      <button onClick={() => onSubmit({ dryRun: true })}>save {loop.name}</button>
    </div>
  ),
}));

import EditLoopPage from "./page";

const LOOP = {
  id: "loop-1",
  name: "Regressions",
  status: "paused_by_system",
  failureStreak: 5,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.search = "";
  mocks.loop = { data: undefined, isLoading: false, error: null };
  mocks.memory = { data: [], isLoading: false, error: null };
});

describe("Edit loop page", () => {
  it("titles the page with the loop's name, no status, and saves a patch back to the list", () => {
    mocks.loop = { data: LOOP, isLoading: false, error: null };
    render(<EditLoopPage />);
    expect(screen.getByText("Edit loop - Regressions")).toBeTruthy();
    expect(screen.queryByText("Paused by system")).toBeNull();
    fireEvent.click(screen.getByText("save Regressions"));
    expect(mocks.mutate).toHaveBeenCalledWith({ dryRun: true }, expect.any(Object));
    mocks.mutate.mock.calls[0][1].onSuccess();
    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/loops?page=2");
  });

  it("returns to the loop's page, named on the back link, when opened from it", () => {
    mocks.search = "from=detail";
    mocks.loop = { data: LOOP, isLoading: false, error: null };
    render(<EditLoopPage />);
    fireEvent.click(screen.getByText("save Regressions"));
    mocks.mutate.mock.calls[0][1].onSuccess();
    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/loops/loop-1");
    expect(screen.getByRole("link", { name: /Regressions/ }).getAttribute("href")).toBe(
      "/projects/proj-1/loops/loop-1",
    );
  });

  it("lists what the loops remember, read-only, inside the form above its actions", () => {
    const note = {
      content: "x",
      expiresAt: null,
      expired: false,
      updatedByRunId: null,
      updateTime: "2026-11-11T11:00:00Z",
    };
    mocks.loop = { data: LOOP, isLoading: false, error: null };
    mocks.memory = {
      data: [
        {
          id: "m1",
          loopId: "loop-1",
          loopName: "Regressions",
          key: "repo-conventions",
          content: "Services live under frontend/.",
          expiresAt: null,
          expired: false,
          updatedByRunId: null,
          updateTime: "2026-11-11T11:00:00Z",
        },
        { ...note, id: "m2", loopId: null, loopName: null, key: "shared-glossary" },
        { ...note, id: "m3", loopId: "loop-2", loopName: "Cost drivers", key: "other-loops-note" },
      ],
      isLoading: false,
      error: null,
    };
    render(<EditLoopPage />);
    expect(screen.getByText("Memory")).toBeTruthy();
    expect(screen.getByText("repo-conventions")).toBeTruthy();
    // Memory is the project's: every note shows, each with the loop that last wrote it.
    expect(screen.getByText("shared-glossary")).toBeTruthy();
    expect(screen.getByText("other-loops-note")).toBeTruthy();
    expect(screen.getByText("Written by Regressions")).toBeTruthy();
    expect(screen.getByText("Written by Cost drivers")).toBeTruthy();
    expect(screen.getByText("Written by a deleted loop")).toBeTruthy();
    expect(screen.getByText(/^Read-only\./)).toBeTruthy();
    // The form's actions stay the page's last element, below Memory.
    const memory = screen.getByText("Memory");
    const save = screen.getByText("save Regressions");
    expect(memory.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("reports memory that could not be read without hiding the form", () => {
    mocks.loop = { data: LOOP, isLoading: false, error: null };
    mocks.memory = { data: [], isLoading: false, error: new Error("Failed to fetch memory: 500") };
    render(<EditLoopPage />);
    expect(screen.getByText("save Regressions")).toBeTruthy();
    expect(screen.getByText("Failed to fetch memory: 500")).toBeTruthy();
  });

  it("waits while loading and reports a loop that does not exist", () => {
    mocks.loop = { data: undefined, isLoading: true, error: null };
    const { unmount } = render(<EditLoopPage />);
    expect(screen.getByText("Loading loop...")).toBeTruthy();
    unmount();
    mocks.loop = { data: undefined, isLoading: false, error: new Error("Loop not found") };
    render(<EditLoopPage />);
    expect(screen.getByText("Loop not found")).toBeTruthy();
  });
});
