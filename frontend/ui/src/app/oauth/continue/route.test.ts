import { describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { GET } from "./route";

// The query is the provider's signed authorization request, passed back untouched.
const QUERY = "?response_type=code&client_id=c1&exp=1&sig=abc%2Bdef%3D";

function requestFor(url: string) {
  return { url, nextUrl: new URL(url) } as unknown as NextRequest;
}

describe("GET /oauth/continue", () => {
  it("hands the signed authorization request back to the provider", () => {
    const response = GET(requestFor(`http://localhost:3000/oauth/continue${QUERY}`));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`/api/auth/oauth2/authorize${QUERY}`);
  });

  it("does not depend on the host the server thinks it has", () => {
    // Inside a container the request URL can name the bound address; the redirect
    // must not carry it, or the browser leaves the host its session cookie is for.
    const location = GET(requestFor(`http://0.0.0.0:3000/oauth/continue${QUERY}`)).headers.get(
      "location",
    );

    expect(location).not.toContain("0.0.0.0");
    expect(location?.startsWith("/")).toBe(true);
  });

  it("only ever goes to the authorize endpoint", () => {
    const location = GET(
      requestFor("http://localhost:3000/oauth/continue?redirect=https://evil.example"),
    ).headers.get("location");

    expect(location?.startsWith("/api/auth/oauth2/authorize?")).toBe(true);
  });
});
