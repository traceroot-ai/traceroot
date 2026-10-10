import { expect, it, vi } from "vitest";

const links = vi.hoisted(() => ({
  NEXT_PUBLIC_DOCS_URL: "https://docs.example.com",
  NEXT_PUBLIC_GITHUB_REPO_URL: "https://github.com/example/repo",
}));
vi.mock("@/env.client", () => ({ clientEnv: links }));

import { LINK_STYLE as LINK } from "./copy";
import { displayFirstName, renderWelcome } from "./render";

const base = {
  firstName: "Lucas",
  unsubscribeUrl: "https://app.example.com/api/email/unsubscribe?t=abc.def&src=mail",
  appUrl: "https://app.example.com",
};
it.each([
  ["LQ", "LQ"],
  ["lucas qiu", "lucas"],
  ["  Mary-Jane O'Neil ", "Mary-Jane"],
  ["曾", null],
  ["john.doe", null],
  [null, null],
])("displayFirstName(%j) is %j", (name, expected) => {
  expect(displayFirstName(name)).toBe(expected);
});

it("renders text with the greeting, bullets and raw opt-out URL, and html with escaped name, list, code and links", () => {
  const { subject, text } = renderWelcome(base);
  expect(subject).toBe("Making the most of TraceRoot");
  expect(text.startsWith("Hi Lucas,\n")).toBe(true);
  expect(text).toContain(
    "try now:\n- Install the CLI: `npm install -g traceroot-cli` → `traceroot login`\n- Ask",
  );
  expect(text).toContain(
    `\n- Prefer a UI? The web app (${base.appUrl}) and docs (${links.NEXT_PUBLIC_DOCS_URL}) are always there\n`,
  );
  expect(text).toContain(
    "TraceRoot is open source. Don't forget to star ⭐ our repo on GitHub (https://github.com/example/repo)!",
  );
  expect(text).toContain(`hear from us again, let us know: ${base.unsubscribeUrl}`);
  expect(text).toContain("\nBest,\nThe TraceRoot Devs\n");
  expect(text).not.toContain("Discord");
  expect(renderWelcome({ ...base, firstName: null }).text.startsWith("Hi,\n")).toBe(true);
  const { html } = renderWelcome({ ...base, firstName: "<b>x" });
  expect(html).toContain("Hi &lt;b&gt;x,");
  expect(html).toContain(
    "try now:</p><ul><li>Install the CLI: <code>npm install -g traceroot-cli</code> → <code>traceroot login</code></li><li>Ask",
  );
  expect(html).toContain(
    `<li>Prefer a UI? The <a href="${base.appUrl}" ${LINK}>web app</a> and <a href="https://docs.example.com" ${LINK}>docs</a> are always there</li></ul>`,
  );
  expect(html.match(/<li>/g)).toHaveLength(3);
  expect(html).toContain(
    `<p>TraceRoot is open source. Don&#39;t forget to <a href="https://github.com/example/repo" ${LINK}>star ⭐ our repo on GitHub</a>!</p>`,
  );
  expect(html).toContain("<p>Best,<br>The TraceRoot Devs</p>");
  expect(html).not.toMatch(/\[|- |Discord/);
  expect(html).toContain(
    `<a href="${base.unsubscribeUrl.replace(/&/g, "&amp;")}" ${LINK}>let us know</a>.`,
  );
  expect(html).not.toContain("<table");
});
