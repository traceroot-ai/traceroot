import { z } from "zod";

const clientSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().default("/api/v1"),
  NEXT_PUBLIC_DOCS_URL: z.string().default("https://docs.traceroot.ai"),
  NEXT_PUBLIC_GITHUB_REPO_URL: z.string().default("https://github.com/traceroot-ai/traceroot"),
  NEXT_PUBLIC_GITHUB_ISSUES_URL: z
    .string()
    .default("https://github.com/traceroot-ai/traceroot/issues"),
  NEXT_PUBLIC_DISCORD_INVITE_URL: z.string().default("https://discord.com/invite/tPyffEZvvJ"),
});

export const clientEnv = clientSchema.parse({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_DOCS_URL: process.env.NEXT_PUBLIC_DOCS_URL,
  NEXT_PUBLIC_GITHUB_REPO_URL: process.env.NEXT_PUBLIC_GITHUB_REPO_URL,
  NEXT_PUBLIC_GITHUB_ISSUES_URL: process.env.NEXT_PUBLIC_GITHUB_ISSUES_URL,
  NEXT_PUBLIC_DISCORD_INVITE_URL: process.env.NEXT_PUBLIC_DISCORD_INVITE_URL,
});
