// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SampleTrace } from "./SampleTrace";

const { createSampleTrace, member } = vi.hoisted(() => ({
  createSampleTrace: vi.fn(),
  member: { role: "MEMBER" },
}));
vi.mock("@/lib/api/traces", () => ({ createSampleTrace }));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: { workspace_id: "ws_1" } }),
}));
vi.mock("@/features/workspaces/hooks", () => ({ useWorkspace: () => ({ data: member }) }));

afterEach(() => {
  cleanup();
  createSampleTrace.mockReset();
  member.role = "MEMBER";
});

const button = () => screen.getByRole("button") as HTMLButtonElement;

describe("SampleTrace", () => {
  it("creates the sample once and stays busy until the page opens it", async () => {
    createSampleTrace.mockResolvedValue({ trace_id: "t" });
    render(<SampleTrace projectId="proj_1" />);

    fireEvent.click(button());
    fireEvent.click(button());

    await waitFor(() => expect(createSampleTrace).toHaveBeenCalledOnce());
    expect(createSampleTrace).toHaveBeenCalledWith("proj_1");
    expect(button().disabled).toBe(true);
  });

  it("is not offered to a viewer", () => {
    member.role = "VIEWER";
    render(<SampleTrace projectId="proj_1" />);

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows why it failed and allows another try", async () => {
    createSampleTrace.mockRejectedValue(new Error("This project already has traces"));
    render(<SampleTrace projectId="proj_1" />);

    fireEvent.click(button());

    expect((await screen.findByRole("alert")).textContent).toBe("This project already has traces");
    expect(button().disabled).toBe(false);
  });
});
