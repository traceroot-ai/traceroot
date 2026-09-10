// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
}));

vi.mock("@/features/projects/components", () => ({
  ProjectBreadcrumb: () => null,
}));

vi.mock("@/features/alerts/components/alert-form", () => ({
  AlertForm: ({ projectId }: { projectId: string }) => <div data-testid="form">{projectId}</div>,
}));

import NewAlertPage from "./page";

describe("NewAlertPage", () => {
  afterEach(cleanup);

  it("renders the page header", () => {
    render(<NewAlertPage />);
    expect(screen.getByRole("heading", { name: "New Alert" })).toBeTruthy();
  });

  it("renders the form with the route's project id", () => {
    render(<NewAlertPage />);
    expect(screen.getByTestId("form").textContent).toBe("proj-1");
  });

  it("links back to the project's alerts list", () => {
    render(<NewAlertPage />);
    const backLink = screen.getByRole("link", { name: "Alerts" });
    expect(backLink.getAttribute("href")).toBe("/projects/proj-1/alerts");
  });
});
