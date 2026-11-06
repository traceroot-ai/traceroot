import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../docs/footer.js", import.meta.url), "utf8");
const config = JSON.parse(readFileSync(new URL("../docs/docs.json", import.meta.url), "utf8"));
const key = "traceroot-analytics-consent";

function harness(t, choice = "denied") {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const storage = new Map(choice == null ? [] : [[key, choice]]);
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), {
    readyState: "loading",
    documentElement: { classList: { contains: () => false } },
    querySelector: () => null,
  });
  let scheduled = 0;
  const schedule = (callback, delay) => { scheduled++; return setTimeout(callback, delay); };
  Object.assign(window, { setTimeout: schedule, clearTimeout });
  vm.runInNewContext(source, {
    window, document, AbortController,
    location: { hostname: "localhost" },
    localStorage: { getItem: name => storage.get(name) ?? null },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: schedule,
    clearTimeout,
  });
  t.after(() => window.__trDocsFooterAdapter.dispose());
  return {
    window,
    storage,
    get scheduled() { return scheduled; },
    load() { window.dispatchEvent(new Event("load")); },
    changed() {
      const event = new Event("storage");
      Object.defineProperty(event, "key", { value: key });
      window.dispatchEvent(event);
    },
    advance(milliseconds) {
      for (let left = milliseconds; left > 0; left -= 50) t.mock.timers.tick(Math.min(50, left));
    },
  };
}

function visitor({ token = config.integrations.posthog.apiKey, optedOut = false } = {}) {
  const calls = { reads: 0, in: 0, out: 0 };
  return {
    calls,
    sdk: {
      get_config(name) { calls.reads++; return name === "token" ? token : undefined; },
      has_opted_out_capturing: () => optedOut,
      opt_out_capturing() { optedOut = true; calls.out++; },
      opt_in_capturing() { optedOut = false; calls.in++; },
    },
  };
}

test("a matching SDK appearing after load receives the saved denial without navigation", t => {
  const env = harness(t);
  env.load();
  env.advance(1500);
  const sdk = visitor();
  env.window.posthog = sdk.sdk;
  env.advance(10000);
  assert.equal(sdk.calls.out, 1);
  env.advance(60000);
  assert.equal(sdk.calls.reads, 1, "a successful synchronization stops retrying");
  assert.equal(sdk.calls.in, 0);
});

test("consent synchronization does not depend on mounting the footer", t => {
  const env = harness(t);
  const sdk = visitor();
  env.window.posthog = sdk.sdk;
  env.advance(1000);
  assert.equal(sdk.calls.out, 1);
});

test("unknown projects are untouched and retries stop when no matching SDK appears", t => {
  const env = harness(t);
  const other = visitor({ token: "another-project" });
  env.window.posthog = other.sdk;
  env.load();
  env.advance(60000);
  assert.ok(other.calls.reads > 1);
  assert.equal(other.calls.out, 0);
  assert.equal(other.calls.in, 0);
  const reads = other.calls.reads;
  env.advance(60000);
  assert.equal(other.calls.reads, reads);
  const matching = visitor();
  env.window.posthog = matching.sdk;
  env.changed();
  assert.equal(matching.calls.out, 1, "a later lifecycle event can synchronize again");
});

test("load, navigation and storage share one retry chain", t => {
  const env = harness(t);
  const other = visitor({ token: "another-project" });
  env.window.posthog = other.sdk;
  env.load();
  env.window.dispatchEvent(new Event("mintlify:navigate"));
  env.changed();
  env.changed();
  const matching = visitor();
  env.window.posthog = matching.sdk;
  env.advance(1000);
  assert.equal(matching.calls.reads, 1);
  assert.equal(matching.calls.out, 1);
});

test("each retry uses the latest preference and explicit allowance is applied once", t => {
  const env = harness(t);
  env.load();
  env.advance(1000);
  env.storage.set(key, "allowed");
  const sdk = visitor({ optedOut: true });
  env.window.posthog = sdk.sdk;
  env.advance(1000);
  env.changed();
  assert.equal(sdk.calls.in, 1);
  assert.equal(sdk.calls.out, 0);
});

test("clearing a saved choice stops retries without changing SDK consent", t => {
  const env = harness(t);
  env.load();
  env.storage.delete(key);
  env.changed();
  const sdk = visitor();
  env.window.posthog = sdk.sdk;
  env.advance(60000);
  assert.equal(sdk.calls.reads, 0);
});

test("no valid preference means no consent timer or SDK calls", t => {
  const env = harness(t, "invalid");
  const sdk = visitor();
  env.window.posthog = sdk.sdk;
  env.load();
  env.changed();
  env.advance(60000);
  assert.equal(env.scheduled, 0);
  assert.equal(sdk.calls.reads, 0);
});

test("an absent preference starts no consent probes", t => {
  const env = harness(t, null);
  const sdk = visitor();
  env.window.posthog = sdk.sdk;
  env.load();
  env.advance(60000);
  assert.equal(env.scheduled, 0);
  assert.equal(sdk.calls.reads, 0);
});

test("an SDK that is not fully initialized can recover within the retry window", t => {
  const env = harness(t);
  const sdk = visitor();
  let ready = false;
  env.window.posthog = { ...sdk.sdk, has_opted_out_capturing() {
    if (!ready) throw new Error("SDK is initializing");
    return sdk.sdk.has_opted_out_capturing();
  } };
  env.load();
  ready = true;
  env.advance(1000);
  assert.equal(sdk.calls.out, 1);
});

test("disposal cancels retry work and removes lifecycle listeners", t => {
  const env = harness(t);
  env.load();
  env.window.__trDocsFooterAdapter.dispose();
  const sdk = visitor();
  env.window.posthog = sdk.sdk;
  env.changed();
  env.advance(60000);
  assert.equal(sdk.calls.reads, 0);
});

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
