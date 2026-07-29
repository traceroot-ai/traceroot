import { describe, expect, it } from "vitest";
import { escapeHtml, renderEmailCard } from "../lib/email-card.ts";

describe("escapeHtml", () => {
  it("escapes every HTML special character", () => {
    expect(escapeHtml(`Tom & Jerry <script>alert("hi")</script> it's`)).toBe(
      "Tom &amp; Jerry &lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt; it&#39;s",
    );
  });

  it("returns strings without special characters unchanged", () => {
    expect(escapeHtml("plain text 123")).toBe("plain text 123");
  });
});

describe("renderEmailCard", () => {
  const params = {
    title: "Card title",
    bodyHtml: `<tr><td><p>body row</p></td></tr>`,
    buttonLabel: "Do the thing",
    buttonUrl: "https://app.example.com/do",
    footerText: "Why you got this.",
  };

  it("renders a standalone document with every section in place", () => {
    const html = renderEmailCard(params);

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("Card title");
    expect(html).toContain("<tr><td><p>body row</p></td></tr>");
    expect(html).toContain('href="https://app.example.com/do"');
    expect(html).toContain("Do the thing");
    expect(html).toContain("Why you got this.");
    // branded logo header survives
    expect(html).toContain('alt="TraceRoot"');
  });

  it("places the body rows between the title and the button", () => {
    const html = renderEmailCard(params);
    const titleAt = html.indexOf("Card title");
    const bodyAt = html.indexOf("body row");
    const buttonAt = html.indexOf("Do the thing");
    expect(titleAt).toBeGreaterThan(-1);
    expect(bodyAt).toBeGreaterThan(titleAt);
    expect(buttonAt).toBeGreaterThan(bodyAt);
  });
});
