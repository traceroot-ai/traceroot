// @vitest-environment jsdom
/**
 * Coverage for the offline-eval code helpers: the value formatters (YAML / text
 * / JSON / pretty / markdown), the line-numbered editable field with its JSON
 * tokenizer and collapse control, and the read-only / editable value blocks.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import {
  LineNumberedTextarea,
  ValueBlock,
  EditableValueBlock,
  formatValue,
  seedFormat,
} from "./code";

beforeAll(() => {
  // Radix popovers measure their trigger; jsdom has no layout engine.
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

afterEach(() => cleanup());

describe("formatValue — yaml", () => {
  it("renders empty values as null", () => {
    expect(formatValue(null, "yaml")).toBe("null");
    expect(formatValue(undefined, "yaml")).toBe("null");
    expect(formatValue("", "yaml")).toBe("null");
  });

  it("renders a single-line string inline", () => {
    expect(formatValue("hello", "yaml")).toBe("hello");
  });

  it("renders a multi-line string as a block scalar", () => {
    expect(formatValue("a\nb", "yaml")).toBe("|\n  a\n  b");
  });

  it("renders numbers and booleans directly", () => {
    expect(formatValue(42, "yaml")).toBe("42");
    expect(formatValue(true, "yaml")).toBe("true");
  });

  it("renders arrays as dashed items and an empty array as []", () => {
    expect(formatValue(["a", "b"], "yaml")).toBe("- a\n- b");
    expect(formatValue([], "yaml")).toBe("[]");
  });

  it("renders objects as key: value pairs and an empty object as null", () => {
    expect(formatValue({ a: 1, b: "x" }, "yaml")).toBe("a: 1\nb: x");
    expect(formatValue({}, "yaml")).toBe("null");
  });
});

describe("formatValue — other kinds", () => {
  it("passes markdown through verbatim", () => {
    expect(formatValue("# hi", "markdown")).toBe("# hi");
    expect(formatValue(null, "markdown")).toBe("");
    expect(formatValue(undefined, "markdown")).toBe("");
    expect(formatValue({ a: 1 }, "markdown")).toBe('{"a":1}');
  });

  it("renders text, using the literal null for empty values", () => {
    expect(formatValue("hi", "text")).toBe("hi");
    expect(formatValue("", "text")).toBe("null");
    expect(formatValue(null, "text")).toBe("null");
    expect(formatValue({ a: 1 }, "text")).toBe('{"a":1}');
  });

  it("renders compact and pretty JSON", () => {
    expect(formatValue({ a: 1 }, "json")).toBe('{"a":1}');
    expect(formatValue(undefined, "json")).toBe("null");
    expect(formatValue({ a: 1 }, "pretty")).toBe('{\n  "a": 1\n}');
  });
});

describe("seedFormat", () => {
  it("leaves non-JSON text alone", () => {
    expect(seedFormat("just text", "expanded")).toEqual({ kind: "text", text: "just text" });
    expect(seedFormat("", "compact")).toEqual({ kind: "text", text: "" });
  });

  it("falls back to text for something that only looks like JSON", () => {
    expect(seedFormat("{not json", "compact")).toEqual({ kind: "text", text: "{not json" });
  });

  it("keeps a small flat object on one line when compact is preferred", () => {
    expect(seedFormat('{"a": 1}', "compact")).toEqual({ kind: "json", text: '{"a":1}' });
  });

  it("expands a nested value even when compact is preferred", () => {
    const out = seedFormat('{"a":{"b":1}}', "compact");
    expect(out.kind).toBe("pretty");
  });

  it("expands a long value even when compact is preferred", () => {
    const long = JSON.stringify({ a: "x".repeat(200) });
    expect(seedFormat(long, "compact").kind).toBe("pretty");
  });

  it("always expands when expanded is preferred", () => {
    expect(seedFormat('{"a":1}', "expanded")).toEqual({
      kind: "pretty",
      text: '{\n  "a": 1\n}',
    });
  });
});

describe("LineNumberedTextarea", () => {
  it("numbers each line and pads to minRows", () => {
    render(<LineNumberedTextarea value={"a"} onChange={vi.fn()} minRows={4} aria-label="field" />);
    expect(screen.getByText("4")).toBeTruthy();
  });

  it("reports the typed value verbatim, preserving a genuine trailing newline", () => {
    const onChange = vi.fn();
    render(<LineNumberedTextarea value="a" onChange={onChange} aria-label="field" />);
    // Controlled to the raw value (no artificial trailing \n to strip), so input is reported
    // verbatim — a real newline stays, and multi-char input never stacks one character per line.
    fireEvent.change(screen.getByLabelText("field"), { target: { value: "abc\n" } });
    expect(onChange).toHaveBeenCalledWith("abc\n");
  });

  it("keeps a value that does not end in a newline", () => {
    const onChange = vi.fn();
    render(<LineNumberedTextarea value="a" onChange={onChange} aria-label="field" />);
    fireEvent.change(screen.getByLabelText("field"), { target: { value: "abc" } });
    expect(onChange).toHaveBeenCalledWith("abc");
  });

  it("ignores edits while read-only", () => {
    const onChange = vi.fn();
    render(<LineNumberedTextarea value="a" onChange={onChange} readOnly aria-label="field" />);
    fireEvent.change(screen.getByLabelText("field"), { target: { value: "abc" } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders a placeholder", () => {
    render(
      <LineNumberedTextarea
        value=""
        onChange={vi.fn()}
        placeholder="type here"
        aria-label="field"
      />,
    );
    expect(screen.getByPlaceholderText("type here")).toBeTruthy();
  });

  it("colours JSON tokens when highlighting is on", () => {
    const json = '{"a": "s", "b": 1, "c": true, "d": false, "e": null, "f": [1,-2.5e3]}';
    const { container } = render(
      <LineNumberedTextarea value={json} onChange={vi.fn()} highlightJson aria-label="field" />,
    );
    const classes = Array.from(container.querySelectorAll("span"))
      .map((s) => s.className)
      .join(" ");
    expect(classes).toContain("text-sky-600"); // keys
    expect(classes).toContain("text-green-700"); // strings
    expect(classes).toContain("text-blue-600"); // numbers
    expect(classes).toContain("text-purple-600"); // booleans
    expect(classes).toContain("text-orange-600"); // null
  });

  it("handles escaped quotes inside a highlighted string", () => {
    const { container } = render(
      <LineNumberedTextarea
        value={'{"a": "he said \\"hi\\""}'}
        onChange={vi.fn()}
        highlightJson
        aria-label="field"
      />,
    );
    expect(container.textContent).toContain("he said");
  });

  it("falls back to plain text when the content is not valid JSON", () => {
    const { container } = render(
      <LineNumberedTextarea value="not json" onChange={vi.fn()} highlightJson aria-label="field" />,
    );
    expect(container.textContent).toContain("not json");
  });

  it("treats empty content as unhighlightable", () => {
    const { container } = render(
      <LineNumberedTextarea value="" onChange={vi.fn()} highlightJson aria-label="field" />,
    );
    expect(container.querySelector("textarea")).toBeTruthy();
  });

  it("clips a long value behind an inline expand control", () => {
    const onExpand = vi.fn();
    const long = "x".repeat(600);
    render(
      <LineNumberedTextarea
        value={long}
        onChange={vi.fn()}
        collapsed
        collapseAt={500}
        onExpand={onExpand}
        aria-label="field"
      />,
    );
    // No editable overlay while collapsed, so the inline control stays clickable.
    expect(screen.queryByLabelText("field")).toBeNull();
    fireEvent.click(screen.getByText(/…expand \(100 more characters\)/));
    expect(onExpand).toHaveBeenCalled();
  });

  it("does not collapse a value under the threshold", () => {
    render(
      <LineNumberedTextarea
        value="short"
        onChange={vi.fn()}
        collapsed
        collapseAt={500}
        aria-label="field"
      />,
    );
    expect(screen.getByLabelText("field")).toBeTruthy();
  });

  it("falls back to the label when no aria-label is given", () => {
    const { container } = render(<LineNumberedTextarea value="a" onChange={vi.fn()} />);
    expect(container.querySelector("textarea")).toBeTruthy();
  });
});

describe("ValueBlock", () => {
  it("renders the label and the default YAML view", () => {
    render(<ValueBlock label="Input" value={{ a: 1 }} />);
    expect(screen.getByText("Input")).toBeTruthy();
    expect(screen.getByText("YAML")).toBeTruthy();
    expect(screen.getByText("a: 1")).toBeTruthy();
  });

  it("switches to another format from the popover", async () => {
    render(<ValueBlock label="Input" value={{ a: 1 }} />);
    fireEvent.click(screen.getByText("YAML"));
    fireEvent.click(await screen.findByRole("button", { name: "Pretty" }));
    expect(screen.getByText("Pretty")).toBeTruthy();
  });

  it("renders markdown through the markdown view", async () => {
    render(<ValueBlock label="Output" value={"# Heading"} defaultKind="markdown" />);
    expect(screen.getByText("Heading").tagName).toBe("H1");
  });

  it("renders an empty value as a single numbered line", () => {
    render(<ValueBlock label="Meta" value={null} defaultKind="text" />);
    expect(screen.getByText("null")).toBeTruthy();
  });
});

describe("EditableValueBlock", () => {
  function Editable(props: Partial<React.ComponentProps<typeof EditableValueBlock>> = {}) {
    const [text, setText] = React.useState((props.text as string) ?? "hello");
    return (
      <EditableValueBlock
        label="Input"
        formatSwitcher
        {...props}
        text={text}
        onChange={(t) => {
          setText(t);
          props.onChange?.(t);
        }}
      />
    );
  }

  it("edits through the line-numbered field", () => {
    const onChange = vi.fn();
    render(<Editable onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Input"), { target: { value: "world" } });
    expect(onChange).toHaveBeenCalledWith("world");
  });

  it("uses an explicit aria-label when given", () => {
    render(<Editable ariaLabel="Expected output" />);
    expect(screen.getByLabelText("Expected output")).toBeTruthy();
  });

  it("collapses and expands via the heading chevron", () => {
    render(<Editable />);
    const heading = screen.getByRole("button", { name: "Input" });
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(heading);
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("Input")).toBeNull();
    fireEvent.click(heading);
    expect(screen.getByLabelText("Input")).toBeTruthy();
  });

  it("renders the boxed chrome variant", () => {
    const { container } = render(<Editable boxed />);
    expect(container.querySelector(".rounded-md.border")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Input" })).toBeTruthy();
  });

  it("shows a copy button when copyable", () => {
    render(<Editable copyable />);
    expect(screen.getByTitle("Copy")).toBeTruthy();
  });

  it("auto-detects pretty JSON from multi-line content", () => {
    render(<Editable text={'{\n  "a": 1\n}'} autoDetectKind />);
    expect(screen.getByText("Pretty")).toBeTruthy();
  });

  it("auto-detects compact JSON from single-line content", () => {
    render(<Editable text={'{"a":1}'} autoDetectKind />);
    expect(screen.getByText("JSON")).toBeTruthy();
  });

  it("auto-detects text for something that only looks like JSON", () => {
    render(<Editable text={"{not json"} autoDetectKind />);
    expect(screen.getByText("Text")).toBeTruthy();
  });

  it("seeds and normalises the value per field role", () => {
    const onChange = vi.fn();
    render(<Editable text={'{"a":1}'} seedJson="expanded" onChange={onChange} />);
    expect(screen.getByText("Pretty")).toBeTruthy();
    expect(onChange).toHaveBeenCalledWith('{\n  "a": 1\n}');
  });

  it("seeds a read-only field without touching the parent value", () => {
    const onChange = vi.fn();
    render(
      <EditableValueBlock
        label="Input"
        text={'{"a":1}'}
        onChange={onChange}
        seedJson="expanded"
        formatSwitcher
        readOnly
      />,
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("Pretty")).toBeTruthy();
  });

  it("reformats JSON when the user picks another format", async () => {
    const onChange = vi.fn();
    render(<Editable text={'{"a":1}'} onChange={onChange} />);
    fireEvent.click(screen.getByText("YAML"));
    fireEvent.click(await screen.findByRole("button", { name: "Pretty" }));
    expect(onChange).toHaveBeenCalledWith('{\n  "a": 1\n}');
  });

  it("leaves non-JSON text as typed when the format changes", async () => {
    const onChange = vi.fn();
    render(<Editable text="plain text" onChange={onChange} />);
    fireEvent.click(screen.getByText("YAML"));
    fireEvent.click(await screen.findByRole("button", { name: "JSON" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("JSON")).toBeTruthy();
  });

  it("reformats a read-only field locally", async () => {
    const onChange = vi.fn();
    render(
      <EditableValueBlock
        label="Input"
        text={'{"a":1}'}
        onChange={onChange}
        formatSwitcher
        readOnly
      />,
    );
    fireEvent.click(screen.getByText("YAML"));
    fireEvent.click(await screen.findByRole("button", { name: "Pretty" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Input")).toBeTruthy();
  });

  it("switches to markdown without rewriting the stored value", async () => {
    const onChange = vi.fn();
    render(<Editable text={"# Heading"} onChange={onChange} />);
    fireEvent.click(screen.getByText("YAML"));
    fireEvent.click(await screen.findByRole("button", { name: "Markdown" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("Heading").tagName).toBe("H1");
    expect(screen.getByText(/Preview — switch to Text to edit/)).toBeTruthy();
  });

  it("hides the preview hint on a read-only markdown field", () => {
    render(
      <EditableValueBlock
        label="Input"
        text={"# Heading"}
        onChange={vi.fn()}
        defaultKind="markdown"
        readOnly
      />,
    );
    expect(screen.queryByText(/Preview — switch to Text to edit/)).toBeNull();
  });

  it("clips a long collapsible value and expands it in place", () => {
    const long = "x".repeat(700);
    render(<Editable text={long} collapsible />);
    expect(screen.queryByLabelText("Input")).toBeNull();
    fireEvent.click(screen.getByText(/…expand \(200 more characters\)/));
    expect(screen.getByLabelText("Input")).toBeTruthy();
  });

  it("clips a long collapsible markdown value behind its own expand control", () => {
    const long = `# Heading\n\n${"word ".repeat(200)}`;
    render(
      <EditableValueBlock
        label="Input"
        text={long}
        onChange={vi.fn()}
        defaultKind="markdown"
        collapsible
      />,
    );
    const expand = screen.getByText(/…expand \(\d+ more characters\)/);
    fireEvent.click(expand);
    expect(screen.queryByText(/…expand \(/)).toBeNull();
  });

  it("re-collapses when the reset key changes", () => {
    const long = "x".repeat(700);
    const { rerender } = render(
      <EditableValueBlock
        label="Input"
        text={long}
        onChange={vi.fn()}
        collapsible
        collapseResetKey="span-1"
      />,
    );
    fireEvent.click(screen.getByText(/…expand/));
    expect(screen.getByLabelText("Input")).toBeTruthy();
    rerender(
      <EditableValueBlock
        label="Input"
        text={long}
        onChange={vi.fn()}
        collapsible
        collapseResetKey="span-2"
      />,
    );
    expect(screen.queryByLabelText("Input")).toBeNull();
  });

  it("leaves an empty value unseeded", () => {
    const onChange = vi.fn();
    render(<Editable text="" seedJson="compact" onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stops seeding once the user pins a format", async () => {
    const onChange = vi.fn();
    render(<Editable text={'{"a":1}'} autoDetectKind onChange={onChange} />);
    fireEvent.click(screen.getByText("JSON"));
    fireEvent.click(await screen.findByRole("button", { name: "Text" }));
    expect(screen.getByText("Text")).toBeTruthy();
  });
});
