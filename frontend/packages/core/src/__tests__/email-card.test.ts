import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  EMAIL_STOCK_LOGOS,
  emailLogo,
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

// Each test sets the logo it needs; a value from the environment running the tests
// would change which logo the defaults resolve to.
beforeEach(() => vi.stubEnv("NEXT_PUBLIC_LOGO_URL", ""));
afterEach(() => vi.unstubAllEnvs());

const MAIN_IMAGES =
  "https://raw.githubusercontent.com/traceroot-ai/traceroot/main/frontend/ui/public/images";

describe("emailLogo", () => {
  it.each(Object.entries(EMAIL_STOCK_LOGOS))(
    "%s matches the file its URL is pinned to",
    (_, logo) => {
      // The URL is pinned to a commit; the file is this repo's copy.
      const path = new URL(logo.url).pathname.split("/").slice(4).join("/");
      expect(path).toMatch(/^frontend\/ui\/public\/images\/traceroot_\w+_email\.png$/);
      const png = readFileSync(new URL(`../../../../../${path}`, import.meta.url));
      // A PNG's width and height are the first fields of its IHDR chunk.
      expect({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }).toEqual(logo.pixels);
    },
  );

  it("is the wordmark when no logo is configured", () => {
    expect(emailLogo()).toBe(EMAIL_STOCK_LOGOS.wordmark);
    expect(emailLogo(" ")).toBe(EMAIL_STOCK_LOGOS.wordmark);
  });

  it("draws the released chart's square icon as the square email mark", () => {
    expect(emailLogo(`${MAIN_IMAGES}/traceroot_icon.png`)).toBe(EMAIL_STOCK_LOGOS.mark);
  });

  it("draws the example config's wordmark as the email wordmark", () => {
    expect(emailLogo(`${MAIN_IMAGES}/traceroot_wordmark.png`)).toBe(EMAIL_STOCK_LOGOS.wordmark);
  });

  it("keeps a deployment's own logo as configured", () => {
    expect(emailLogo("https://cdn.acme.example/brand/logo.png")).toEqual({
      url: "https://cdn.acme.example/brand/logo.png",
    });
  });
});

describe("emailLogoImg", () => {
  it("gives a TraceRoot logo its own proportions at any height", () => {
    expect(emailLogoImg(36, EMAIL_STOCK_LOGOS.wordmark)).toContain('width="143" height="36"');
    expect(emailLogoImg(30, EMAIL_STOCK_LOGOS.wordmark)).toContain('width="119" height="30"');
    expect(emailLogoImg(36, EMAIL_STOCK_LOGOS.mark)).toContain('width="36" height="36"');
    expect(emailLogoImg(30)).toMatch(/style="[^"]*height: 30px; width: auto;/);
  });

  it("sets only the height of a custom logo, whose shape it does not know", () => {
    const img = emailLogoImg(36, { url: "https://cdn.acme.example/logo.png?v=2&size=l" });

    expect(img).toContain('src="https://cdn.acme.example/logo.png?v=2&amp;size=l"');
    expect(img).toContain(' height="36"');
    expect(img).not.toContain("width=");
    expect(img).toMatch(/style="[^"]*height: 36px; width: auto;/);
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

  describe("with the logo setting", () => {
    const logoOf = (html: string) => html.match(/<img [^>]*alt="TraceRoot"[^>]*>/)?.[0] ?? "";

    it("shows the released chart's square icon as the plated square mark", () => {
      vi.stubEnv("NEXT_PUBLIC_LOGO_URL", `${MAIN_IMAGES}/traceroot_icon.png`);
      const logo = logoOf(renderEmailCard(params));

      expect(logo).toContain(`src="${EMAIL_STOCK_LOGOS.mark.url}"`);
      expect(logo).toContain('width="36" height="36"');
    });

    it("shows a deployment's own logo as configured", () => {
      vi.stubEnv("NEXT_PUBLIC_LOGO_URL", "https://cdn.acme.example/logo.png");
      const logo = logoOf(renderEmailCard(params));

      expect(logo).toContain('src="https://cdn.acme.example/logo.png"');
      expect(logo).not.toContain("width=");
    });
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
