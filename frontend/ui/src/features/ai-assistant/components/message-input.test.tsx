// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("./model-selector", () => ({
  ModelSelector: ({ value }: { value: { model: string } }) => (
    <div data-testid="selector">{value.model || "none"}</div>
  ),
}));

import { MessageInput } from "./message-input";

const PICK = { model: "kimi-k3", provider: "Moonshot", source: "byok" as const, adapter: "openai" };
const EMPTY = { model: "", provider: "", source: "system" as const, adapter: "" };

afterEach(cleanup);

describe("MessageInput", () => {
  it("is controlled by the selection it is given and sends with it", () => {
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} modelSelection={PICK} onModelChange={vi.fn()} />);
    expect(screen.getByTestId("selector").textContent).toBe("kimi-k3");

    const textarea = screen.getByPlaceholderText(/ask me about/i);
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("hello", PICK);
  });

  it("disables input until a model is selected", () => {
    render(<MessageInput onSend={vi.fn()} modelSelection={EMPTY} onModelChange={vi.fn()} />);
    expect((screen.getByPlaceholderText(/ask me about/i) as HTMLTextAreaElement).disabled).toBe(
      true,
    );
  });

  it("shows a custom placeholder when one is provided", () => {
    render(
      <MessageInput
        onSend={vi.fn()}
        modelSelection={PICK}
        onModelChange={vi.fn()}
        placeholder="Reply to revise, or use the buttons"
      />,
    );
    expect(screen.getByPlaceholderText("Reply to revise, or use the buttons")).not.toBeNull();
  });
});
