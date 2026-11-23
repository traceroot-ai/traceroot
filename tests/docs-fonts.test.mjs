import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const docs = new URL("../docs/", import.meta.url);
const css = readFileSync(new URL("brand/fonts.css", docs), "utf8");

for (const family of ["Geist", "Geist Mono"]) {
  test(`${family} embeds the vendored font without an asset request`, () => {
    const face = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)]
      .map((match) => match[1])
      .find((rule) => rule.includes(`font-family: "${family}";`));
    assert.ok(face, `${family} font face is missing`);
    assert.equal([...face.matchAll(/(?:^|;)\s*src\s*:/g)].length, 1);
    const source = face.match(
      /(?:^|;)\s*src\s*:\s*url\("data:font\/woff2;base64,([A-Za-z0-9+/=]+)"\)\s+format\("woff2"\)\s*;/,
    );
    assert.ok(source, `${family} must load without root-relative or CDN paths`);
    assert.match(face, /font-weight:\s*100 900;/);
    assert.match(face, /font-display:\s*swap;/);
  });
}
