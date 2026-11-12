import { defineConfig } from "@playwright/test";
import config from "./playwright.config";

const databaseURL = process.env.DATABASE_URL;
const database = URL.parse(databaseURL ?? "");
if (!database || !["localhost", "127.0.0.1"].includes(database.hostname)) {
  throw new Error("Signup E2E requires a local DATABASE_URL");
}

const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig(config, {
  testIgnore: [],
  testMatch: "**/signup-hardening.spec.ts",
  use: { baseURL },
  webServer: {
    command: `pnpm dev --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/api/auth/ok`,
    reuseExistingServer: false,
    env: {
      BETTER_AUTH_URL: baseURL,
      NEXT_PUBLIC_APP_URL: baseURL,
      TRACEROOT_SIGNUP_SLACK_WEBHOOK_URL: "",
      RESEND_API_KEY: "",
      NEXT_PUBLIC_POSTHOG_KEY: "",
    },
  },
});
