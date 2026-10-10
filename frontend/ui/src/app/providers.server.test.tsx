// @vitest-environment node
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { Providers } from "./providers";

// next-themes writes the nonce only when rendering on the server (the browser
// hides nonces once a page loads), so this renders the tree the way the server does.
describe("Providers on the server", () => {
  it("gives next-themes' inline theme script the page's nonce", () => {
    const html = renderToString(
      <Providers nonce="test-nonce">
        <div />
      </Providers>,
    );
    expect(html).toMatch(/<script[^>]*nonce="test-nonce"/);
  });
});
