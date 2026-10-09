import { describe, expect, it } from "vitest";
// Next.js finds the nonce for its own scripts by parsing the request's policy
// with this helper, so the test checks the policy the way Next.js reads it.
import { getScriptNonceFromHeader } from "next/dist/server/app-render/get-script-nonce-from-header";

import { buildContentSecurityPolicy, cspHeaderName, CSP_REPORT_PATH } from "./csp";

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
