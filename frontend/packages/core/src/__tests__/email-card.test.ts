import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  EMAIL_LOGO_PIXELS,
  EMAIL_LOGO_URL,
  emailLogoImg,
  escapeHtml,
  renderEmailCard,
} from "../lib/email-card.ts";

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

describe("emailLogoImg", () => {
  it("matches the logo file it points at", () => {
    if (process.env.NEXT_PUBLIC_LOGO_URL) return;
    // The default URL is pinned to a commit; the file is this repo's copy.
    const path = new URL(EMAIL_LOGO_URL).pathname.split("/").slice(4).join("/");
    expect(path).toBe("frontend/ui/public/images/traceroot_wordmark_email.png");
    const png = readFileSync(new URL(`../../../../../${path}`, import.meta.url));
    // A PNG's width and height are the first fields of its IHDR chunk.
    expect({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }).toEqual(
      EMAIL_LOGO_PIXELS,
    );
  });

  it("gives the image its own proportions at any height", () => {
    expect(emailLogoImg(36)).toContain('width="143" height="36"');
    expect(emailLogoImg(30)).toContain('width="119" height="30"');
    expect(emailLogoImg(30)).toMatch(/style="[^"]*height: 30px; width: auto;/);
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

  it("sizes the logo by its height, so a wordmark keeps its proportions", () => {
    const logo = renderEmailCard(params).match(/<img [^>]*alt="TraceRoot"[^>]*>/)?.[0] ?? "";

    // A fixed width as well would stretch any logo that is not exactly 143:36.
    expect(logo).toMatch(/style="[^"]*height: 36px; width: auto;/);
    // Outlook ignores that CSS and sizes the image from these.
    expect(logo).toContain('width="143" height="36"');
  });

  it("stays readable when a mail client darkens it", () => {
    const html = renderEmailCard(params);

    // Clients that honor it keep the card light.
    expect(html).toContain('<meta name="color-scheme" content="light only">');
    // Clients that darken anyway leave images alone: the default logo brings its
    // own white plate.
    if (!process.env.NEXT_PUBLIC_LOGO_URL) {
      expect(html).toContain("/images/traceroot_wordmark_email.png");
    }
    // The button's border, in its own color, turns into an outline on a dark card.
    expect(html).toMatch(/background-color: #0B1015; border: 1px solid #0B1015;/);
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
