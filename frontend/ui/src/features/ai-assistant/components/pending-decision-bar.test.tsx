// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PendingDecisionBar } from "./pending-decision-bar";
import type { PendingDecision } from "../hooks/use-ai-chat";

afterEach(cleanup);

const decision: PendingDecision = {
  toolCallId: "tc1",
  decisionId: "d1",
  resourceType: "detector",
  title: "Slow spans",
  action: "create",
  approvalClass: "confirm",
};

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("PendingDecisionBar", () => {
  it("asks about the proposed resource by type and title, with create, skip and a revise hint", () => {
    render(<PendingDecisionBar decision={decision} onDecide={vi.fn()} />);

    expect(screen.getByText(/Create detector/, { selector: "p" }).textContent).toBe(
      "Create detector Slow spans?",
    );
    expect(button("Create detector")).toBeTruthy();
    expect(button("Skip")).toBeTruthy();
    expect(screen.getByText("or reply below to revise")).toBeTruthy();
  });

  it("posts create with the parked call's ids and disables both buttons while in flight", async () => {
    let settle!: (value: boolean) => void;
    const onDecide = vi.fn(() => new Promise<boolean>((resolve) => (settle = resolve)));
    render(<PendingDecisionBar decision={decision} onDecide={onDecide} />);

    fireEvent.click(button("Create detector"));
    expect(onDecide).toHaveBeenCalledExactlyOnceWith({
      toolCallId: "tc1",
      decisionId: "d1",
      action: "create",
    });
    expect(button("Create detector").disabled).toBe(true);
    expect(button("Skip").disabled).toBe(true);
    // The spinner sits in the clicked button only.
    expect(button("Create detector").querySelector(".animate-spin")).not.toBeNull();
    expect(button("Skip").querySelector(".animate-spin")).toBeNull();

    // A second click while in flight is swallowed.
    fireEvent.click(button("Skip"));
    expect(onDecide).toHaveBeenCalledTimes(1);

    // A settled decision keeps the buttons disabled — the stream replaces the bar.
    await act(async () => {
      settle(true);
    });
    expect(button("Create detector").disabled).toBe(true);
    expect(button("Skip").disabled).toBe(true);
  });

  it("asks by type alone when the proposal carries no name", () => {
    render(<PendingDecisionBar decision={{ ...decision, title: null }} onDecide={vi.fn()} />);

    expect(screen.getByText(/Create detector/, { selector: "p" }).textContent).toBe(
      "Create detector?",
    );
    expect(button("Create detector")).toBeTruthy();
  });

  it("posts skip and re-enables the buttons when the decision does not settle", async () => {
    const onDecide = vi.fn().mockResolvedValue(false);
    render(<PendingDecisionBar decision={decision} onDecide={onDecide} />);

    fireEvent.click(button("Skip"));
    expect(onDecide).toHaveBeenCalledExactlyOnceWith({
      toolCallId: "tc1",
      decisionId: "d1",
      action: "skip",
    });

    await waitFor(() => expect(button("Skip").disabled).toBe(false));
    expect(button("Create detector").disabled).toBe(false);
    expect(button("Skip").querySelector(".animate-spin")).toBeNull();
  });

  it("re-enables the buttons when the decision throws", async () => {
    const onDecide = vi.fn().mockRejectedValue(new Error("network down"));
    render(<PendingDecisionBar decision={decision} onDecide={onDecide} />);

    fireEvent.click(button("Create detector"));
    await waitFor(() => expect(button("Create detector").disabled).toBe(false));
  });
});

describe("PendingDecisionBar — updates and deletes", () => {
  it("asks about an update with an Update button and still offers to revise by typing", () => {
    render(
      <PendingDecisionBar
        decision={{ ...decision, action: "update", title: "Timeouts" }}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText(/Update detector/, { selector: "p" }).textContent).toBe(
      "Update detector Timeouts?",
    );
    expect(button("Update detector")).toBeTruthy();
    expect(button("Skip")).toBeTruthy();
    expect(screen.getByText("or reply below to revise")).toBeTruthy();
    expect(button("Update detector").className).not.toContain("destructive");
  });

  it("asks about a delete with a destructive Delete button and no revise hint — typing skips", () => {
    const onDecide = vi.fn().mockResolvedValue(true);
    render(
      <PendingDecisionBar
        decision={{ ...decision, action: "delete", approvalClass: "approval", title: "Timeouts" }}
        onDecide={onDecide}
      />,
    );
    expect(screen.getByText(/Delete detector/, { selector: "p" }).textContent).toBe(
      "Delete detector Timeouts?",
    );
    expect(button("Delete detector").className).toContain("destructive");
    expect(screen.queryByText("or reply below to revise")).toBeNull();
    expect(screen.getByText("a reply below skips it")).toBeTruthy();

    // The Delete button still posts the proceed action the decisions route takes.
    fireEvent.click(button("Delete detector"));
    expect(onDecide).toHaveBeenCalledExactlyOnceWith({
      toolCallId: "tc1",
      decisionId: "d1",
      action: "create",
    });
  });
});
