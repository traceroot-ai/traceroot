import { describe, expect, it } from "vitest";
import { configuredSocialProviders, socialProviderOptions } from "./social-providers";

const NONE = {
  AUTH_GITHUB_CLIENT_ID: "",
  AUTH_GITHUB_CLIENT_SECRET: "",
  AUTH_GOOGLE_CLIENT_ID: "",
  AUTH_GOOGLE_CLIENT_SECRET: "",
  AUTH_AGENTID_CLIENT_ID: "",
  AUTH_AGENTID_CLIENT_SECRET: "",
};

describe("social providers", () => {
  it("enables only providers with both client id and secret", () => {
    const env = {
      ...NONE,
      AUTH_GOOGLE_CLIENT_ID: "google-id",
      AUTH_GOOGLE_CLIENT_SECRET: "google-secret",
      AUTH_GITHUB_CLIENT_ID: "github-id",
    };
    expect(configuredSocialProviders(env)).toEqual(["google"]);
    expect(socialProviderOptions(env)).toEqual({
      google: { clientId: "google-id", clientSecret: "google-secret" },
    });
  });

  it("trims credentials before enabling and passing providers to Better Auth", () => {
    const env = {
      ...NONE,
      AUTH_GOOGLE_CLIENT_ID: "   ",
      AUTH_GOOGLE_CLIENT_SECRET: "google-secret",
      AUTH_GITHUB_CLIENT_ID: " github-id ",
      AUTH_GITHUB_CLIENT_SECRET: "\ngithub-secret\t",
    };
    expect(configuredSocialProviders(env)).toEqual(["github"]);
    expect(socialProviderOptions(env)).toEqual({
      github: { clientId: "github-id", clientSecret: "github-secret" },
    });
  });

  it("returns no providers when no social credentials are configured", () => {
    expect(configuredSocialProviders(NONE)).toEqual([]);
    expect(socialProviderOptions(NONE)).toEqual({});
  });

  it("lists GitHub first, then Google, then AgentID, which is not a built-in provider", () => {
    const all = {
      AUTH_GITHUB_CLIENT_ID: "g",
      AUTH_GITHUB_CLIENT_SECRET: "g",
      AUTH_GOOGLE_CLIENT_ID: "o",
      AUTH_GOOGLE_CLIENT_SECRET: "o",
      AUTH_AGENTID_CLIENT_ID: "a",
      AUTH_AGENTID_CLIENT_SECRET: "a",
    };
    expect(configuredSocialProviders(all)).toEqual(["github", "google", "agentid"]);
    expect(Object.keys(socialProviderOptions(all))).toEqual(["github", "google"]);
  });
});
