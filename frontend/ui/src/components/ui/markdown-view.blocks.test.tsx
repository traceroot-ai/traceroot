// @vitest-environment jsdom
/**
 * Block-level coverage for MarkdownView's component map — headings, lists,
 * quotes, rules, links and tables. Complements markdown-view.test.tsx, which
 * covers inline emphasis, underline and fenced-code highlighting.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownView } from "./markdown-view";

describe("MarkdownView block elements", () => {
  it("renders every heading level", () => {
    const { container } = render(
      <MarkdownView content={"# h1\n\n## h2\n\n### h3\n\n#### h4\n\n##### h5\n\n###### h6"} />,
    );
    for (const level of [1, 2, 3, 4, 5, 6]) {
      expect(container.querySelector(`h${level}`)?.textContent).toBe(`h${level}`);
    }
  });

  it("renders paragraphs", () => {
    const { container } = render(<MarkdownView content={"one\n\ntwo"} />);
    expect(container.querySelectorAll("p")).toHaveLength(2);
  });

  it("renders ordered and unordered lists", () => {
    const { container } = render(<MarkdownView content={"1. one\n2. two\n\n- a\n- b"} />);
    expect(container.querySelector("ol")).not.toBeNull();
    expect(container.querySelector("ul")).not.toBeNull();
    expect(container.querySelectorAll("li")).toHaveLength(4);
  });

  it("renders blockquotes and horizontal rules", () => {
    const { container } = render(<MarkdownView content={"> quoted\n\n---\n"} />);
    expect(container.querySelector("blockquote")?.textContent).toContain("quoted");
    expect(container.querySelector("hr")).not.toBeNull();
  });

  it("renders links that open in a new tab safely", () => {
    const { container } = render(<MarkdownView content="[docs](https://example.com)" />);
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://example.com");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toContain("noopener");
  });

  it("renders table headers and body cells", () => {
    const { container } = render(<MarkdownView content={"| a | b |\n| - | - |\n| 1 | 2 |"} />);
    expect(container.querySelectorAll("th")).toHaveLength(2);
    expect(container.querySelectorAll("td")).toHaveLength(2);
    expect(container.querySelector("td")?.textContent).toBe("1");
  });

  it("renders inline code and inline emphasis", () => {
    const { container } = render(<MarkdownView content="**b** *i* ~~s~~ `inline`" />);
    expect(container.querySelector("strong")?.textContent).toBe("b");
    expect(container.querySelector("em")?.textContent).toBe("i");
    expect(container.querySelector("del")?.textContent).toBe("s");
    expect(container.querySelector("code")?.textContent).toBe("inline");
  });

  it("renders a labelled fenced block with its language chip", () => {
    const { container } = render(<MarkdownView content={"```python\nx = 1\n```"} />);
    expect(screen.getByText("python")).toBeTruthy();
    expect(container.querySelector("pre")?.textContent).toContain("x = 1");
  });

  it("renders an unlabelled fence without a language chip", () => {
    const { container } = render(<MarkdownView content={"```\nraw\n```"} />);
    expect(container.querySelector("pre")?.textContent).toContain("raw");
    expect(container.querySelectorAll("pre")).toHaveLength(1);
  });

  it("accepts an extra class name on the wrapper", () => {
    const { container } = render(<MarkdownView content="hi" className="mt-4" />);
    expect((container.firstElementChild as HTMLElement).className).toContain("mt-4");
  });

  it("renders an empty document without crashing", () => {
    const { container } = render(<MarkdownView content="" />);
    expect(container.textContent).toBe("");
  });
});
