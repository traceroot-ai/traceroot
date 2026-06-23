import { describe, expect, it, vi, afterEach } from "vitest";

async function loadSocialAuth(env: Record<string, string>) {
  vi.resetModules();
  vi.doMock("@/env", () => ({ env }));
  return import("./social-auth");
}

afterEach(() => {
  vi.doUnmock("@/env");
});

describe("getSocialAuthConfig", () => {
  it("enables only providers with both client id and secret", async () => {
    const { getSocialAuthConfig } = await loadSocialAuth({
      AUTH_GOOGLE_CLIENT_ID: "google-id",
      AUTH_GOOGLE_CLIENT_SECRET: "google-secret",
      AUTH_GITHUB_CLIENT_ID: "github-id",
      AUTH_GITHUB_CLIENT_SECRET: "",
    });

    expect(getSocialAuthConfig()).toEqual({
      enabledProviders: { google: true, github: false },
      socialProviders: {
        google: {
          clientId: "google-id",
          clientSecret: "google-secret",
        },
      },
    });
  });

  it("trims credentials when deciding whether a provider is configured", async () => {
    const { getSocialAuthConfig } = await loadSocialAuth({
      AUTH_GOOGLE_CLIENT_ID: "   ",
      AUTH_GOOGLE_CLIENT_SECRET: "google-secret",
      AUTH_GITHUB_CLIENT_ID: "github-id",
      AUTH_GITHUB_CLIENT_SECRET: "github-secret",
    });

    expect(getSocialAuthConfig()).toEqual({
      enabledProviders: { google: false, github: true },
      socialProviders: {
        github: {
          clientId: "github-id",
          clientSecret: "github-secret",
        },
      },
    });
  });

  it("returns no providers when no social credentials are configured", async () => {
    const { getSocialAuthConfig } = await loadSocialAuth({
      AUTH_GOOGLE_CLIENT_ID: "",
      AUTH_GOOGLE_CLIENT_SECRET: "",
      AUTH_GITHUB_CLIENT_ID: "",
      AUTH_GITHUB_CLIENT_SECRET: "",
    });

    expect(getSocialAuthConfig()).toEqual({
      enabledProviders: { google: false, github: false },
      socialProviders: {},
    });
  });
});
