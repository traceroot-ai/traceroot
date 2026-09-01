// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ResourceCard } from "./resource-card";
import type { ResourceCardModel } from "../lib/resource-card";

afterEach(cleanup);

function model(overrides: Partial<ResourceCardModel> = {}): ResourceCardModel {
  return {
    resourceType: "widget",
    resourceId: "w1",
    created: true,
    title: "Tokens by model",
    meta: ["Widget"],
    body: { kind: "widget", chips: ["view spans", "sum(total_tokens)"] },
    ...overrides,
  };
}

describe("ResourceCard", () => {
  it("heads a created resource with its name, meta line and a created badge", () => {
    render(<ResourceCard model={model()} />);
    expect(screen.getByText("Tokens by model")).toBeTruthy();
    expect(screen.getByText("Widget")).toBeTruthy();
    expect(screen.getByText("Created")).toBeTruthy();
  });

  it("says a resource was reused rather than created", () => {
    render(<ResourceCard model={model({ created: false })} />);
    expect(screen.getByText("Reused")).toBeTruthy();
    expect(screen.queryByText("Created")).toBeNull();
  });

  it("carries no status badge or action button beyond the receipt itself", () => {
    const { container } = render(<ResourceCard model={model()} />);
    expect(container.querySelectorAll("button").length).toBe(0);
    expect(container.textContent).not.toContain("Awaiting");
  });

  it("joins the meta parts into one line", () => {
    render(<ResourceCard model={model({ meta: ["Dashboard", "2 widgets"] })} />);
    expect(screen.getByText("Dashboard · 2 widgets")).toBeTruthy();
  });

  it("renders a widget's spec chips", () => {
    render(<ResourceCard model={model()} />);
    expect(screen.getByText("view spans")).toBeTruthy();
    expect(screen.getByText("sum(total_tokens)")).toBeTruthy();
  });

  it("renders a detector's chips", () => {
    render(
      <ResourceCard
        model={model({
          resourceType: "detector",
          title: "Timeout failures",
          meta: ["Detector", "Failure"],
          body: { kind: "detector", chips: ["template prompt", "RCA on"] },
        })}
      />,
    );
    expect(screen.getByText("template prompt")).toBeTruthy();
    expect(screen.getByText("RCA on")).toBeTruthy();
  });

  it("renders a project receipt as label/value rows", () => {
    render(
      <ResourceCard
        model={model({
          resourceType: "project",
          title: "checkout-service",
          meta: ["Project"],
          body: {
            kind: "receipt",
            rows: [
              { label: "workspace", value: "ws1" },
              { label: "id", value: "p9" },
            ],
          },
        })}
      />,
    );
    expect(screen.getByText("workspace")).toBeTruthy();
    expect(screen.getByText("id")).toBeTruthy();
    expect(screen.getByText("p9")).toBeTruthy();
  });

  it("renders a dashboard as a header-only card until its miniature exists", () => {
    const { container } = render(
      <ResourceCard
        model={model({
          resourceType: "dashboard",
          title: "Latency overview",
          meta: ["Dashboard", "2 widgets"],
          body: { kind: "dashboard" },
        })}
      />,
    );
    expect(screen.getByText("Latency overview")).toBeTruthy();
    expect(container.textContent).toBe("Latency overviewCreatedDashboard · 2 widgets");
  });

  it("renders a body-less card when the arguments left nothing to show", () => {
    const { container } = render(
      <ResourceCard model={model({ title: "w1", body: { kind: "widget", chips: [] } })} />,
    );
    expect(container.textContent).toBe("w1CreatedWidget");
    expect(container.textContent).not.toContain("[object Object]");
  });

  it("does not print an empty receipt", () => {
    const { container } = render(
      <ResourceCard
        model={model({ resourceType: "project", body: { kind: "receipt", rows: [] } })}
      />,
    );
    expect(container.querySelectorAll("dl").length).toBe(0);
  });

  it("lets a long title and a long chip wrap instead of widening the card", () => {
    const { container } = render(
      <ResourceCard
        model={model({
          title: "A dashboard title long enough to need more than one line in a narrow panel",
          body: { kind: "widget", chips: ["by an_extremely_long_breakdown_dimension_name"] },
        })}
      />,
    );
    const title = screen.getByText(/A dashboard title long enough/);
    expect(title.className).toContain("break-words");
    const chip = screen.getByText("by an_extremely_long_breakdown_dimension_name");
    expect(chip.className).toContain("whitespace-normal");
    expect(container.firstElementChild?.className).toContain("max-w-full");
  });
});
