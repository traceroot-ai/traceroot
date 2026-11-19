// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownView } from "./markdown-view";

describe("MarkdownView", () => {
  it("renders the inline emphasis set", () => {
    const { container } = render(
      <MarkdownView content="**bold** and *italic* and ~~struck~~ and `code`" />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("italic");
    expect(container.querySelector("del")?.textContent).toBe("struck");
    expect(container.querySelector("code")?.textContent).toBe("code");
  });

  it("renders <u> as a real underline element", () => {
    // Markdown has no underline syntax and raw HTML is not rendered, so this
    // proves the remarkUnderline plugin is wired and mapping to <u>.
    const { container } = render(<MarkdownView content="plain <u>under</u> plain" />);
    const u = container.querySelector("u");
    expect(u).not.toBeNull();
    expect(u?.textContent).toBe("under");
  });

  it("leaves an unbalanced <u> alone instead of swallowing the rest", () => {
    const { container } = render(<MarkdownView content="a <u> b" />);
    expect(container.querySelector("u")).toBeNull();
    expect(container.textContent).toContain("a");
    expect(container.textContent).toContain("b");
  });

  it("syntax-highlights a python fenced block", () => {
    const { container } = render(
      <MarkdownView content={"```py\ndef f():\n    return True\n```"} />,
    );
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain("def f():");
    expect(pre?.textContent).toContain("return True");
    // `def` is a keyword → coloured span; plain text would have no classed spans.
    const classed = Array.from(pre?.querySelectorAll("span") ?? []).filter((s) => s.className);
    expect(classed.length).toBeGreaterThan(0);
    expect(screen.getByText("py")).toBeTruthy();
  });

  it("syntax-highlights a javascript fenced block", () => {
    const { container } = render(<MarkdownView content={"```js\nconst x = null;\n```"} />);
    expect(container.querySelector("pre")?.textContent).toContain("const x = null;");
    expect(screen.getByText("js")).toBeTruthy();
  });

  it("renders an unlabelled fence as a block, not inline code", () => {
    const { container } = render(<MarkdownView content={"```\nline one\nline two\n```"} />);
    expect(container.querySelector("pre")?.textContent).toContain("line one");
  });

  it("renders gfm lists and tables", () => {
    const { container } = render(<MarkdownView content={"- a\n- b\n\n| h |\n| - |\n| c |"} />);
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("th")?.textContent).toBe("h");
  });
});
