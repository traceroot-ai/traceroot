// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

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

  it("clears the composer as soon as a send is accepted", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<MessageInput onSend={onSend} modelSelection={PICK} onModelChange={vi.fn()} />);
    const textarea = screen.getByPlaceholderText(/ask me about/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "ship it" } });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter" });
    });
    expect(textarea.value).toBe("");
  });

  it("puts the text back when the send is refused, instead of eating it", async () => {
    // A proposal mid-decision refuses the send. The user's words must survive
    // that: no bubble, no error and no text is the product losing what they
    // typed.
    const onSend = vi.fn().mockResolvedValue(false);
    render(<MessageInput onSend={onSend} modelSelection={PICK} onModelChange={vi.fn()} />);
    const textarea = screen.getByPlaceholderText(/ask me about/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "use p99 instead" } });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter" });
    });
    expect(onSend).toHaveBeenCalledWith("use p99 instead", PICK);
    expect(textarea.value).toBe("use p99 instead");
  });

  it("keeps what the user retyped while a refused send was in flight", async () => {
    let settle: (v: boolean) => void = () => {};
    const onSend = vi.fn().mockReturnValue(
      new Promise<boolean>((resolve) => {
        settle = resolve;
      }),
    );
    render(<MessageInput onSend={onSend} modelSelection={PICK} onModelChange={vi.fn()} />);
    const textarea = screen.getByPlaceholderText(/ask me about/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "first" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.change(textarea, { target: { value: "second thoughts" } });
    await act(async () => {
      settle(false);
    });
    expect(textarea.value).toBe("second thoughts");
  });

  it("does not leak an unhandled rejection when the send fails", async () => {
    // onSend is invoked without being awaited, so a rejection that escapes here
    // becomes an unhandled rejection rather than a failed send.
    const onSend = vi.fn().mockRejectedValue(new Error("network down"));
    render(<MessageInput onSend={onSend} modelSelection={PICK} onModelChange={vi.fn()} />);
    const textarea = screen.getByPlaceholderText(/ask me about/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "will fail" } });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter" });
    });
    expect(onSend).toHaveBeenCalled();
    expect(textarea.value).toBe("");
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
