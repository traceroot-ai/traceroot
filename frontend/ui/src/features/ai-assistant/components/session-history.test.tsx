// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/lib/utils", () => ({ cn: (...args: string[]) => args.filter(Boolean).join(" ") }));

import { SessionHistory } from "./session-history";
import type { AISession } from "../types";

const session: AISession = {
  id: "sess-1",
  title: "Test session",
  createTime: new Date().toISOString(),
  projectId: "proj-1",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SessionHistory — canDelete prop", () => {
  it("shows the delete icon when canDelete is true (default)", () => {
    render(
      <SessionHistory
        sessions={[session]}
        currentSessionId={null}
        projectId="proj-1"
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(document.querySelector("svg + svg, span + svg")).toBeTruthy();
  });

  it("hides the delete icon when canDelete is false", () => {
    const { container } = render(
      <SessionHistory
        sessions={[session]}
        currentSessionId={null}
        projectId="proj-1"
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        canDelete={false}
      />,
    );
    // Only one svg renders (MessageSquare); Trash2 is absent
    const svgs = container.querySelectorAll("button svg");
    expect(svgs).toHaveLength(1);
  });
});

describe("SessionHistory — delete error handling", () => {
  it("shows error message when DELETE returns 403", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "Requires ADMIN role or higher" }),
    } as Response);

    const { container } = render(
      <SessionHistory
        sessions={[session]}
        currentSessionId={null}
        projectId="proj-1"
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        canDelete={true}
      />,
    );

    const trashIcon = container.querySelector("button svg:last-child") as SVGElement;
    fireEvent.click(trashIcon, { bubbles: true });

    await waitFor(() => {
      expect(screen.getByText("Requires ADMIN role or higher")).toBeTruthy();
    });
  });

  it("shows generic error message when DELETE throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

    const { container } = render(
      <SessionHistory
        sessions={[session]}
        currentSessionId={null}
        projectId="proj-1"
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        canDelete={true}
      />,
    );

    const trashIcon = container.querySelector("button svg:last-child") as SVGElement;
    fireEvent.click(trashIcon, { bubbles: true });

    await waitFor(() => {
      expect(screen.getByText("Failed to delete session")).toBeTruthy();
    });
  });
});
