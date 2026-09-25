// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1", alertId: "alert-9" }),
}));

vi.mock("@/features/alerts/components/edit-alert-page", () => ({
  EditAlertPage: ({ projectId, alertId }: { projectId: string; alertId: string }) => (
    <div data-testid="edit-page">{`${projectId}/${alertId}`}</div>
  ),
}));

import AlertRoute from "./page";

describe("the route an alert is edited from", () => {
  afterEach(cleanup);

  it("opens the edit page on the route's own alert", () => {
    render(<AlertRoute />);

    expect(screen.getByTestId("edit-page").textContent).toBe("proj-1/alert-9");
  });
});
