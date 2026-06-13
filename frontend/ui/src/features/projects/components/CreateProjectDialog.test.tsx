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

vi.mock("@/lib/api", () => ({ createProject: vi.fn() }));

import { CreateProjectDialog } from "./CreateProjectDialog";

afterEach(() => {
  cleanup();
});

describe("CreateProjectDialog focus", () => {
  it("autofocuses the name input when opened", () => {
    render(<CreateProjectDialog workspaceId="ws-1" open={true} onOpenChange={vi.fn()} />);
    const input = document.querySelector('input[placeholder="Project name"]');
    expect(document.activeElement).toBe(input);
  });
});
