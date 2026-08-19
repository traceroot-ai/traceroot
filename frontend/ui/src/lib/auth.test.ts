import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  betterAuth: vi.fn((config: unknown) => ({ config })),
  prismaAdapter: vi.fn(() => "prisma-adapter"),
  admin: vi.fn(() => "admin-plugin"),
  socialProviders: {
    google: { clientId: "google-id", clientSecret: "google-secret" },
    github: { clientId: "github-id", clientSecret: "github-secret" },
  },
}));

vi.mock("better-auth", () => ({
  betterAuth: (...args: unknown[]) => mocks.betterAuth(...args),
}));

vi.mock("better-auth/adapters/prisma", () => ({
  prismaAdapter: (...args: unknown[]) => mocks.prismaAdapter(...args),
}));

vi.mock("better-auth/plugins", () => ({
  admin: (...args: unknown[]) => mocks.admin(...args),
}));

vi.mock("@traceroot/core", () => ({
  prisma: { marker: "prisma-client" },
}));

vi.mock("@/env", () => ({
  env: {
    BETTER_AUTH_SECRET: "secret",
    BETTER_AUTH_URL: "http://localhost:3000",
  },
}));

vi.mock("@/lib/social-auth", () => ({
  getSocialAuthConfig: () => ({ socialProviders: mocks.socialProviders }),
}));

import { auth } from "./auth";

describe("auth config", () => {
  it("passes configured social providers into Better Auth", () => {
    expect(auth).toEqual({
      config: expect.objectContaining({
        socialProviders: mocks.socialProviders,
      }),
    });
    expect(mocks.betterAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        database: "prisma-adapter",
        socialProviders: mocks.socialProviders,
        account: {
          accountLinking: {
            enabled: true,
            trustedProviders: ["google", "github"],
          },
        },
      }),
    );
  });
});
