// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({ createWorkspace: vi.fn() }));

import { CreateWorkspaceDialog } from "./CreateWorkspaceDialog";

afterEach(() => {
  cleanup();
});

describe("CreateWorkspaceDialog focus", () => {
  it("autofocuses the name input when opened", () => {
    render(<CreateWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
    const input = document.querySelector('input[placeholder="Workspace name"]');
    expect(document.activeElement).toBe(input);
  });
});
