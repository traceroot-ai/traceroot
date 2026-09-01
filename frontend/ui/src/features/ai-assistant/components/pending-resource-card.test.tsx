// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PendingResourceCard } from "./pending-resource-card";
import type { ResourceCardModel } from "../lib/resource-card";

afterEach(() => cleanup());

const detectorModel: ResourceCardModel = {
  resourceType: "detector",
  resourceId: "tc1",
  created: true,
  title: "Slow spans",
  meta: ["Detector", "Failure"],
  body: { kind: "detector", chips: ["template prompt"] },
};

describe("PendingResourceCard", () => {
  it("shows a pending dashboard's description — all its args can offer", () => {
    const dashboardModel: ResourceCardModel = {
      resourceType: "dashboard",
      resourceId: "tc2",
      created: true,
      title: "Latency overview",
      description: "Where the time goes",
      meta: ["Dashboard"],
      body: { kind: "dashboard", tiles: [] },
    };
    render(<PendingResourceCard model={dashboardModel} onDecide={vi.fn()} />);

    expect(screen.getByText("Latency overview")).toBeTruthy();
    expect(screen.getByText("Where the time goes")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create dashboard" })).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("shows the Phase 1 card with exactly two buttons and no status badge", () => {
    render(<PendingResourceCard model={detectorModel} onDecide={vi.fn()} />);

    expect(screen.getByText("Slow spans")).toBeTruthy();
    expect(screen.getByText("template prompt")).toBeTruthy();

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Create detector" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();

    // The buttons ARE the pending signal — no badge, no other affordances.
    expect(screen.queryByText(/awaiting/i)).toBeNull();
    expect(screen.queryByText("Reused")).toBeNull();
  });

  it("posts create and disables both buttons while the decision is in flight", async () => {
    let settle!: (value: boolean) => void;
    const onDecide = vi.fn(() => new Promise<boolean>((resolve) => (settle = resolve)));
    render(<PendingResourceCard model={detectorModel} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole("button", { name: "Create detector" }));
    expect(onDecide).toHaveBeenCalledExactlyOnceWith("create");

    const create = screen.getByRole("button", { name: "Create detector" }) as HTMLButtonElement;
    const skip = screen.getByRole("button", { name: "Skip" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(skip.disabled).toBe(true);

    // A settled decision keeps the buttons disabled — the stream replaces the card.
    settle(true);
    await waitFor(() => expect(onDecide).toHaveBeenCalledTimes(1));
    expect((screen.getByRole("button", { name: "Skip" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("posts skip and re-enables the buttons when the decision does not settle", async () => {
    const onDecide = vi.fn().mockResolvedValue(false);
    render(<PendingResourceCard model={detectorModel} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onDecide).toHaveBeenCalledExactlyOnceWith("skip");

    await waitFor(() => {
      const skip = screen.getByRole("button", { name: "Skip" }) as HTMLButtonElement;
      expect(skip.disabled).toBe(false);
    });
    const create = screen.getByRole("button", { name: "Create detector" }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
  });
});
