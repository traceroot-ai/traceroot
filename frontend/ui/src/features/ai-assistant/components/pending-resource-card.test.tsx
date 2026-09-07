// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PendingResourceCard } from "./pending-resource-card";
import type { ResourceCardModel } from "../lib/resource-card";

afterEach(() => cleanup());

const detectorModel: ResourceCardModel = {
  resourceType: "detector",
  resourceId: "tc1",
  created: true,
  title: "Slow spans",
  meta: ["Detector", "Failure"],
  href: null,
  body: {
    kind: "detector",
    chips: ["sample 25%"],
    prompt: { kind: "standard", templateLabel: "Failure" },
  },
};

describe("PendingResourceCard", () => {
  it("marks the card as proposed and offers nothing to open — the resource does not exist", () => {
    render(<PendingResourceCard model={detectorModel} />);

    expect(screen.getByText("Slow spans")).toBeTruthy();
    expect(screen.getByText("Proposed · Detector · Failure")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("Reused")).toBeNull();
  });

  it("carries no decision buttons — the composer's approval bar owns the decision", () => {
    render(<PendingResourceCard model={detectorModel} />);

    expect(screen.queryByRole("button", { name: /create/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(screen.queryByText(/awaiting/i)).toBeNull();
  });

  it("shows the same body and definition the receipt will", () => {
    render(<PendingResourceCard model={detectorModel} />);

    expect(screen.getByText("Uses the standard Failure prompt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Slow spans" }));
    expect(screen.getByText("sample 25%")).toBeTruthy();
  });

  it("reveals a pending dashboard's description — all its args can offer", () => {
    const dashboardModel: ResourceCardModel = {
      resourceType: "dashboard",
      resourceId: "tc2",
      created: true,
      title: "Latency overview",
      description: "Where the time goes",
      meta: ["Dashboard"],
      href: null,
      body: { kind: "dashboard", tiles: [] },
    };
    render(<PendingResourceCard model={dashboardModel} />);

    fireEvent.click(screen.getByRole("button", { name: "Latency overview" }));
    expect(screen.getByText("Where the time goes")).toBeTruthy();
    expect(screen.getByText("Proposed · Dashboard")).toBeTruthy();
  });
});
