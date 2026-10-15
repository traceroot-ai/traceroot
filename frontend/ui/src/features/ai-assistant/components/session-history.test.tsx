// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SessionHistory } from "./session-history";
import { DEMO_EXAMPLE_SESSION } from "../lib/demo-agent-example";

afterEach(cleanup);

it("keeps the example selectable alongside RCA history and never exposes its delete action", () => {
  const example = { ...DEMO_EXAMPLE_SESSION, projectId: "demo" };
  const rca = {
    id: "rca",
    title: "RCA investigation",
    projectId: "demo",
    status: "completed",
    createTime: new Date().toISOString(),
  };
  const onSelect = vi.fn();
  const { rerender, container } = render(
    <SessionHistory
      sessions={[example, rca]}
      currentSessionId="rca"
      projectId="demo"
      onSelect={onSelect}
      onDelete={vi.fn()}
      readOnly
    />,
  );
  expect(screen.getByText("Example sessions")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: example.title! }));
  expect(onSelect).toHaveBeenLastCalledWith(example);
  rerender(
    <SessionHistory
      sessions={[example, rca]}
      currentSessionId={example.id}
      projectId="demo"
      onSelect={onSelect}
      onDelete={vi.fn()}
      readOnly
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "RCA investigation" }));
  expect(onSelect).toHaveBeenLastCalledWith(rca);
  expect(container.querySelector(".lucide-trash2")).toBeNull();
  rerender(
    <SessionHistory
      sessions={[example, rca]}
      currentSessionId={example.id}
      projectId="demo"
      onSelect={onSelect}
      onDelete={vi.fn()}
    />,
  );
  expect(container.querySelectorAll(".lucide-trash2")).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: example.title! }).querySelector(".lucide-trash2"),
  ).toBeNull();
});
