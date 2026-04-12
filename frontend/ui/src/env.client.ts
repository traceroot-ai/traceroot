import { z } from "zod";

const clientSchema = z.object({
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().optional(),
  NEXT_PUBLIC_API_URL: z.string().default("/api/v1"),
  NEXT_PUBLIC_DOCS_URL: z
    .string()
    .default(
      process.env.NODE_ENV === "development"
        ? "http://localhost:3005"
        : "https://traceroot.ai/docs",
    ),
  NEXT_PUBLIC_GITHUB_REPO_URL: z.string().default("https://github.com/traceroot-ai/traceroot"),
  NEXT_PUBLIC_GITHUB_ISSUES_URL: z
    .string()
    .default("https://github.com/traceroot-ai/traceroot/issues"),
  NEXT_PUBLIC_DISCORD_INVITE_URL: z.string().default("https://discord.gg/TM2m3CtKuC"),
  NEXT_PUBLIC_FOUNDERS_CAL_URL: z.string().default("https://cal.com/traceroot/30min"),
});

export const clientEnv = clientSchema.parse({
  NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
  NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_DOCS_URL:
    process.env.NODE_ENV === "development"
      ? "http://localhost:3005"
      : process.env.NEXT_PUBLIC_DOCS_URL,
  NEXT_PUBLIC_GITHUB_REPO_URL: process.env.NEXT_PUBLIC_GITHUB_REPO_URL,
  NEXT_PUBLIC_GITHUB_ISSUES_URL: process.env.NEXT_PUBLIC_GITHUB_ISSUES_URL,
  NEXT_PUBLIC_DISCORD_INVITE_URL: process.env.NEXT_PUBLIC_DISCORD_INVITE_URL,
  NEXT_PUBLIC_FOUNDERS_CAL_URL: process.env.NEXT_PUBLIC_FOUNDERS_CAL_URL,
});
