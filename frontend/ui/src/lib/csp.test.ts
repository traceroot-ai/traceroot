import { describe, expect, it } from "vitest";
// Next.js finds the nonce for its own scripts by parsing the request's policy
// with this helper, so the test checks the policy the way Next.js reads it.
import { getScriptNonceFromHeader } from "next/dist/server/app-render/get-script-nonce-from-header";

import { mediaSrc } from "@/features/traces/components/inline-media";

import {
  buildContentSecurityPolicy,
  cspHeaderName,
  CSP_REPORT_ENDPOINT,
  CSP_REPORT_PATH,
  REPORTING_ENDPOINTS,
} from "./csp";

const NONCE = Buffer.from("8a5f1c2e-4b6d-4f80-9a1e-3c7d2b5e6f01").toString("base64");

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split("; ").map((directive) => {
      const [name, ...sources] = directive.split(" ");
      return [name, sources];
    }),
  );
}

describe("buildContentSecurityPolicy", () => {
  it("trusts scripts by nonce and what they load, with no eval in production", () => {
    const policy = buildContentSecurityPolicy({ nonce: NONCE });
    expect(directives(policy).get("script-src")).toEqual([
      "'self'",
      `'nonce-${NONCE}'`,
      "'strict-dynamic'",
    ]);
    expect(getScriptNonceFromHeader(policy)).toBe(NONCE);
  });

  it("keeps inline styles and gives style-src no nonce, which would void 'unsafe-inline'", () => {
    const policy = buildContentSecurityPolicy({ nonce: NONCE });
    expect(directives(policy).get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it("locks down plugins, base URLs, form targets and framing, and reports violations", () => {
    const parsed = directives(buildContentSecurityPolicy({ nonce: NONCE }));
    expect(parsed.get("default-src")).toEqual(["'self'"]);
    expect(parsed.get("img-src")).toEqual(["'self'", "data:", "blob:"]);
    expect(parsed.get("object-src")).toEqual(["'none'"]);
    expect(parsed.get("base-uri")).toEqual(["'self'"]);
    expect(parsed.get("form-action")).toEqual(["'self'"]);
    expect(parsed.get("frame-ancestors")).toEqual(["'none'"]);
    expect(parsed.get("report-uri")).toEqual([CSP_REPORT_PATH]);
  });

  it("plays the trace viewer's inline audio, which it loads from data: URIs", () => {
    // 100 characters of base64 that start with an ID3 tag: the shortest value
    // inline-media.tsx turns into an <audio> player.
    const audio = mediaSrc(`SUQz${"A".repeat(96)}`);
    expect(audio).toEqual({ kind: "audio", src: expect.stringMatching(/^data:audio\//) });

    const policy = buildContentSecurityPolicy({ nonce: NONCE });
    expect(directives(policy).get("media-src")).toEqual(["'self'", "data:", "blob:"]);
  });

  it("reports through report-to as well as report-uri on a page served over HTTPS", () => {
    const parsed = directives(buildContentSecurityPolicy({ nonce: NONCE, https: true }));
    expect(parsed.get("report-uri")).toEqual([CSP_REPORT_PATH]);
    expect(parsed.get("report-to")).toEqual([CSP_REPORT_ENDPOINT]);
    expect(REPORTING_ENDPOINTS).toBe('csp-endpoint="/api/csp-report"');
  });

  it("reports only through report-uri over plain HTTP, where report-to would send nothing", () => {
    // The app URL plays no part: an app configured with an HTTPS URL can still be
    // reached over plain HTTP.
    for (const options of [
      {},
      { https: false },
      { https: false, appUrl: "https://app.example.com" },
    ]) {
      const parsed = directives(buildContentSecurityPolicy({ nonce: NONCE, ...options }));
      expect(parsed.get("report-uri")).toEqual([CSP_REPORT_PATH]);
      expect(parsed.has("report-to")).toBe(false);
    }
  });

  it("lets the page reach only itself and the GitHub API by default", () => {
    const policy = buildContentSecurityPolicy({ nonce: NONCE, apiUrl: "/api/v1" });
    expect(directives(policy).get("connect-src")).toEqual(["'self'", "https://api.github.com"]);
  });

  it("adds eval and the HMR websocket in development", () => {
    const parsed = directives(buildContentSecurityPolicy({ nonce: NONCE, isDev: true }));
    expect(parsed.get("script-src")).toContain("'unsafe-eval'");
    expect(parsed.get("connect-src")).toContain("ws:");
  });

  it("allows an API on another origin, as in local development", () => {
    const policy = buildContentSecurityPolicy({
      nonce: NONCE,
      apiUrl: "http://localhost:8000/api/v1",
    });
    expect(directives(policy).get("connect-src")).toContain("http://localhost:8000");
  });

  it("allows the configured app URL, which the auth client calls even when the page is reached by another name", () => {
    const policy = buildContentSecurityPolicy({
      nonce: NONCE,
      appUrl: "https://traceroot.internal.example.com",
    });
    expect(directives(policy).get("connect-src")).toContain(
      "https://traceroot.internal.example.com",
    );
  });

  it("allows PostHog Cloud's ingestion and assets hosts when analytics is configured", () => {
    const policy = buildContentSecurityPolicy({
      nonce: NONCE,
      posthogKey: "phc_test",
      posthogHost: "https://us.i.posthog.com",
    });
    expect(directives(policy).get("connect-src")).toEqual([
      "'self'",
      "https://api.github.com",
      "https://us.i.posthog.com",
      "https://us-assets.i.posthog.com",
    ]);
  });

  it("allows only the proxy host when PostHog sits behind a reverse proxy", () => {
    const policy = buildContentSecurityPolicy({
      nonce: NONCE,
      posthogKey: "phc_test",
      posthogHost: "https://e.traceroot.ai",
    });
    expect(directives(policy).get("connect-src")).toEqual([
      "'self'",
      "https://api.github.com",
      "https://e.traceroot.ai",
    ]);
  });

  it("leaves PostHog out when no key is set, since analytics then never starts", () => {
    const policy = buildContentSecurityPolicy({
      nonce: NONCE,
      posthogKey: "",
      posthogHost: "https://us.i.posthog.com",
    });
    expect(directives(policy).get("connect-src")).not.toContain("https://us.i.posthog.com");
  });
});

describe("cspHeaderName", () => {
  it("enforces by default and reports only when asked", () => {
    expect(cspHeaderName(undefined)).toBe("Content-Security-Policy");
    expect(cspHeaderName("enforce")).toBe("Content-Security-Policy");
    expect(cspHeaderName("report-only")).toBe("Content-Security-Policy-Report-Only");
  });
});
