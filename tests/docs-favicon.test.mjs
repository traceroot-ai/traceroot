import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../docs/favicon.js", import.meta.url), "utf8");

function link(rel, href, sizes) {
  return { rel, href, sizes, dataset: {}, removed: false, remove() { this.removed = true; } };
}

function run(pathname, links) {
  const head = {
    links,
    querySelectorAll: () => head.links.filter(l => !l.removed && /(^|\s)icon(\s|$)/.test(l.rel) && l.dataset.trFavicon === undefined),
    querySelector: () => head.links.find(l => !l.removed && l.dataset.trFavicon !== undefined) ?? null,
    append(node) { head.links.push(node); },
  };
  let observed = null;
  vm.runInNewContext(source, {
    location: { pathname },
    document: {
      head,
      createElement: () => ({ dataset: {}, setAttribute(name, value) { this[name] = value; } }),
    },
    MutationObserver: class { constructor(cb) { observed = cb; } observe() {} },
  });
  return { head, rerender: () => observed() };
}

test("declares only the website's 192px favicon under the /docs base path", () => {
  const generated = [
    link("icon", "/docs/_generated/favicon-16x16.png", "16x16"),
    link("icon", "/docs/_generated/favicon-32x32.png", "32x32"),
    link("shortcut icon", "/docs/_generated/favicon.ico"),
  ];
  const touch = link("apple-touch-icon", "/docs/_generated/apple-touch-icon.png", "180x180");
  const { head } = run("/docs/getting-started/introduction", [...generated, touch]);

  assert.ok(generated.every(l => l.removed));
  assert.equal(touch.removed, false);
  const ours = head.links.filter(l => !l.removed && l.dataset.trFavicon !== undefined);
  assert.equal(ours.length, 1);
  assert.equal(ours[0].href, "/docs/logo/favicon.png");
  assert.equal(ours[0].sizes, "192x192");
});

test("uses the root path in local preview and re-prunes after a re-render", () => {
  const { head, rerender } = run("/getting-started/introduction", []);
  assert.equal(head.links.find(l => l.dataset.trFavicon !== undefined).href, "/logo/favicon.png");

  const reinserted = link("icon", "/_generated/favicon-16x16.png", "16x16");
  head.links.push(reinserted);
  rerender();
  assert.equal(reinserted.removed, true);
  assert.equal(head.links.filter(l => !l.removed && l.dataset.trFavicon !== undefined).length, 1);
});
