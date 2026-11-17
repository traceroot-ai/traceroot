import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../docs/footer.js", import.meta.url), "utf8");
const config = JSON.parse(readFileSync(new URL("../docs/docs.json", import.meta.url), "utf8"));
function harness(t, pathname = "/docs/getting-started/introduction", display = "block") {
  const accesses = [];
  const window = new EventTarget();
  Object.defineProperty(window, "posthog", {
    get() { accesses.push("SDK read"); },
    set() { accesses.push("SDK replacement"); },
  });
  Object.assign(window, {
    setTimeout() { accesses.push("timer"); return 1; },
    clearTimeout() {},
  });
  const document = Object.assign(new EventTarget(), {
    readyState: "loading",
    querySelector: () => null,
  });
  const location = { hostname: "traceroot.ai", pathname };
  vm.runInNewContext(source, {
    window, document, AbortController,
    location,
    localStorage: {
      getItem() { accesses.push("storage read"); return "denied"; },
      setItem() { accesses.push("storage write"); },
      removeItem() { accesses.push("storage removal"); },
    },
    getComputedStyle: () => ({ display }),
    ResizeObserver: class { disconnect() {} },
  });
  t.after(() => window.__trDocsFooterAdapter.dispose());
  return { window, document, location, accesses };
}

test("footer does not access analytics or consent storage", t => {
  const env = harness(t);
  env.document.dispatchEvent(new Event("DOMContentLoaded"));
  env.window.dispatchEvent(new Event("load"));
  env.window.dispatchEvent(new Event("mintlify:navigate"));
  const changed = new Event("storage");
  Object.defineProperty(changed, "key", { value: "traceroot-analytics-consent" });
  env.window.dispatchEvent(changed);
  assert.deepEqual(env.accesses, []);
});

test("missing footer styles leave native content intact without injecting enhancement markup", t => {
  const env = harness(t);
  const additions = [];
  const brand = { querySelector: () => ({}) };
  const columns = { style: { gridTemplateColumns: "repeat(2, 1fr)" } };
  const socials = { querySelector: () => ({}) };
  const row = { children: [brand, columns, socials] };
  const wrapper = { firstElementChild: row, append: node => additions.push(node) };
  const footer = { firstElementChild: wrapper };
  env.document.querySelector = () => footer;
  env.document.createElement = () => ({
    set innerHTML(_) { assert.fail("unstyled enhancement markup must not be injected"); },
    remove() { additions.splice(additions.indexOf(this), 1); },
  });
  env.window.__trDocsFooterAdapter.refresh();
  assert.equal(additions.length, 0);
  assert.deepEqual(row.children, [brand, columns, socials]);
  assert.deepEqual(env.accesses, [], "native fallback needs no analytics or readiness polling");
});

for (const prefix of ["/docs", ""]) {
  test(`the ${prefix || "/"} footer keeps its static image across guide and API navigation`, t => {
    const { window, document, location } = harness(t, `${prefix}/getting-started/introduction`, "contents");
    function element(tagName) {
      return {
        tagName, children: [], isConnected: true,
        classList: { add() {}, remove() {} }, style: { removeProperty() {} },
        append(child) { this.children.push(child); },
        remove() { this.isConnected = false; },
      };
    }
    function nativeFooter() {
      const footer = element("footer");
      const wrapper = footer.firstElementChild = element("div");
      const row = wrapper.firstElementChild = element("div");
      const columns = element("div");
      columns.style.gridTemplateColumns = "repeat(4, 1fr)";
      row.children = [element("div"), columns];
      return footer;
    }
    let footer = nativeFooter();
    document.querySelector = selector => selector.startsWith("footer#footer") ? footer : null;
    document.getElementById = () => null;
    document.createElement = element;

    function checkImage() {
      const { children } = footer.firstElementChild;
      assert.equal(children.length, 1);
      assert.deepEqual(children[0].children.map(child => [child.tagName, child.src, child.alt]), [
        ["img", `${prefix}/brand/footer-wordmark.svg?v=2`, ""],
      ]);
    }

    document.dispatchEvent(new Event("DOMContentLoaded"));
    checkImage();

    location.pathname = `${prefix}/api-reference/authentication`;
    window.dispatchEvent(new Event("mintlify:navigate"));
    checkImage();

    const previousExtras = footer.firstElementChild.children[0];
    footer = nativeFooter();
    location.pathname = `${prefix}/api-reference/alerts/list-alerts`;
    window.dispatchEvent(new Event("mintlify:navigate"));
    checkImage();
    assert.equal(previousExtras.isConnected, false);
  });
}

test("the functional primary contrasts with white and the API response surface", () => {
  const luminance = hex => {
    const channels = hex.match(/[a-f\d]{2}/gi).map(value => parseInt(value, 16) / 255);
    const [r, g, b] = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return r * 0.2126 + g * 0.7152 + b * 0.0722;
  };
  for (const background of ["#ffffff", "#f3f6f6"]) {
    const levels = [config.colors.primary, background].map(luminance).sort((a, b) => b - a);
    assert.ok((levels[0] + 0.05) / (levels[1] + 0.05) >= 4.5);
  }
});
